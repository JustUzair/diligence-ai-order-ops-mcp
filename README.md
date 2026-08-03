# order-ops-mcp

A remotely-hosted MCP server that lets an operations team diagnose and
resolve stuck orders — payment declines, fulfillment holds, incomplete
fulfillment, likely duplicates — without pulling in an engineer, by letting
an AI agent ask natural-language questions like *"why is order #4471
stuck?"* and act on the answer with explicit human confirmation.

## The workflow

```
list_order_exceptions   → what's broken right now
get_order_details       → why is this one broken (full timeline)
propose_resolution      → suggested fix + reasoning, nothing applied yet
confirm_resolution      → the only tool that actually changes anything
```

`simulate_new_failure` is a demo-only helper that injects a fresh broken
order, so the loop above can be shown working on something live rather than
only on pre-seeded data.

## Feature buckets

The implementation is intentionally divided around the assignment's highest-value behavior:

| Bucket | What is included | Main files |
| --- | --- | --- |
| 1. MCP contract and agent UX | Streamable HTTP endpoint, five tool registrations, LLM-oriented descriptions, structured outputs, and clear error responses | `src/server.ts`, `src/tools/order-tools.ts` |
| 2. Commerce diagnosis evidence | Synthetic orders, payment attempts, inventory allocations, fulfillment/carrier context, duplicate signals, ownership, priorities, and response SLAs | `src/data/types.ts`, `src/data/seed.ts`, `src/data/store.ts` |
| 3. Deterministic resolution playbook | Evidence-backed proposals for payment, inventory, fulfillment, duplicate, and unknown/fraud patterns | `src/data/playbook.ts` |
| 4. Safety and controlled mutation | Inert proposals, operator approval, one-time proposal use, audit timeline entries, allocation release, simulated refund, and active-queue resolution behavior | `src/data/store.ts`, `src/tools/order-tools.ts` |
| 5. Verification and delivery | Unit tests, live Streamable HTTP smoke test, local setup, Render deployment notes, and known tradeoffs | `test/`, `scripts/smoke-test.ts`, this README |

The core workflow is buckets 1–4. `simulate_new_failure` exists only to make
the workflow easy to demonstrate and would be removed or replaced by event
ingestion in a production integration.

## Data model

The process starts with a fixed Faker seed, so every restart restores a
recognizable demo dataset instead of producing a different presentation each
time. It contains 21 synthetic orders: 14 healthy controls and six active
exceptions (the remaining order is the healthy original in a duplicate pair).

The exception fixtures are deliberately varied but stay inside one workflow:

| Scenario | Diagnostic evidence | Proposed action |
| --- | --- | --- |
| Declined payment with stock held (two decline variants) | gateway attempt, decline/advice code, reserved units, SLA owner | release inventory and cancel |
| Inventory shortage | per-SKU requested/available quantity, location, delivery promise | notify customer of backorder |
| High-risk fraud hold | hold reason, audit timeline, urgent fraud-team ownership | escalate to a human; do not guess |
| Incomplete fulfillment | carrier, retry count, last error, promised dates | retry fulfillment |
| Likely duplicate | matched order, confidence, four matching signals | cancel, refund, and release stock |

Every order also carries synthetic customer history, channel, coarse shipping
destination, payment attempts, inventory allocations, fulfillment/carrier
context, delivery promises, operational priority, response SLA, and a timeline.
`list_order_exceptions` returns compact triage metadata; `get_order_details`
returns the full evidence only for the selected order.

Order state and failure reasons mirror public commerce vocabulary rather than
inventing platform-specific claims:

- `CancelReason`: `CUSTOMER | DECLINED | FRAUD | INVENTORY | STAFF | OTHER`
  — Shopify's published
  [`OrderCancelReason`](https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderCancelReason)
  enum.
- Fulfillment hold `reason` (for example `inventory_out_of_stock` and
  `high_risk_of_fraud`) and notes mirror Shopify's published
  [`FulfillmentHoldReason`](https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentHoldReason)
  and [`FulfillmentHold`](https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentHold)
  shapes.
- `fulfillmentStatus: "incomplete"` mirrors the real state Shopify uses when
  a fulfillment service accepts an order and then fails to complete it.
