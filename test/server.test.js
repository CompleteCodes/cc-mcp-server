import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Integration tests: spawn the MCP server as a child process, talk JSON-RPC
// over stdio exactly like an agent runtime does. Catches regressions in tool
// registration, argument schemas, offline math, and auth-error surface — all
// without hitting the live API (authenticated tools short-circuit on missing
// CC_API_TOKEN before any fetch).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "index.js");

/** Spawn one MCP server per test file, do the initialize handshake, yield a
 *  `call(name, args)` helper that sends requests and resolves with the parsed
 *  JSON-RPC response. */
function bootServer(env = {}) {
  const proc = spawn("node", [SERVER_PATH], {
    env: { ...process.env, ...env, CC_API_TOKEN: env.CC_API_TOKEN ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const pending = new Map();
  let nextId = 1;

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolvePromise, reject) => {
      pending.set(id, resolvePromise);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      // Defensive timeout — a real test run should complete in < 1s per call.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}(id=${id})`));
        }
      }, 5000);
    });
  }

  return {
    init: () => request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    }),
    list: () => request("tools/list", {}),
    call: (name, args = {}) => request("tools/call", { name, arguments: args }),
    close: () => { proc.kill("SIGTERM"); },
  };
}

/** Extract the text payload from a tools/call response (or throw). */
function textOf(resp) {
  if (resp.error) throw new Error(`RPC error: ${JSON.stringify(resp.error)}`);
  return resp.result?.content?.[0]?.text ?? "";
}

