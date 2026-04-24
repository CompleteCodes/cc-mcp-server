#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.CC_API_URL || "https://api.complete.codes/prod";
const API_TOKEN = process.env.CC_API_TOKEN; // Web3Auth JWT (Bearer). Optional for read-only tools, required for write/authenticated tools.

function authHeaders() {
  if (!API_TOKEN) return {};
  return { Authorization: `Bearer ${API_TOKEN}` };
}

function requireToken() {
  if (!API_TOKEN) {
    throw new Error(
      "CC_API_TOKEN is not set. This tool requires authentication. " +
      "Obtain a token by signing in at https://app.complete.codes (DevTools → Application → Local Storage → copy `id_token`) " +
      "and set it in your MCP config: { \"env\": { \"CC_API_TOKEN\": \"<token>\" } }. " +
      "The token is a Web3Auth JWT tied to your GitHub account; it expires every ~24h."
    );
  }
}

async function apiGet(path, params = {}, { authenticated = false } = {}) {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  if (authenticated) requireToken();
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

async function apiJson(method, path, body = {}) {
  requireToken();
  const url = new URL(path, API_BASE);
  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const msg = parsed?.message || parsed?.error || text;
    if (res.status === 401) {
      throw new Error(`Authentication failed (401). Your CC_API_TOKEN is missing, expired, or invalid. Sign in at https://app.complete.codes and copy a fresh id_token. Original error: ${msg}`);
    }
    throw new Error(`API ${res.status}: ${msg}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "complete-codes",
  version: "1.1.0",
});

// ============================================================================
// READ TOOLS (public — no token needed)
// ============================================================================

server.tool(
  "list_funded_repos",
  "Discover GitHub repositories with active funding sprints. Returns repos where AI agents can earn USDC by submitting merged PRs.",
  {
    language: z.string().optional().describe("Filter by programming language (e.g. TypeScript, Python, Rust)"),
    min_payout: z.number().optional().describe("Minimum payout per merge in USD"),
    sort: z.enum(["payout", "newest", "ending", "active"]).optional().describe("Sort order: payout (highest first), newest, ending (soonest first), active (most merges)"),
    limit: z.number().optional().describe("Max results to return (default 20, max 100)"),
    min_merge_rate: z.number().min(0).max(1).optional().describe("Reserved: minimum past merge rate (0 to 1) an agent must have to be shown a sprint. Forward-compatible — passed to the REST API, which currently ignores it; server-side filtering lands later."),
    min_past_merges: z.number().int().min(0).optional().describe("Reserved: minimum prior-merge count an agent must have to be shown a sprint. Same forward-compatibility caveat as min_merge_rate."),
  },
  async ({ language, min_payout, sort, limit, min_merge_rate, min_past_merges }) => {
    const data = await apiGet("/v1/sprints", {
      status: "active",
      language,
      min_payout,
      sort: sort || "payout",
      limit: limit || 20,
      min_merge_rate,
      min_past_merges,
    });

    const sprints = data.sprints || [];
    if (sprints.length === 0) {
      return { content: [{ type: "text", text: "No active sprints found matching your criteria." }] };
    }

    const lines = sprints.map((s) => {
      const payout = `~$${s.next_payout?.toFixed(2) || "?"}`;
      const pool = `$${s.current_pool?.toFixed(2) || "?"}`;
      return `${s._id}  ${s.repository_owner}/${s.repository_name} (${s.repository_language || "?"}) — ${payout}/merge, pool: ${pool}, slider: ${((s.slider_rate || 0) * 100).toFixed(0)}%`;
    });

    return {
      content: [{
        type: "text",
        text: `Found ${data.totalRecords} active sprint${data.totalRecords !== 1 ? "s" : ""}:\n\n${lines.join("\n")}`,
      }],
    };
  }
);

server.tool(
  "get_contributor_merge_rate",
  "Look up a GitHub contributor's public merge rate on Complete Codes: merges ÷ submissions across all sprints, plus breadth (distinct repos, distinct funders). Useful for agent operators deciding whether a sprint is worth competing on, and for contributors checking their own public record.",
  {
    username: z.string().describe("GitHub username (e.g. 'octocat'). Case-insensitive; no leading '@'."),
  },
  async ({ username }) => {
    try {
      const card = await apiGet(`/v1/contributor/${encodeURIComponent(username)}`);

      if (card.new_contributor) {
        const gh = card.github;
        const ghLine = gh
          ? `GitHub: account ${gh.account_age_years ?? "?"}y, ${gh.followers ?? "?"} followers, ${gh.public_repos ?? "?"} public repos.`
          : "GitHub account metadata unavailable.";
        return {
          content: [{
            type: "text",
            text: `@${card.github_username} — first PR on Complete Codes.\n${ghLine}`,
          }],
        };
      }

      const ratePct = card.merge_rate !== null ? `${Math.round(card.merge_rate * 100)}%` : "—";
      const text = [
        `@${card.github_username} — ${card.merged}/${card.submitted} merged (${ratePct})`,
        `Breadth: ${card.distinct_repos} repo${card.distinct_repos === 1 ? "" : "s"} · ${card.distinct_funders} funder${card.distinct_funders === 1 ? "" : "s"}`,
        `Earned: $${(card.total_earned_usdc || 0).toFixed(2)} USDC`,
        `Active: ${card.first_seen_at?.slice(0, 10) || "?"} → ${card.last_active_at?.slice(0, 10) || "?"}`,
        card.languages?.length ? `Languages: ${card.languages.join(", ")}` : null,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Could not look up @${username}: ${err.message}`,
        }],
      };
    }
  }
);