- Decline examples such as `insufficient_funds` and `do_not_honor`, plus
  caller-oriented advice, are based on Stripe's public
  [decline-code guidance](https://docs.stripe.com/declines/codes).

All data is synthetic, generated in-process with `@faker-js/faker` on
startup (`src/data/seed.ts`) — no real customer data, no production
credentials, no live platform integration anywhere in this repo.

## Setup

Requires Node ≥ 20.

```bash
npm install
npm run dev
# → [order-ops-mcp] listening on :3000 (POST /mcp, GET /health)
```

Point an MCP client (Claude Code, the MCP Inspector, etc.) at
`http://localhost:3000/mcp` (Streamable HTTP).

### Connect Codex CLI

In another terminal:

```bash
codex mcp add order-ops --url http://127.0.0.1:3000/mcp
codex mcp list
codex
```

### Connect Claude Code

```bash
claude mcp add --transport http --scope local \
  order-ops http://127.0.0.1:3000/mcp
claude mcp list
claude
```

Use `/mcp` inside Claude Code to inspect the active connection.

### Connect MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP in the Inspector and enter:

```text
http://127.0.0.1:3000/mcp
```

Any other MCP client that supports Streamable HTTP can use the same URL. This
server is not a stdio server, so stdio-only clients need an HTTP adapter.

## Agent prompts for the demo

These prompts are designed to show the intended product behavior rather than
simply list tools.

### Diagnose without changing state

```text
Use the order-ops MCP server to list the current order exceptions. Pick the
highest-priority exception, inspect its full details, and explain the issue
using the payment, inventory, fulfillment, SLA, and timeline evidence. Do not
propose or confirm anything yet.
```

### Propose, then wait for approval

```text
For the order you just inspected, call propose_resolution. Explain the
proposal's evidence, risk, and expected changes. Do not call
confirm_resolution; wait for me to explicitly approve the proposalId.
```

### Demonstrate the safety boundary

```text
I approve proposalId <paste-proposal-id-here> for operator "Demo Operator".
Call confirm_resolution once, report the structured result, then try the same
proposalId a second time and show that the server rejects reuse.
```

### Demonstrate safe escalation

```text
Find the fraud-review exception or another pattern without a matching
playbook rule. Inspect it and propose a resolution. Explain why escalating to a
human is safer than guessing, and do not confirm it unless I approve.
```

### Demonstrate the test helper

```text
Call simulate_new_failure once, then list the exceptions again and inspect the
new order. Treat this as synthetic demo data, not a production event source.
```

## Verifying it works

```bash
npm test        # unit tests: resolution playbook + propose/confirm safety flow
npm run smoke    # real end-to-end check: boots the server, drives it with the
                 # actual MCP client over Streamable HTTP — initialize, every
                 # tool, both error paths
```

Both are green as of this commit. `npm run smoke` is the one that actually
proves the wire protocol works, not just the internal functions.

## Deploying (Render)

1. Push this repo to GitHub.
2. New → Web Service on Render, connect the repo.
3. Build command: `npm install && npm run build`. Start command: `npm start`.
4. Set the `PUBLIC_HOSTNAME` env var to the `.onrender.com` hostname Render
   assigns, once you know it, to enable host-header validation.
5. Your MCP URL is `https://<your-service>.onrender.com/mcp`.

## Product decisions, assumptions, exclusions

- **Scope**: one coherent workflow (order exceptions) rather than separate
  features across orders/payments/inventory/fulfillment, per the brief's own
  emphasis on coherence over breadth.
- **Data**: synthetic and self-generated, per the brief's data requirement.
  A real Shopify dev-store integration was evaluated (free Partner account,
  Bogus Gateway for realistic test transactions) and deliberately not used
  for the default path — the in-memory mock, seeded with Shopify's real
  vocabulary, gets most of the realism at a fraction of the setup cost. The
  data layer sits behind an `OrdersProvider` interface specifically so a
  real integration could be swapped in later without touching tool code.
- **Safety**: writes are two-step by design (`propose_resolution` →
  `confirm_resolution`). No tool can change order state in a single call.
  Proposals include supporting evidence, expected state changes, and a risk
  level. Confirmation requires the operator's name, which is written into the
  order's timeline for an audit trail. Applied resolutions leave the active
  exception queue; a human escalation deliberately remains active.
- **Auth**: intentionally not implemented in this pass — see AGENTS.md
  "Security baseline" for the reasoning and the exact backfill plan. What
  *is* in place: host-header validation (DNS-rebinding protection), which is
  a different concern from caller authentication and costs nothing to
  include now.
- **SDK version**: built on `@modelcontextprotocol/server` v2 (current, spec
  2026-07-28) rather than the more commonly-referenced
  `@modelcontextprotocol/sdk` v1 — verified by installing both and reading
  their actual shipped types rather than trusting either search results or
  an AI agent's training-data assumptions. See AGENTS.md "Key decisions".

## Known gaps / next steps

- No caller authentication yet (see above — backfill plan is documented, not
  hand-waved).
- Resolution suggestions are a deterministic rule table
  (`src/data/playbook.ts`), not a model call — intentional, since it makes
  the same broken order always produce the same suggestion and it's fully
  unit-testable. An LLM-backed "explain this in plain English to the
  customer" step would be a natural next addition on top of it.
- Single in-process store — restarting the server resets the data. Fine for
  a demo, not meant to imply this is how state would work in production.
- Exception priority and SLA values are synthetic operational metadata, not a
  claim that Shopify or Stripe calculates them. A production provider would
  source those fields from the merchant's OMS/helpdesk policy.
