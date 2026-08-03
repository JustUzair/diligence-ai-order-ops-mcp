# order-ops-mcp

A remotely-hosted MCP server that lets an operations team diagnose and
resolve stuck orders — payment declines, fulfillment holds, incomplete
fulfillment, likely duplicates — without pulling in an engineer, by letting
an AI agent ask natural-language questions like _"why is order #4471
stuck?"_ and act on the answer with explicit human confirmation.

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

> **Render cold-start note:** the deployed service runs on Render and may go
> idle. The first request after inactivity can take longer while the service
> wakes up. Retry once or wait for the health check to respond before judging
> the MCP connection. This is hosting behavior, not an MCP tool failure.

## Quick start: choose a connection

The same five MCP tools are available through two connections:

| Connection | MCP URL | Use it when |
| --- | --- | --- |
| `order-ops-local` | `http://127.0.0.1:3000/mcp` | You want fast local development with no Render cold start |
| `order-ops-render` | `https://diligence-ai-order-ops-mcp.onrender.com/mcp` | You want to test the remotely hosted submission |

For a first demo, the deployed connection is the easiest path. For code
changes and tests, use the local connection.

## Feature buckets

Here is how the repository is split around the assignment's main work:

| Bucket                               | What is included                                                                                                                                              | Main files                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1. MCP contract and agent UX         | Streamable HTTP endpoint, five tool registrations, LLM-oriented descriptions, structured outputs, and clear error responses                                   | `src/server.ts`, `src/tools/order-tools.ts`                  |
| 2. Commerce diagnosis evidence       | Synthetic orders, payment attempts, inventory allocations, fulfillment/carrier context, duplicate signals, ownership, priorities, and response SLAs           | `src/data/types.ts`, `src/data/seed.ts`, `src/data/store.ts` |
| 3. Deterministic resolution playbook | Evidence-backed proposals for payment, inventory, fulfillment, duplicate, and unknown/fraud patterns                                                          | `src/data/playbook.ts`                                       |
| 4. Safety and controlled mutation    | Inert proposals, operator approval, one-time proposal use, audit timeline entries, allocation release, simulated refund, and active-queue resolution behavior | `src/data/store.ts`, `src/tools/order-tools.ts`              |
| 5. Verification and delivery         | Unit tests, live Streamable HTTP smoke test, local setup, Render deployment notes, and known tradeoffs                                                        | `test/`, `scripts/smoke-test.ts`, this README                |

Buckets 1–4 make up the product workflow. `simulate_new_failure` is only a
demo helper. A production version would receive exceptions from order events.

## Data model

The server starts with a fixed Faker seed. Restarting it restores the same
demo dataset, which makes the walkthrough repeatable. There are 21 synthetic
orders: 14 healthy controls and six active exceptions. The other order is the
healthy original in a duplicate pair.

The seed includes these cases, all within the same order-operations workflow:

| Scenario                                                | Diagnostic evidence                                              | Proposed action                   |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- |
| Declined payment with stock held (two decline variants) | gateway attempt, decline/advice code, reserved units, SLA owner  | release inventory and cancel      |
| Inventory shortage                                      | per-SKU requested/available quantity, location, delivery promise | notify customer of backorder      |
| High-risk fraud hold                                    | hold reason, audit timeline, urgent fraud-team ownership         | escalate to a human; do not guess |
| Incomplete fulfillment                                  | carrier, retry count, last error, promised dates                 | retry fulfillment                 |
| Likely duplicate                                        | matched order, confidence, four matching signals                 | cancel, refund, and release stock |

Every order also carries synthetic customer history, channel, coarse shipping
destination, payment attempts, inventory allocations, fulfillment/carrier
context, delivery promises, operational priority, response SLA, and a timeline.
`list_order_exceptions` returns compact triage metadata; `get_order_details`
returns the full evidence only for the selected order.

The state names use public commerce vocabulary where it helps the data feel
familiar:

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

## Use the deployed MCP server

The hosted deployment is available at:

- MCP endpoint: `https://diligence-ai-order-ops-mcp.onrender.com/mcp`
- Health check: `https://diligence-ai-order-ops-mcp.onrender.com/health`
- Transport: Streamable HTTP

