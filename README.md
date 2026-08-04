<div align="center">

# Order Ops MCP

**A remotely hosted MCP server for diagnosing and safely resolving stuck commerce orders through natural-language agent workflows.**

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-2.0.0-6D28D9?style=flat-square)](https://modelcontextprotocol.io/)
[![Express](https://img.shields.io/badge/Express-5.2.1-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![Zod](https://img.shields.io/badge/Zod-4.4.3-3E67B1?style=flat-square&logo=zod&logoColor=white)](https://zod.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-4.1.10-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![Render](https://img.shields.io/badge/Deployed_on-Render-46E3B7?style=flat-square&logo=render&logoColor=000000)](https://diligence-ai-order-ops-mcp.onrender.com/health)
[![License](https://img.shields.io/badge/License-ISC-F5C518?style=flat-square)](https://opensource.org/license/isc-license-txt)

[Live MCP endpoint](https://diligence-ai-order-ops-mcp.onrender.com/mcp)
·
[Health check](https://diligence-ai-order-ops-mcp.onrender.com/health)
·
[Repository](https://github.com/JustUzair/diligence-ai-order-ops-mcp)

</div>

---

Order Ops MCP gives an operations team a focused agent workflow for identifying and resolving order exceptions such as payment declines, inventory holds, incomplete fulfillment, fraud holds, and likely duplicates.

An AI agent can ask questions such as:

> “Why is order `ORD-1015` stuck, and what is the safest next action?”

The server returns operational evidence, proposes a deterministic resolution, and keeps that proposal inert until a human explicitly confirms it.

## Core workflow

```text
list_order_exceptions
        ↓
get_order_details
        ↓
propose_resolution
        ↓
explicit human approval
        ↓
confirm_resolution
```

| Step                    | Purpose                                                              | Mutates state? |
| ----------------------- | -------------------------------------------------------------------- | :------------: |
| `list_order_exceptions` | Finds orders currently requiring attention                           |       No       |
| `get_order_details`     | Returns the selected order’s full diagnostic evidence and timeline   |       No       |
| `propose_resolution`    | Generates an evidence-backed proposal with expected changes and risk |       No       |
| `confirm_resolution`    | Applies an existing pending proposal and records the approver        |    **Yes**     |

`simulate_new_failure` is a demo-only helper that inserts a fresh synthetic exception. It is not part of the production workflow.

## Why this implementation is safe

The project treats agent-generated actions as proposals, not permission.

- **No one-call mutation:** an agent cannot change an order directly from diagnosis.
- **Explicit approval boundary:** only `confirm_resolution` mutates order state.
- **Proposal integrity:** confirmation requires the exact `proposalId` returned by `propose_resolution`.
- **One-time use:** confirmed proposals cannot be reused.
- **Evidence before action:** every proposal includes rationale, supporting evidence, expected changes, and a risk level.
- **Auditable changes:** confirmed actions add an operator-labelled event to the order timeline.
- **Safe fallback:** unknown or unsupported patterns are escalated to a human instead of being guessed.

## Table of contents

- [Try the deployed server](#try-the-deployed-server)
- [Connection options](#connection-options)
- [MCP tool surface](#mcp-tool-surface)
- [Architecture](#architecture)
- [Assignment coverage](#assignment-coverage)
- [Synthetic commerce data](#synthetic-commerce-data)
- [Working MCP flow](#working-mcp-flow)
- [Local development](#local-development)
- [Agent prompts](#agent-prompts)
- [Verification and testing](#verification-and-testing)
- [Deployment](#deployment)
- [Technology stack](#technology-stack)
- [Security posture](#security-posture)
- [Design decisions and tradeoffs](#design-decisions-and-tradeoffs)
- [Known gaps and next steps](#known-gaps-and-next-steps)

## Try the deployed server

The hosted service exposes:

| Endpoint  | URL                                                      |
| --------- | -------------------------------------------------------- |
| MCP       | `https://diligence-ai-order-ops-mcp.onrender.com/mcp`    |
| Health    | `https://diligence-ai-order-ops-mcp.onrender.com/health` |
| Transport | Streamable HTTP                                          |

Check the deployment:

```bash
curl https://diligence-ai-order-ops-mcp.onrender.com/health
```

Expected response:

```json
{ "status": "ok", "service": "order-ops-mcp" }
```

### Register with Codex

```bash
codex mcp add order-ops-render \
  --url https://diligence-ai-order-ops-mcp.onrender.com/mcp

codex mcp list
```

Then start Codex and use:

```text
Use the order-ops MCP server to list all current order exceptions.
Pick the highest-priority exception, inspect its full details, and explain
what is wrong. Then propose a resolution, but do not confirm or apply it.
```

### Register with Claude Code

```bash
claude mcp add --transport http --scope user \
  order-ops-render https://diligence-ai-order-ops-mcp.onrender.com/mcp

claude mcp list
```

For MCP Inspector, select **Streamable HTTP** and use the same deployed MCP URL.

> [!NOTE]
> The service is hosted on Render and may sleep after inactivity. The first request can be slower while the service wakes. Check `/health` or retry once before treating a slow initial response as an MCP failure.

### Deployment verification

The complete deployed MCP flow was last verified on **2026-08-03**:

- `GET /health` returned `{"status":"ok","service":"order-ops-mcp"}`.
- MCP initialization over Streamable HTTP succeeded.
- `list_order_exceptions` returned six active synthetic exceptions.
- All five registered tools were visible:
  - `list_order_exceptions`
  - `get_order_details`
  - `propose_resolution`
  - `confirm_resolution`
  - `simulate_new_failure`

The health endpoint was checked again on **2026-08-04** and returned the expected healthy response.

The deployed verification did not mutate an order or proposal.

## Connection options

The same MCP tools are available locally and remotely.

| Connection         | MCP URL                                               | Best for                                                       |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------- |
| `order-ops-render` | `https://diligence-ai-order-ops-mcp.onrender.com/mcp` | Reviewing the hosted submission without cloning the repository |
| `order-ops-local`  | `http://127.0.0.1:3000/mcp`                           | Development, tests, and faster repeated demos                  |

## MCP tool surface

### `list_order_exceptions`

Returns all active exceptions with compact triage metadata:

- exception type
- operational priority
- assigned team
- exception age
- response SLA status
- order value
- plain-language summary

This is the starting tool when the agent does not already have an order ID.

### `get_order_details`

Returns the selected order’s full diagnostic evidence:

- customer and channel context
- line items
- payment attempts and decline advice
- inventory allocations by SKU
- fulfillment and carrier state
- delivery promises
- duplicate evidence
- operational ownership and SLA
- complete event timeline

### `propose_resolution`

Matches the order against the deterministic playbook and returns:

```json
{
  "proposalId": "PROP-...",
  "orderId": "ORD-...",
  "action": "release_inventory_hold_and_cancel_order",
  "rationale": "...",
  "evidence": ["..."],
  "expectedChanges": ["..."],
  "risk": "high"
}
```

This tool never applies the action.

### `confirm_resolution`

Applies a previously created pending proposal.

It requires:

- the exact `proposalId`
- an `approvedBy` operator label

It rejects unknown proposal IDs and proposals that have already been confirmed.

### `simulate_new_failure`

Injects one new synthetic broken order for demonstrations and smoke testing.

A production deployment would remove this helper and receive exceptions from real commerce events.

## Architecture

```mermaid
flowchart LR
    A["MCP client / AI agent"] -->|"POST /mcp"| B["Stateless Streamable HTTP transport"]
    B --> C["MCP tool registry"]
    C --> D["OrdersProvider interface"]
    D --> E["Seeded in-memory order store"]
    C --> F["Deterministic resolution playbook"]
    F --> G["Pending proposal"]
    G -->|"Explicit human confirmation"| H["Controlled mutation"]
    H --> I["Order timeline audit event"]
```

### Request model

- The Express application exposes `POST /mcp` and `GET /health`.
- Each MCP request receives a fresh stateless Streamable HTTP transport.
- Tool code depends on the `OrdersProvider` interface instead of the in-memory implementation.
- The deterministic playbook decides what to propose.
- The store owns proposal persistence, one-time confirmation, mutation, and timeline updates.

This separation allows a Shopify-backed or OMS-backed provider to replace the demo store without rewriting the MCP tools.

## Assignment coverage

| Bucket                                   | What is included                                                                                                                          | Main files                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **1. MCP contract and agent UX**         | Streamable HTTP endpoint, five tool registrations, LLM-oriented descriptions, validation, structured outputs, and explicit errors         | `src/server.ts`, `src/tools/order-tools.ts`                  |
| **2. Commerce diagnostic evidence**      | Synthetic orders, payment attempts, inventory allocations, fulfillment context, duplicate signals, ownership, priority, and response SLAs | `src/data/types.ts`, `src/data/seed.ts`, `src/data/store.ts` |
| **3. Deterministic resolution playbook** | Evidence-backed proposals for payment, inventory, fulfillment, duplicate, and unknown or fraud patterns                                   | `src/data/playbook.ts`                                       |
| **4. Safety and controlled mutation**    | Inert proposals, explicit approval, one-time use, audit events, inventory release, simulated refunds, and active-queue resolution         | `src/data/store.ts`, `src/tools/order-tools.ts`              |
| **5. Verification and delivery**         | Unit tests, a real Streamable HTTP smoke test, setup instructions, Render deployment, and documented tradeoffs                            | `test/`, `scripts/smoke-test.ts`, `README.md`, `AGENTS.md`   |

Buckets 1 through 4 form the product workflow. `simulate_new_failure` exists only to make the demo repeatable.

## Synthetic commerce data

The server starts from a fixed Faker seed, so restarting it restores the same dataset and makes demonstrations reproducible.

The dataset contains **21 synthetic orders**:

- 14 healthy controls
- 6 active exceptions
- 1 healthy original order referenced by the duplicate case

### Included exception scenarios

| Scenario                         | Diagnostic evidence                                                   | Proposed action                       |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| Declined payment with stock held | Gateway attempt, decline code, advice code, reserved units, SLA owner | Release inventory and cancel          |
| Inventory shortage               | Requested and available quantity by SKU, location, delivery promise   | Notify the customer of a backorder    |
| High-risk fraud hold             | Hold reason, audit timeline, urgent fraud-team ownership              | Escalate to a human                   |
| Incomplete fulfillment           | Carrier, retry count, latest error, promised dates                    | Retry fulfillment                     |
| Likely duplicate                 | Matched order, confidence, and four matching signals                  | Cancel, refund, and release inventory |

Every order also contains synthetic customer history, channel, coarse destination, line items, payment attempts, inventory allocations, fulfillment context, delivery promises, priority, response SLA, and a timeline.

`list_order_exceptions` deliberately returns compact triage information. `get_order_details` returns the larger evidence set only for the selected order.

### Commerce vocabulary

The seed uses public commerce vocabulary where it improves realism:

- `CancelReason`: `CUSTOMER | DECLINED | FRAUD | INVENTORY | STAFF | OTHER`, based on Shopify’s published [`OrderCancelReason`](https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderCancelReason) enum.
- Fulfillment hold reasons such as `inventory_out_of_stock` and `high_risk_of_fraud` mirror Shopify’s [`FulfillmentHoldReason`](https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentHoldReason) and [`FulfillmentHold`](https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentHold) shapes.
- `fulfillmentStatus: "incomplete"` mirrors the state used when a fulfillment service accepts an order and then fails to complete it.
- Decline examples such as `insufficient_funds` and `do_not_honor`, including caller-oriented advice, are based on Stripe’s public [decline-code guidance](https://docs.stripe.com/declines/codes).

All data is generated in-process with `@faker-js/faker`. The repository contains no real customer data, production credentials, or live commerce integration.

## Working MCP flow

The screenshots below come from one continuous session using the `order-ops` connection.

The session began with six active exceptions. After `ORD-1015` was confirmed and resolved, the final screenshot shows the remaining five.

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

The agent retrieves `ORD-1015`, `ORD-1016`, and `ORD-1017`, then explains what is wrong and why each order requires attention.

![First part of the priority diagnosis](docs/images/flow-3.png)

### 4. Continue the diagnosis

The agent separates the inventory shortage from the payment failures and explains why `do_not_try_again` must not become an automatic retry.

![Continuation of the priority diagnosis](docs/images/flow-4.png)

### 5. Propose, ask, and confirm a resolution

Prompt:

```text
Resolve ORD-1015 by releasing the reservation. Assume that the operator is
authenticated under "Uzair Saiyed" with a valid operator identity.
```

The agent creates a proposal first and asks for explicit approval.

Approval:

```text
Yes, go ahead.
```

![Proposal and confirmed resolution](docs/images/flow-5.png)

The result shows the proposal ID, guarded action, operator label, released inventory, cancellation, and removal from the active exception queue.

### 6. Check the queue after confirmation

Prompt:

```text
Can you list the active faulty orders now?
```

![Active queue after resolution](docs/images/flow-6.png)

`ORD-1015` no longer appears in the queue. The other five active exceptions remain.

## Local development

### Prerequisites

- Node.js 20 or newer
- pnpm
- An MCP client that supports Streamable HTTP

### 1. Install and start

```bash
git clone https://github.com/JustUzair/diligence-ai-order-ops-mcp.git
cd diligence-ai-order-ops-mcp

pnpm install
pnpm dev
```

Expected output:

```text
[order-ops-mcp] listening on :3000 (POST /mcp, GET /health)
```

Local endpoints:

| Endpoint | URL                            |
| -------- | ------------------------------ |
| MCP      | `http://127.0.0.1:3000/mcp`    |
| Health   | `http://127.0.0.1:3000/health` |

Local development does not require `PUBLIC_HOSTNAME`. To exercise the explicit host allowlist locally:

```bash
PUBLIC_HOSTNAME=localhost pnpm dev
```

Verify the service:

```bash
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{ "status": "ok", "service": "order-ops-mcp" }
```

### 2. Run the checks

```bash
pnpm test
pnpm smoke
```

### 3. Connect Codex locally

```bash
codex mcp add order-ops-local \
  --url http://127.0.0.1:3000/mcp

codex mcp list
codex mcp get order-ops-local
codex
```

Codex TOML configuration:

```toml
[mcp_servers.order-ops-local]
url = "http://127.0.0.1:3000/mcp"
```

The hosted connection can be kept alongside it:

```toml
[mcp_servers.order-ops]
url = "https://diligence-ai-order-ops-mcp.onrender.com/mcp"
```

### 4. Connect Claude Code locally

```bash
claude mcp add --transport http --scope local \
  order-ops-local http://127.0.0.1:3000/mcp

claude mcp list
claude
```

Inside Claude Code, use `/mcp` to inspect the active connection.

### 5. Use MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose **Streamable HTTP** and enter:

```text
http://127.0.0.1:3000/mcp
```

This project is an HTTP MCP server, not a stdio server. Stdio-only clients require an HTTP adapter.

## Agent prompts

### Diagnose without changing state

```text
Use the order-ops MCP server to list the current order exceptions. Pick the
highest-priority exception, inspect its full details, and explain the issue
using the payment, inventory, fulfillment, SLA, and timeline evidence.
Do not propose or confirm anything yet.
```

### Propose and wait for approval

```text
For the order you just inspected, call propose_resolution. Explain the
proposal's evidence, risk, and expected changes. Do not call
confirm_resolution. Wait for me to explicitly approve the proposalId.
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
playbook rule. Inspect it and propose a resolution. Explain why escalating
to a human is safer than guessing, and do not confirm it unless I approve.
```

### Demonstrate the test helper

```text
Call simulate_new_failure once, then list the exceptions again and inspect
the new order. Treat this as synthetic demo data, not a production event source.
```

## Verification and testing

### Unit tests

```bash
pnpm test
```

The Vitest suite covers the deterministic playbook, enriched synthetic fixtures, and the proposal-to-confirmation safety flow, including:

- no mutation before confirmation
- unknown proposal rejection
- duplicate confirmation rejection
- resolved orders leaving the active queue
- human escalations remaining active

### Live protocol smoke test

```bash
pnpm smoke
```

The smoke test boots the real Express application on an ephemeral port and drives it using the official MCP client over Streamable HTTP.

It verifies:

- MCP initialization
- all five tools
- invalid order handling
- proposal output and evidence
- byte-for-byte immutability before confirmation
- successful confirmation
- active-queue removal
- duplicate-confirmation rejection
- synthetic failure injection

`pnpm smoke` proves the wire-level MCP integration, not only the internal functions.

### Other commands

| Command           | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `pnpm dev`        | Start the TypeScript server in watch mode   |
| `pnpm build`      | Compile TypeScript to `dist/`               |
| `pnpm start`      | Run the compiled production server          |
| `pnpm test`       | Run the Vitest unit suite                   |
| `pnpm smoke`      | Run the live Streamable HTTP MCP smoke test |
| `pnpm seed:check` | Execute the seed validation script          |

## Deployment

### Deploy on Render

1. Push the repository to GitHub.
2. Create a new **Web Service** in Render and connect the repository.
3. Set the build command:

   ```bash
   pnpm install --frozen-lockfile && pnpm build
   ```

4. Set the start command:

   ```bash
   pnpm start
   ```

5. Add this environment variable:

   ```text
   PUBLIC_HOSTNAME=diligence-ai-order-ops-mcp.onrender.com
   ```

   Use only the hostname. Do not include `https://`, `/mcp`, or a trailing slash.

6. Verify the deployment:

   ```bash
   curl https://diligence-ai-order-ops-mcp.onrender.com/health
   ```

If Render responds with:

```text
Invalid Host: diligence-ai-order-ops-mcp.onrender.com
```

confirm that `PUBLIC_HOSTNAME` contains only the hostname above, then redeploy the latest commit.

## Technology stack

Versions below reflect the checked-in `package.json` and lockfile.

| Area               | Technology                      | Version / detail            |
| ------------------ | ------------------------------- | --------------------------- |
| Runtime            | Node.js                         | `>=20`                      |
| Language           | TypeScript                      | `7.0.2`, ESM                |
| MCP server         | `@modelcontextprotocol/server`  | `2.0.0`                     |
| MCP HTTP adapter   | `@modelcontextprotocol/express` | `2.0.0`                     |
| MCP Node transport | `@modelcontextprotocol/node`    | `2.0.0`                     |
| MCP test client    | `@modelcontextprotocol/client`  | `2.0.0`                     |
| HTTP server        | Express                         | `5.2.1`                     |
| Validation         | Zod                             | `4.4.3`                     |
| Synthetic data     | `@faker-js/faker`               | `10.5.0`                    |
| Unit testing       | Vitest                          | `4.1.10`                    |
| TypeScript runner  | `tsx`                           | `4.23.5`                    |
| Package manager    | pnpm                            | Lockfile v9                 |
| Deployment         | Render                          | Streamable HTTP web service |

The project uses the MCP v2 package split rather than the legacy monolithic `@modelcontextprotocol/sdk` v1 package.

## Security posture

### Implemented

- Host-header validation through the MCP Express adapter when `PUBLIC_HOSTNAME` is configured
- Explicit production host allowlist
- Two-step propose and confirm workflow
- One-time proposal confirmation
- Zod input validation
- Operator-labelled timeline events
- No production credentials or customer data
- Deterministic escalation for unsupported patterns

### Intentionally deferred

Caller authentication and user management are not implemented in this assignment.

The `approvedBy` value is currently an audit label supplied by the caller. It is not proof of identity.

The existing `authPlaceholder` middleware in `src/server.ts` is the integration seam for a production auth layer. A production version should:

1. verify a Bearer token, OAuth token, or JWT
2. derive the operator identity from the verified token
3. enforce role-based permissions
4. stop accepting `approvedBy` as untrusted tool input
5. write the verified identity into the audit event

The walkthrough’s instruction to assume that `Uzair Saiyed` is authenticated is a demo assumption. The current server does not validate that identity.

## Design decisions and tradeoffs

### One coherent workflow

The project focuses on order exceptions rather than creating unrelated features across orders, payments, inventory, and fulfillment.

This keeps the tool surface small enough for an AI agent to choose correctly and deep enough to demonstrate a complete operational loop.

### Deterministic resolution playbook

Resolution suggestions come from a rule table in `src/data/playbook.ts`, not from a model call.

Benefits:

- the same evidence produces the same recommendation
- suggestions are easy to unit test
- state-changing logic remains predictable
- unsupported cases fail safely into human escalation

An LLM remains useful for deciding which tool to call and explaining the evidence to the operator. It does not invent the underlying mutation rule.

### Synthetic data over a fragile live integration

A Shopify development-store integration was evaluated but not used as the default path.

The fixed in-memory dataset provides repeatability, realistic commerce vocabulary, and a complete review experience without external account setup.

The data source remains behind `OrdersProvider`, so a Shopify, OMS, or database-backed provider can replace it later without changing the MCP tool layer.

### Stateless Streamable HTTP

Each request receives a fresh transport. The workflow does not require per-connection session state because tools operate using explicit `orderId` and `proposalId` values.

### Transparent scope

The repository names unfinished production concerns instead of disguising them:

- caller authentication is deferred
- state is in-process and non-durable
- priority and SLA values are synthetic
- the failure-injection tool is demo-only

See [`AGENTS.md`](AGENTS.md) for the project’s source-of-truth decisions and handoff notes.

## Known gaps and next steps

1. **Add authenticated operator identity**

   Replace `authPlaceholder` with Bearer, OAuth, or JWT verification and derive the approver from the verified identity.

2. **Persist operational state**

   Replace the in-memory maps with a durable database and use transactional proposal confirmation.

3. **Connect a real commerce provider**

   Implement `OrdersProvider` against Shopify, an OMS, or internal commerce services.

4. **Add authorization policy**

   Restrict high-risk actions such as refunds and cancellations by operator role and order value.

5. **Add idempotency and concurrency control**

   Protect confirmation against concurrent requests across multiple service instances.

6. **Add customer-facing explanation generation**

   Keep the deterministic operational action, then optionally use an LLM to draft a customer-safe explanation.

7. **Replace synthetic event injection**

   Remove `simulate_new_failure` and consume actual order, payment, inventory, and fulfillment events.

## License

The package metadata declares the ISC license.