describe("MCP server boots cleanly", () => {
  let server;
  beforeAll(async () => {
    server = bootServer();
    await server.init();
  });
  afterAll(() => server?.close());

  test("initialize reports the expected server name + version", async () => {
    const resp = await server.init();
    expect(resp.result.serverInfo.name).toBe("complete-codes");
    expect(resp.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("tools/list registers exactly the expected tool set", async () => {
    const resp = await server.list();
    const names = resp.result.tools.map((t) => t.name).sort();
    // Pinning the full set catches accidental additions/removals. If you're
    // intentionally adding or removing a tool, update this list in the same PR.
    expect(names).toEqual([
      "calculate_platform_fee",
      "cancel_sprint",
      "create_free_sprint",
      "create_sprint",
      "fund_sprint",
      "get_contributor_merge_rate",
      "get_my_earnings",
      "get_my_earnings_summary",
      "get_sprint_details",
      "get_sprint_for_repo",
      "list_funded_repos",
      "suggest_slider_rate",
      "update_sprint",
    ]);
  });
});

describe("calculate_platform_fee matches the canonical pricing table", () => {
  // These values MIRROR app/src/config/paymentMethods.ts. If the canonical
  // file changes, this test fails — treat the failure as a prompt to either
  // update this test AND index.js together, or to refactor so the MCP server
  // reads the config from a shared source.
  let server;
  beforeAll(async () => {
    server = bootServer();
    await server.init();
  });
  afterAll(() => server?.close());

  test.each([
    { budget: 500, method: "crypto", expectFee: 25, expectLabel: "Crypto (USDC)" },
    { budget: 20,  method: "stripe", expectFee: 3,  expectLabel: "Card (Stripe)" },
    { budget: 100, method: "stripe", expectFee: 10, expectLabel: "Card (Stripe)" },
    { budget: 100, method: "crypto", expectFee: 5,  expectLabel: "Crypto (USDC)" },
    { budget: 500, method: "ach",    expectFee: 25, expectLabel: "ACH (USD)" },
    { budget: 500, method: "wire",   expectFee: 25, expectLabel: "Wire (USD)" },
    { budget: 500, method: "sepa",   expectFee: 25, expectLabel: "SEPA (EUR)" },
  ])("budget=$$budget $method => fee=$$expectFee", async ({ budget, method, expectFee, expectLabel }) => {
    const resp = await server.call("calculate_platform_fee", { budget, method });
    const txt = textOf(resp);
    expect(txt).toContain(expectLabel);
    expect(txt).toContain(`Platform fee: $${expectFee.toFixed(2)}`);
  });

  test("crypto minFee floor kicks in for tiny budgets", async () => {
    const resp = await server.call("calculate_platform_fee", { budget: 0.1, method: "crypto" });
    const txt = textOf(resp);
    // 0.1 * 0.05 = 0.005, below minFee of $0.05, so floor applies.
    expect(txt).toContain("Platform fee: $0.05");
  });

  test("validation fires when budget is below the method minimum", async () => {
    const resp = await server.call("calculate_platform_fee", { budget: 0.5, method: "crypto" });
    const txt = textOf(resp);
    expect(txt).toMatch(/below the Crypto \(USDC\) minimum of \$1/);
  });

  test("validation fires when budget exceeds the method maximum", async () => {
    const resp = await server.call("calculate_platform_fee", { budget: 10000, method: "stripe" });
    const txt = textOf(resp);
    expect(txt).toMatch(/exceeds the Card \(Stripe\) maximum of \$2500/);
  });
});

describe("suggest_slider_rate tracks the app's autoSliderRate / presetSliderRate", () => {
  let server;
  beforeAll(async () => {
    server = bootServer();
    await server.init();
  });
  afterAll(() => server?.close());

  // Expected values computed from the same formulas in app/src/utils/sprint.ts.
  // `r = 1 - 0.2^(1/targetMerges)`, with per-preset buckets.
  test.each([
    // balanced → autoSliderRate
    { budget: 100,   preset: "balanced", expectRate: 0.0214 }, // targetMerges=75
    { budget: 500,   preset: "balanced", expectRate: 0.016 },  // targetMerges=100
    { budget: 2000,  preset: "balanced", expectRate: 0.0107 }, // targetMerges=150
    // budget → many small payouts
    { budget: 100,   preset: "budget",   expectRate: 0.0107 }, // t=150
    { budget: 500,   preset: "budget",   expectRate: 0.0064 }, // t=250
    // generous → fewer, larger payouts
    { budget: 100,   preset: "generous", expectRate: 0.03 },   // t=40, clamped to 0.03 max
    { budget: 500,   preset: "generous", expectRate: 0.0265 }, // t=60
  ])("budget=$$budget preset=$preset => rate≈$expectRate", async ({ budget, preset, expectRate }) => {
    const resp = await server.call("suggest_slider_rate", { budget, preset });
    const txt = textOf(resp);
    // Extract the numeric slider_rate from the response text.
    const m = txt.match(/slider_rate:\s*([0-9.]+)/);
    expect(m).not.toBeNull();
    const actual = parseFloat(m[1]);
    // Allow ±0.0001 slack for rounding boundary nudges.
    expect(Math.abs(actual - expectRate)).toBeLessThan(0.0002);
  });
});

describe("authenticated tools surface an actionable error without CC_API_TOKEN", () => {
  let server;
  beforeAll(async () => {
    server = bootServer({ CC_API_TOKEN: "" }); // explicitly empty
    await server.init();
  });
  afterAll(() => server?.close());

  // Every authenticated tool must return the `CC_API_TOKEN is not set` error
  // BEFORE attempting a network call. This is the contract the README and the
  // www.complete.codes /agents page document. Do not weaken it.
  test.each([
    { name: "create_free_sprint", args: { repository_url: "https://github.com/a/b", chain_id: 8453 } },
    { name: "create_sprint",      args: { repository_url: "https://github.com/a/b", branch: "main", budget: 100, duration_days: 7, slider_rate: 0.02, chain_id: 8453 } },
    { name: "update_sprint",      args: { sprint_id: "deadbeefdeadbeefdeadbeef", slider_rate: 0.02 } },
    { name: "cancel_sprint",      args: { sprint_id: "deadbeefdeadbeefdeadbeef" } },
    { name: "fund_sprint",        args: { sprint_id: "deadbeefdeadbeefdeadbeef", unit_amount: 1000, unit_amount_after_fees: 900 } },
    { name: "get_my_earnings",    args: {} },
    { name: "get_my_earnings_summary", args: {} },
  ])("$name → CC_API_TOKEN error", async ({ name, args }) => {
    const resp = await server.call(name, args);
    expect(resp.result.isError).toBe(true);
    const txt = resp.result.content[0].text;
    expect(txt).toMatch(/CC_API_TOKEN is not set/);
    expect(txt).toMatch(/app\.complete\.codes/);
  });
});