Verify the deployment without starting a local server:

```bash
curl https://diligence-ai-order-ops-mcp.onrender.com/health
```

Expected response:

```json
{"status":"ok","service":"order-ops-mcp"}
```

Register the deployed endpoint with Codex:

```bash
codex mcp add order-ops-render --url https://diligence-ai-order-ops-mcp.onrender.com/mcp
codex mcp list
```

Register it with Claude Code:

```bash
claude mcp add --transport http --scope user \
  order-ops-render https://diligence-ai-order-ops-mcp.onrender.com/mcp
claude mcp list
```

For MCP Inspector, choose Streamable HTTP and use the same deployed MCP URL.

### Deployment verification

Last verified against the deployed service on 2026-08-03:

- `GET /health` returned `{"status":"ok","service":"order-ops-mcp"}`.
- MCP initialization over Streamable HTTP succeeded.
- Read-only `list_order_exceptions` succeeded and returned six active synthetic exceptions.
- The five registered tools were visible: `list_order_exceptions`,
  `get_order_details`, `propose_resolution`, `confirm_resolution`, and
  `simulate_new_failure`.

The live verification above did not mutate an order or proposal.

If Render returns `Invalid Host: diligence-ai-order-ops-mcp.onrender.com`,
make sure the environment variable contains only the hostname shown above and
redeploy the latest commit. The server explicitly opts out of the adapter's
localhost-only default and passes `PUBLIC_HOSTNAME` into its production host
allowlist.

## Setup for a first-time user

You can connect any MCP client that supports Streamable HTTP. The local server
exposes:

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health check: `http://127.0.0.1:3000/health`
- Transport: Streamable HTTP
- Authentication: intentionally disabled for this assignment

Requires Node ≥ 20.

### 1. Start and verify the server

Clone the repository, open a terminal in its directory, and install the
dependencies:

```bash
cd /path/to/order-ops-mcp
pnpm install
```

Start the server in Terminal 1:

```bash
pnpm dev
```

Local development does not require `PUBLIC_HOSTNAME`; localhost is allowed by
default. To exercise the explicit host allowlist locally, run:

```bash
PUBLIC_HOSTNAME=localhost pnpm dev
```

You should see:

```text
[order-ops-mcp] listening on :3000 (POST /mcp, GET /health)
```

In Terminal 2, verify the health endpoint:

```bash
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{ "status": "ok", "service": "order-ops-mcp" }
```

Run the automated checks from Terminal 2 as well:

```bash
pnpm test
pnpm smoke
```

The smoke test uses the official MCP client over Streamable HTTP. It checks
initialization, every tool, invalid order handling, proposal immutability,
confirmation, active-queue behavior, and duplicate-confirmation rejection.

### 2. Test with Codex CLI

Register the local HTTP MCP server:

```bash
codex mcp add order-ops-local --url http://127.0.0.1:3000/mcp
```

Verify the registration:

```bash
codex mcp list
codex mcp get order-ops-local
```

Start Codex from the repository:

```bash
codex
```

Then use this first prompt:

```text
Use the order-ops MCP server to list all current order exceptions.
Pick one exception, inspect its full details, and explain the issue.
Then propose a resolution, but do not confirm or apply it.
```

### 3. Test with Claude Code

Register the server for the current project:

```bash
claude mcp add --transport http --scope local \
  order-ops-local http://127.0.0.1:3000/mcp
claude mcp list
claude
```

Inside Claude Code, use `/mcp` to inspect the active connection, then run the
same diagnostic prompt above.

### 4. Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP and enter:

```text
http://127.0.0.1:3000/mcp
```

Any MCP client supporting Streamable HTTP can use the same URL. This server is
not a stdio server, so stdio-only clients require an HTTP adapter.

### Authentication decision

Caller authentication and user-management infrastructure were deliberately
not added in this assignment. The brief explicitly prioritizes a small,
coherent, useful MCP workflow over picture-perfect production tooling, and
building and wiring an operator identity system would expand the scope beyond
the core order-operations problem.

The `approvedBy` value on `confirm_resolution` is therefore an audit label,
not proof of identity. This is stated as a known gap rather than being hidden:
the next production step would replace the current middleware seam with
Bearer/OAuth verification and derive the approving operator from the verified
identity. Local testing does not require credentials.