server.tool(
  "get_sprint_details",
  "Get detailed information about a specific funding sprint including pool balance, payout rate, merge history, and time remaining.",
  {
    sprint_id: z.string().describe("The sprint ID to look up"),
  },
  async ({ sprint_id }) => {
    const sprint = await apiGet("/v1/sprint", { sprint_id });

    const daysLeft = sprint.end_date
      ? Math.max(0, Math.ceil((new Date(sprint.end_date).getTime() - Date.now()) / 86400000))
      : null;
    const text = [
      `Sprint: ${sprint.repository_owner}/${sprint.repository_name} (${sprint.branch || "main"})`,
      `_id: ${sprint._id}`,
      `Status: ${sprint.status}`,
      `Pool: $${(sprint.current_pool || 0).toFixed(2)} / $${(sprint.initial_pool || 0).toFixed(2)} initial · budget: $${sprint.budget || 0}`,
      `Next payout: ~$${(sprint.next_payout || 0).toFixed(2)} per merge`,
      `Slider: ${((sprint.slider_rate || 0) * 100).toFixed(2)}%`,
      `Merges: ${sprint.total_merges || 0} (total paid: $${(sprint.total_paid || 0).toFixed(2)})`,
      daysLeft !== null ? `Time remaining: ${daysLeft} day${daysLeft !== 1 ? "s" : ""}` : "Not yet activated (no end date set)",
      `Participation: ${sprint.participation_mode || "open"}`,
      `Mode: ${sprint.sprint_mode || "reactive"} (${(sprint.proactive_options || []).join(", ") || "open_issues"})`,
      `Auto-renew: ${sprint.auto_renew ? "yes" : "no"}`,
      sprint.smart_account_address ? `Funding address: ${sprint.smart_account_address} (chain_id ${sprint.chain_id || "?"})` : null,
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "get_sprint_for_repo",
  "Find the active funding sprint for a specific GitHub repository. Use this to check if a repo has money available for merged PRs.",
  {
    owner: z.string().describe("GitHub repository owner (e.g. 'acme')"),
    repo: z.string().describe("GitHub repository name (e.g. 'agent-runtime')"),
  },
  async ({ owner, repo }) => {
    try {
      const sprint = await apiGet("/v1/repos/sprint", { owner, repo });
      const payout = `~$${sprint.next_payout?.toFixed(2) || "?"}`;
      const pool = `$${sprint.current_pool?.toFixed(2) || "?"}`;
      return {
        content: [{
          type: "text",
          text: `Active sprint found for ${owner}/${repo}:\n_id: ${sprint._id}\nPayout: ${payout}/merge, Pool: ${pool}, Branch: ${sprint.branch || "main"}, Slider: ${((sprint.slider_rate || 0) * 100).toFixed(0)}%`,
        }],
      };
    } catch {
      return { content: [{ type: "text", text: `No active sprint found for ${owner}/${repo}.` }] };
    }
  }
);

// ============================================================================
// AUTHENTICATED READ TOOLS
// ============================================================================

server.tool(
  "get_my_earnings",
  "List the authenticated user's earnings across all sprints. Requires CC_API_TOKEN.",
  {
    status: z.enum(["pending", "processing", "awaiting_wallet", "paid"]).optional().describe("Filter by earning status"),
    page: z.number().int().min(1).optional().describe("Page number (default 1)"),
    limit: z.number().int().min(1).max(100).optional().describe("Results per page (default 20, max 100)"),
  },
  async ({ status, page, limit }) => {
    const data = await apiGet("/v1/earnings", {
      status,
      page: page || 1,
      limit: limit || 20,
    }, { authenticated: true });

    const earnings = data.earnings || [];
    if (earnings.length === 0) {
      return { content: [{ type: "text", text: "No earnings found." }] };
    }

    const lines = earnings.map((e) => {
      const when = e.paid_at ? ` (paid ${e.paid_at.slice(0, 10)})` : e.created_at ? ` (recorded ${e.created_at.slice(0, 10)})` : "";
      return `$${(e.amount || 0).toFixed(2)} USDC · ${e.status} · ${e.type} · ${e.repository || "?"} PR #${e.pr_number || "?"}${when}`;
    });

    return {
      content: [{
        type: "text",
        text: `${data.totalRecords} earning${data.totalRecords !== 1 ? "s" : ""} (page ${data.page}/${data.totalPages}):\n\n${lines.join("\n")}`,
      }],
    };
  }
);

server.tool(
  "get_my_earnings_summary",
  "Return the authenticated user's lifetime earnings summary: available, pending, and all-time totals. Requires CC_API_TOKEN.",
  {},
  async () => {
    const s = await apiGet("/v1/earnings/summary", {}, { authenticated: true });
    const text = [
      `Available: $${(s.available || 0).toFixed(2)}`,
      `Pending: $${(s.pending || 0).toFixed(2)}`,
      `All-time: $${(s.all_time || 0).toFixed(2)}`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ============================================================================
// WRITE TOOLS (require CC_API_TOKEN)
// ============================================================================

server.tool(
  "create_free_sprint",
  "Create a Free Sprint (no money involved, reputation-only) on a public GitHub repo you own or administer. Must have the Complete Codes GitHub App installed (or install it after — the sprint activates automatically when install is detected). Returns the new sprint record including `_id` and `smart_account_address` (used by the paid-convert flow later). Requires CC_API_TOKEN.",
  {
    repository_url: z.string().url().describe("Full GitHub URL of the repo, e.g. https://github.com/acme/agent-runtime"),
    branch: z.string().default("main").describe("Branch that merges count against (default: main)"),
    chain_id: z.number().int().positive().describe("Ethereum chain ID (e.g. 8453 for Base mainnet, 11155111 for Ethereum Sepolia on dev)"),
    repository_language: z.string().optional().describe("Primary language of the repo (free text, used for marketplace filtering)"),
    funder_address: z.string().optional().describe("Your wallet address (optional — derived from Web3Auth login if omitted)"),
  },
  async (args) => {
    const sprint = await apiJson("POST", "/v1/sprints", {
      ...args,
      sprint_free: true,
    });
    return {
      content: [{
        type: "text",
        text: [
          `Free sprint created: ${sprint.repository_owner}/${sprint.repository_name}`,
          `_id: ${sprint._id}`,
          `Status: ${sprint.status}${sprint.status === "funding" ? " (will flip to active when the Complete Codes GitHub App is installed on this repo)" : ""}`,
          `Marketplace: https://app.complete.codes/sprints/${sprint._id}`,
        ].join("\n"),
      }],
    };
  }
);

server.tool(
  "create_sprint",
  "Create a Funded Sprint (paid pool on a public GitHub repo). Sprint is created in 'funding' status with a zero pool — it flips to 'active' once you call `fund_sprint` and the payment arrives. Returns the new sprint including `_id` and `smart_account_address` (the crypto-funding deposit target). Requires CC_API_TOKEN.",
  {
    repository_url: z.string().url().describe("Full GitHub URL, e.g. https://github.com/acme/agent-runtime"),
    branch: z.string().default("main").describe("Branch that merges count against (default: main)"),
    budget: z.number().positive().describe("Sprint pool size in USD (>= $1). Validated against per-method limits — USDC: $1–$950; card: $20–$2,500; ACH/wire/SEPA: $50–$25,000."),
    duration_days: z.union([z.literal(7), z.literal(14), z.literal(30)]).describe("Sprint length. Must be 7, 14, or 30."),
    slider_rate: z.number().min(0.004).max(0.06).describe("Geometric depletion rate (payout = pool × rate per merge). 0.004 ≈ very low (many small payouts), 0.06 = high (few large payouts). Use calculate_slider_rate tool if unsure."),
    chain_id: z.number().int().positive().describe("Ethereum chain ID (8453 = Base mainnet, 11155111 = Ethereum Sepolia for dev)"),
    participation_mode: z.enum(["open", "closed"]).default("open").describe("open = anyone except blocklist; closed = allowlist only"),
    proactive_options: z.array(z.enum(["open_issues", "security", "bugs", "features"])).default(["open_issues"]).describe("Work scopes. ['open_issues'] only = Reactive sprint. Any other combination = Proactive sprint."),
    auto_renew: z.boolean().default(false).describe("If true and pool ≥ $5 at end, roll over into a new sprint automatically"),
    repository_language: z.string().optional().describe("Primary language — used for marketplace filtering"),
    funder_address: z.string().optional().describe("Your wallet address (derived from Web3Auth login if omitted)"),
  },
  async (args) => {
    const sprint = await apiJson("POST", "/v1/sprints", {
      ...args,
      sprint_free: false,
    });
    return {
      content: [{
        type: "text",
        text: [
          `Funded sprint created: ${sprint.repository_owner}/${sprint.repository_name}`,
          `_id: ${sprint._id}`,
          `Status: ${sprint.status} (awaiting funds; pool: $0 / budget: $${sprint.budget})`,
          `Slider: ${((sprint.slider_rate || 0) * 100).toFixed(2)}% · duration: ${sprint.duration_days}d · mode: ${sprint.sprint_mode}`,
          sprint.smart_account_address
            ? `Crypto deposit address: ${sprint.smart_account_address} (chain_id ${sprint.chain_id})`
            : "Smart-account address is being generated — poll get_sprint_details with this _id in ~10s to get the deposit target.",
          `Next step: call fund_sprint with sprint_id='${sprint._id}' to generate a Stripe payment link, OR send USDC directly to the smart-account address once it appears.`,
          `Dashboard: https://app.complete.codes/sprints/${sprint._id}`,
        ].join("\n"),
      }],
    };
  }
);

server.tool(
  "update_sprint",
  "Update a sprint you own. Only the following fields are mutable: slider_rate, auto_renew, participation_mode. Requires CC_API_TOKEN; only the sprint's funder can call this.",
  {
    sprint_id: z.string().describe("The sprint _id"),
    slider_rate: z.number().min(0.004).max(0.06).optional().describe("New geometric depletion rate"),
    auto_renew: z.boolean().optional(),
    participation_mode: z.enum(["open", "closed"]).optional(),
  },
  async ({ sprint_id, ...patch }) => {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(cleaned).length === 0) {
      throw new Error("Provide at least one of: slider_rate, auto_renew, participation_mode");
    }
    const sprint = await apiJson("PATCH", "/v1/sprint", { sprint_id, ...cleaned });
    const changes = Object.entries(cleaned).map(([k, v]) => `${k}=${v}`).join(", ");
    return {
      content: [{
        type: "text",
        text: `Sprint ${sprint._id} updated (${changes}). Current state: slider=${((sprint.slider_rate || 0) * 100).toFixed(2)}%, auto_renew=${sprint.auto_renew}, participation=${sprint.participation_mode}.`,
      }],
    };
  }
);

server.tool(
  "cancel_sprint",
  "Cancel an active or funding sprint you own. Remaining pool converts to service credit (not refunded — preserves our staffing-agency compliance model). Only the sprint's funder can cancel. Requires CC_API_TOKEN.",
  {
    sprint_id: z.string().describe("The sprint _id to cancel"),
  },
  async ({ sprint_id }) => {
    const result = await apiJson("POST", "/v1/sprint/cancel", { sprint_id });
    return {
      content: [{
        type: "text",
        text: result.message || `Sprint ${sprint_id} canceled.`,
      }],
    };
  }
);

server.tool(
  "fund_sprint",
  "Generate a Stripe payment link to fund a sprint (or add funds / convert a Free Sprint to Funded). Returns a URL the funder opens to pay by card or bank. For crypto (USDC) funding, skip this tool — send USDC directly to the sprint's `smart_account_address` returned by create_sprint / get_sprint_details. Requires CC_API_TOKEN.",
  {
    sprint_id: z.string().describe("The sprint _id to fund"),
    unit_amount: z.number().int().positive().describe("Amount in cents (e.g. 50000 for $500). This is the gross amount the funder pays; platform fee is deducted server-side."),
    unit_amount_after_fees: z.number().int().positive().describe("Net amount (cents) that lands in the pool after platform fee. Use calculate_platform_fee tool or the pricing table: card = 10% (min $3), USDC/ACH/wire/SEPA = 5% (USDC min $0.05, bank min $2)."),
    currency: z.string().default("usd").describe("ISO currency code (usd / eur)"),
    payment_methodtypes: z.array(z.string()).default(["card"]).describe("Stripe payment method types, e.g. ['card'], ['us_bank_account'], ['sepa_debit']"),
    add_funds: z.boolean().default(false).describe("Set true when topping up an existing active sprint, OR when converting a Free Sprint to Funded"),
    slider_rate: z.number().min(0.004).max(0.06).optional().describe("Required when add_funds=true AND the target sprint is a Free Sprint (converts it to Funded with this slider)"),
    verifier_id: z.string().optional().describe("Web3Auth verifier ID of the funder. Usually your GitHub username; auto-derived from the JWT if omitted."),
  },
  async (args) => {
    const result = await apiJson("POST", "/v1/sprint/fund", args);
    return {
      content: [{
        type: "text",
        text: [
          `Stripe payment link generated for sprint ${args.sprint_id}:`,
          result.stripe_payment_link_url,
          `Open the URL to complete payment. Sprint activates automatically when Stripe confirms the charge.`,
        ].join("\n"),
      }],
    };
  }
);

// ============================================================================
// HELPER / UTILITY TOOLS (no auth)
// ============================================================================

server.tool(
  "calculate_platform_fee",
  "Compute the platform fee for a sprint of a given size and payment method. Mirrors the canonical pricing in app/src/config/paymentMethods.ts. Use before fund_sprint to pick unit_amount / unit_amount_after_fees correctly.",
  {
    budget: z.number().positive().describe("Sprint pool size in USD (the amount devs see in the pool)"),
    method: z.enum(["stripe", "crypto", "ach", "wire", "sepa"]).default("stripe").describe("Payment rail. stripe = card (10%, min $3). crypto = USDC (5%, min $0.05). ach/wire/sepa = bank (5%, min $2)."),
  },
  async ({ budget, method }) => {
    const cfg = {
      stripe: { label: "Card (Stripe)", feeRate: 0.10, minFee: 3, minBudget: 20, maxBudget: 2500 },
      crypto: { label: "Crypto (USDC)", feeRate: 0.05, minFee: 0.05, minBudget: 1, maxBudget: 950 },
      ach:    { label: "ACH (USD)", feeRate: 0.05, minFee: 2, minBudget: 50, maxBudget: 25000 },
      wire:   { label: "Wire (USD)", feeRate: 0.05, minFee: 2, minBudget: 50, maxBudget: 25000 },
      sepa:   { label: "SEPA (EUR)", feeRate: 0.05, minFee: 2, minBudget: 50, maxBudget: 25000 },
    }[method];

    const fee = Math.max(cfg.minFee, Math.round(budget * cfg.feeRate * 100) / 100);
    const gross = Math.round((budget + fee) * 100) / 100;

    let validation = null;
    if (budget < cfg.minBudget) validation = `Budget $${budget} is below the ${cfg.label} minimum of $${cfg.minBudget}.`;
    else if (cfg.maxBudget && budget > cfg.maxBudget) validation = `Budget $${budget} exceeds the ${cfg.label} maximum of $${cfg.maxBudget}.`;

    return {
      content: [{
        type: "text",
        text: [
          `${cfg.label}`,
          `Pool (budget): $${budget.toFixed(2)}`,
          `Platform fee: $${fee.toFixed(2)}  (${(cfg.feeRate * 100).toFixed(0)}%, min $${cfg.minFee})`,
          `Gross charge: $${gross.toFixed(2)}`,
          "",
          `For fund_sprint call:`,
          `  unit_amount = ${Math.round(gross * 100)}   // cents, what funder pays`,
          `  unit_amount_after_fees = ${Math.round(budget * 100)}   // cents, what lands in the pool`,
          validation ? "" : null,
          validation,
        ].filter((x) => x !== null).join("\n"),
      }],
    };
  }
);

server.tool(
  "suggest_slider_rate",
  "Recommend a slider_rate for a given budget and payout preference. Returns the rate to pass to create_sprint. Matches the logic in app/src/utils/sprint.ts (presetSliderRate / autoSliderRate).",
  {
    budget: z.number().positive().describe("Sprint pool size in USD"),
    preset: z.enum(["budget", "balanced", "generous"]).default("balanced").describe("budget = many small payouts (~150-350 merges to 80% depletion); balanced = default; generous = fewer larger payouts (~40-90 merges)"),
  },
  async ({ budget, preset }) => {
    const autoRate = (b) => {
      const targetMerges = b <= 100 ? 75 : b <= 500 ? 100 : b <= 2000 ? 150 : b <= 10000 ? 200 : 250;
      const r = 1 - Math.pow(0.2, 1 / targetMerges);
      return Math.max(0.004, Math.min(0.03, Math.round(r * 10000) / 10000));
    };
    let rate;
    if (preset === "budget") {
      const t = budget <= 100 ? 150 : budget <= 1000 ? 250 : 350;
      rate = Math.max(0.004, Math.min(0.012, Math.round((1 - Math.pow(0.2, 1 / t)) * 10000) / 10000));
    } else if (preset === "generous") {
      const t = budget <= 100 ? 40 : budget <= 1000 ? 60 : 90;
      rate = Math.max(0.01, Math.min(0.03, Math.round((1 - Math.pow(0.2, 1 / t)) * 10000) / 10000));
    } else {
      rate = autoRate(budget);
    }

    const firstPayout = budget * rate;
    const mergesTo80 = Math.ceil(Math.log(0.2) / Math.log(1 - rate));

    return {
      content: [{
        type: "text",
        text: [
          `Preset: ${preset}`,
          `Budget: $${budget}`,
          `→ slider_rate: ${rate}   (${(rate * 100).toFixed(2)}%)`,
          `First-merge payout: ~$${firstPayout.toFixed(2)}`,
          `Merges to 80% pool depletion: ~${mergesTo80}`,
        ].join("\n"),
      }],
    };
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
