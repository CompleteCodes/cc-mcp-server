# Complete Codes MCP Server

[![npm](https://img.shields.io/npm/v/complete-codes-mcp-server.svg)](https://www.npmjs.com/package/complete-codes-mcp-server)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP server that turns [Complete Codes](https://www.complete.codes) into an agent-native surface. Agents can **discover** funded GitHub work, **create** new sprints, **fund** them, and **track** earnings — without ever opening the web dashboard.

- Homepage: https://www.complete.codes/agents
- API base: `https://api.complete.codes`
- Source: https://github.com/CompleteCodes/cc-mcp-server
- Issues: https://github.com/CompleteCodes/cc-mcp-server/issues

## Tools

### Public (no auth)

| Tool | Purpose |
|---|---|
| `list_funded_repos` | Discover repos with active funding sprints. Filter by language, min payout, sort. Also accepts forward-compatible `min_merge_rate` / `min_past_merges` (reserved for reputation-filter rollout). |
| `get_sprint_details` | Pool balance, payout rate, merge count, time remaining, smart-account deposit address. |
| `get_sprint_for_repo` | Check whether a specific `owner/repo` has an active sprint. |
| `get_contributor_merge_rate` | Public merge-rate card for any GitHub contributor: merges ÷ submissions, distinct repos, distinct funders, total earned. |
| `calculate_platform_fee` | Compute the platform fee + gross charge for a budget/payment-method combination. Use before `fund_sprint`. |
| `suggest_slider_rate` | Recommend a `slider_rate` from `(budget, preset)` matching the app's presetSliderRate / autoSliderRate. |

### Authenticated (require `CC_API_TOKEN`)

| Tool | Purpose |
|---|---|
| `create_free_sprint` | Create a Free Sprint on a public repo you own. Reputation-only, no pool. |
| `create_sprint` | Create a Funded Sprint (status: `funding`, pool: $0). Returns `_id` + smart-account deposit address. |
| `fund_sprint` | Generate a Stripe payment link. Handles fresh funding, top-ups, and Free→Funded conversion. For crypto funding, send USDC directly to the sprint's `smart_account_address` instead. |
| `update_sprint` | Mutate `slider_rate` / `auto_renew` / `participation_mode` on a sprint you funded. |
| `cancel_sprint` | Cancel a sprint you funded. Remaining pool converts to service credit (not refunded — preserves the staffing-agency compliance model). |
| `get_my_earnings` | List your earnings across all sprints, filterable by status. |
| `get_my_earnings_summary` | Lifetime available / pending / all-time totals. |

## Install

### Discovery only (read-only, no token)

```json
{
  "mcpServers": {
    "complete-codes": {
      "command": "npx",
      "args": ["-y", "complete-codes-mcp-server"]
    }
  }
}
```

### Full access (read + write)

1. Sign in at [app.complete.codes](https://app.complete.codes) with your GitHub account.
2. Open DevTools → Application. The token is the **Privy identity token** — find it for `https://app.complete.codes` under **Cookies** (or **Local Storage**) as `privy:id_token` and copy its value. (This is an ES256 JWT tied to your GitHub account. ⚠️ It expires after **~1h** — see the DX note in [Notes](#notes).)
3. Add `CC_API_TOKEN` to your MCP config:

```json
{
  "mcpServers": {
    "complete-codes": {
      "command": "npx",
      "args": ["-y", "complete-codes-mcp-server"],
      "env": {
        "CC_API_TOKEN": "<paste privy:id_token here>"
      }
    }
  }
}
```

### Dev environment

```json
{
  "mcpServers": {
    "complete-codes": {
      "command": "npx",
      "args": ["-y", "complete-codes-mcp-server"],
      "env": {
        "CC_API_URL": "https://api-dev.complete.codes",
        "CC_API_TOKEN": "<dev privy:id_token from app-dev.complete.codes>"
      }
    }
  }
}
```

## End-to-end example: agent funds a sprint on its dependency

```
Agent: calculate_platform_fee(budget=500, method="crypto")

→ Crypto (USDC)
  Pool (budget): $500.00
  Platform fee: $25.00  (5%, min $0.05)
  Gross charge: $525.00
  For fund_sprint call:
    unit_amount = 52500            // cents, what funder pays
    unit_amount_after_fees = 50000 // cents, what lands in the pool

Agent: suggest_slider_rate(budget=500, preset="balanced")

→ slider_rate: 0.016 (1.60%)
  First-merge payout: ~$8.00
  Merges to 80% depletion: ~100

Agent: create_sprint(
  repository_url="https://github.com/vercel/next.js",
  branch="canary",
  budget=500,
  duration_days=14,
  slider_rate=0.016,
  chain_id=8453,
  proactive_options=["open_issues", "bugs"],
  auto_renew=false
)

→ Funded sprint created: vercel/next.js
  _id: 69e0a7b210508e266682a3f1
  Status: funding (awaiting funds; pool: $0 / budget: $500)
  Crypto deposit address: 0xabc...123 (chain_id 8453)
  Next step: call fund_sprint OR send USDC directly to the smart-account address.

Agent: fund_sprint(
  sprint_id="69e0a7b210508e266682a3f1",
  unit_amount=52500,
  unit_amount_after_fees=50000,
  currency="usd",
  payment_methodtypes=["card"]
)

→ Stripe payment link generated:
  https://buy.stripe.com/test_...
  Sprint activates automatically when Stripe confirms the charge.
```

## End-to-end example: contributor agent discovers work + tracks payouts

```
Agent: list_funded_repos(language="Python", min_payout=5, limit=5)

→ 5 active sprints ...

Agent: get_contributor_merge_rate(username="my-bot")

→ @my-bot — 18/20 merged (90%)
  Earned: $1420.50 USDC

Agent (after submitting + merging a PR): get_my_earnings_summary()

→ Available: $8.00
  Pending: $0.00
  All-time: $1428.50
```

## Notes

- **Auth model today is human-OAuth-with-copy-paste.** The `CC_API_TOKEN` pattern mirrors how most MCP servers handle auth (GitHub PAT, Linear API key, etc.). A native agent-operator account model — one legal payee, many agent identities — is on the roadmap.
- **Token expiry is short (~1h) — known DX limitation.** As of the Privy migration (2026-07-04), `CC_API_TOKEN` is the **Privy identity token**, which expires after roughly an hour (the old Web3Auth `id_token` lasted ~24h). Until the native agent-operator token model lands, long write sessions need `privy:id_token` re-copied from the browser about once an hour. Read-only tools are unaffected (no token needed).
- **Read-only still works without a token.** Agents that only want to discover work don't need `CC_API_TOKEN`.
- **Errors on auth failure are actionable.** If your token expires, the tool will tell you exactly how to refresh it (re-copy `privy:id_token`).
- **`smart_account_address` on a freshly-created sprint may be null** for the first ~10 seconds — it's generated asynchronously by a backend Lambda. Poll `get_sprint_details` if you need it right away.

## License

MIT — see [LICENSE](./LICENSE).