### Assumptions in the walkthrough

The approval prompt says to assume that `Uzair Saiyed` is authenticated. That
is a demo assumption so the screenshot can show the approval path clearly. The
current server does not validate that name or authenticate the caller.

For a production deployment, the `/mcp` route should sit behind OAuth or JWT
verification. The middleware would derive the operator identity from the
verified token, check the operator's role before exposing or confirming order
actions, and pass the verified identity into the audit event. `approvedBy`
should then come from that identity instead of from untrusted tool input.

## Working MCP flow

These screenshots come from one continuous session with the `order-ops`
connection. Each prompt is followed by the tool output it produced. The first
session started with six active exceptions; after `ORD-1015` was resolved, the
last screenshot shows the remaining five.

The flow was tested against the MCP server and is included here so a reviewer
can see what an agent actually does with the tools.

### 1. Find the problematic orders

Prompt:

```text
Can you use order-ops and get the faulty/problematic orders?
```

Output:

![Order exception list](docs/images/flow-1.png)

### 2. Ask for more detail about the top three

Prompt:

```text
Can you explain in some more detail about the top-3 high priority faulty orders?
```

Output:

![Top three order diagnostics](docs/images/flow-2.png)

### 3. Read the first part of the diagnosis

The agent pulls the details for `ORD-1015`, `ORD-1016`, and `ORD-1017`, then
explains what is wrong and why each order needs attention.

![First part of the priority diagnosis](docs/images/flow-3.png)

### 4. Continue the diagnosis

The inventory shortage is separated from the payment cases. The agent also
explains why `do_not_try_again` should not become an automatic retry.

![Continuation of the priority diagnosis](docs/images/flow-4.png)

### 5. Propose, ask, and confirm a resolution

Prompt:

```text
Resolve ORD-1015 by releasing the reservation. Assume that the operator is
authenticated under "Uzair Saiyed" with a valid operator identity.
```

The agent creates a proposal first and asks for approval. The approval is a
separate user message:

```text
Yes, go ahead.
```

![Proposal and confirmed resolution](docs/images/flow-5.png)

The tool response shows the proposal ID, the guarded action, the operator
label, released inventory, cancellation, and removal from the active queue.

### 6. Check the queue after confirmation

Prompt:

```text
Can you list the active faulty orders now?
```

![Active queue after resolution](docs/images/flow-6.png)

`ORD-1015` is gone from the active queue. The other five exceptions remain.

### Codex configuration for the deployed server

Codex can also connect through its TOML configuration:

```toml
[mcp_servers.order-ops]
url = "https://diligence-ai-order-ops-mcp.onrender.com/mcp"
```

For a local connection, use a different name so both servers can be kept:

```toml
[mcp_servers.order-ops-local]
url = "http://127.0.0.1:3000/mcp"
```

## Agent prompts for the demo

These prompts exercise the workflow from diagnosis through guarded approval.

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
pnpm test        # unit tests: resolution playbook + propose/confirm safety flow
pnpm smoke       # real end-to-end check: boots the server, drives it with the
                 # actual MCP client over Streamable HTTP — initialize, every
                 # tool, both error paths
```

Both are green as of this commit. `pnpm smoke` is the one that actually
proves the wire protocol works, not just the internal functions.

## Deploying (Render)

1. Push this repo to GitHub.
2. New → Web Service on Render, connect the repo.
3. Build command: `pnpm install --frozen-lockfile && pnpm build`. Start command: `pnpm start`.
4. In Render → Service → Environment, set:

   ```text
   PUBLIC_HOSTNAME=diligence-ai-order-ops-mcp.onrender.com
   ```

   Use only the hostname. Do not include `https://`, `/mcp`, or a trailing
   slash. Render will restart the service after saving the variable.
5. Your MCP URL is
   `https://diligence-ai-order-ops-mcp.onrender.com/mcp`.
6. Verify the deployment with:

   ```bash
   curl https://diligence-ai-order-ops-mcp.onrender.com/health
   ```

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
  _is_ in place: host-header validation (DNS-rebinding protection), which is
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
