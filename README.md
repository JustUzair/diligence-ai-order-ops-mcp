# Order Ops MCP

Order Ops MCP is a hosted TypeScript MCP server for commerce operators. It
helps an AI agent investigate stuck orders, suggest a safe next step, and only
apply that step after a person approves it.

- Hosted MCP: `https://diligence-ai-order-ops-mcp.onrender.com/mcp`
- Health check: `https://diligence-ai-order-ops-mcp.onrender.com/health`
- Transport: Streamable HTTP
- Data: synthetic, repeatable Faker data only

> [!IMPORTANT]
> `GET /health` is public. Every `POST /mcp` request needs a bearer token in
> its `Authorization` header. Set `MCP_BEARER_TOKEN` locally or in Render;
> never commit, screenshot, or put its value in this README.

## What it supports

The workflow is intentionally small:

```text
list exceptions → inspect one order → propose a resolution → explicit approval → confirm once
```

| Tool | What it does | Changes data? |
| --- | --- | :---: |
| `list_order_exceptions` | Lists active issues with priority, owner, SLA, value, and a short summary. | No |
| `get_order_details` | Gets the payment, inventory, fulfillment, duplicate, and timeline evidence for one order. | No |
| `propose_resolution` | Returns a suggested action, its evidence, expected effects, and risk. | No |
| `confirm_resolution` | Applies one pending proposal by `proposalId`. | Yes |
| `simulate_new_failure` | Adds a synthetic exception for a demo or smoke test. | Demo only |

The server handles declined payments with reserved stock, stock shortages,
fraud holds, incomplete fulfillment, and likely duplicate orders. Any pattern
outside the playbook is escalated instead of guessed.

## Connect in a few minutes

### Use the hosted server with Codex

Get the private token from the deployer out of band, then add this to
`~/.codex/config.toml` on your own machine:

```toml
[mcp_servers.order-ops]
url = "https://diligence-ai-order-ops-mcp.onrender.com/mcp"
enabled = true

[mcp_servers.order-ops.http_headers]
"Authorization" = "Bearer YOUR_RENDER_MCP_TOKEN"
```

Restart Codex, then try:

```text
Use order-ops to list the current order exceptions. Pick the highest-priority
order, inspect it, and explain the issue. Propose a resolution, but do not
apply it until I explicitly approve it.
```

### Use the hosted server with Claude Code

With the same private token available in your shell:

```bash
claude mcp add --transport http --scope user \
  order-ops https://diligence-ai-order-ops-mcp.onrender.com/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

`claude mcp list` confirms the connection. MCP Inspector also works: choose
**Streamable HTTP**, use the hosted MCP URL, and add
`Authorization: Bearer <token>` as a request header.

> [!NOTE]
> This demo runs on Render's free tier. After inactivity, the first request can
> take longer while the service wakes up. Check `/health` or retry once before
> treating it as an MCP error.

### Run it locally

Requirements: Node.js 20+, pnpm, and an HTTP-capable MCP client.

```bash
git clone https://github.com/JustUzair/diligence-ai-order-ops-mcp.git
cd diligence-ai-order-ops-mcp
pnpm install
cp .env.example .env
```

Set a private value for `MCP_BEARER_TOKEN` in `.env`. You can generate one
with `openssl rand -hex 32`, then start the server:

```bash
pnpm dev
```

Local endpoints:

| Endpoint | URL |
| --- | --- |
| MCP | `http://127.0.0.1:3000/mcp` |
| Health | `http://127.0.0.1:3000/health` |

Verify that it is up:

```bash
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{ "status": "ok", "service": "order-ops-mcp" }
```

For a local Codex connection, use the same header pattern with the local URL:

```toml
[mcp_servers.order-ops-local]
url = "http://127.0.0.1:3000/mcp"

[mcp_servers.order-ops-local.http_headers]
"Authorization" = "Bearer YOUR_LOCAL_MCP_TOKEN"
```

For Claude Code, substitute the local URL in the earlier command and use
`--scope local`.

`PUBLIC_HOSTNAME` is optional locally. On Render it must be set to
`diligence-ai-order-ops-mcp.onrender.com` — only the hostname, with no scheme
or path.

## How the server is organised

```mermaid
flowchart LR
    A[MCP client] -->|Bearer token| B[Express: POST /mcp]
    B --> C[MCP tools]
    C --> D[OrdersProvider]
    D --> E[Seeded in-memory store]
    C --> F[Resolution playbook]
    F --> G[Pending proposal]
    G -->|Human approval| H[One controlled change]
    H --> I[Timeline audit event]
```

| Area | Responsibility | Main location |
| --- | --- | --- |
| HTTP and MCP setup | Health endpoint, host validation, authenticated MCP route. | `src/server.ts` |
| Environment | Loads `.env` and validates runtime settings once. | `src/config/env.ts` |
| Authentication | Verifies the static bearer token and supplies the demo operator identity. | `src/auth.ts` |
| Tool contract | Registers the five MCP tools and validates their inputs. | `src/tools/order-tools.ts` |
| Domain and data | Defines order types, creates fixed synthetic records, and owns mutations. | `src/data/` |
| Tests | Unit coverage plus a real Streamable HTTP smoke test. | `test/`, `scripts/smoke-test.ts` |

The tool layer depends on `OrdersProvider`, not directly on the in-memory
store. A real OMS or Shopify provider can later implement that interface
without changing the tool contract.

## Safety and authentication

`confirm_resolution` is the only state-changing tool. It accepts only a
`proposalId` created by `propose_resolution`; it cannot take an arbitrary
order change. A proposal is pending until it is confirmed and cannot be used
twice. The store records the approved action in that order's timeline.

Authentication is one static bearer token, as requested for this assignment:

- Valid requests send `Authorization: Bearer <MCP_BEARER_TOKEN>`.
- Missing or incorrect tokens receive `401 Unauthorized` and a standard bearer
  challenge.
- If the server starts without `MCP_BEARER_TOKEN`, `/mcp` fails closed with
  `503`; `/health` remains public for deployment checks.
- The one valid token maps to the fixed demo operator **John Doe**. Clients do
  not send an `approvedBy` value, so the audit identity stays deterministic.

This is deliberately not OAuth or user management. It has no token issuing,
expiry, rotation, or role system. Those are production follow-ups, not hidden
assignment scope.

## Synthetic data and limits

The initial dataset contains 21 repeatable synthetic orders: 14 normal orders,
six active exceptions, and the healthy original referenced by the duplicate
case. It includes payment attempts, stock allocation, fulfillment context,
delivery promises, ownership, SLA timing, and an event timeline. No real
customer data, production credentials, or live commerce calls are used.

The store lives in process. Data and audit events last while the server is
running, then return to the fixed seed after a restart. This is intentional for
a small, reliable demo; durable audit storage is the next step for a real
deployment.

## Demo: authenticated resolution flow

The screenshots below show the current end-to-end flow. The client was
configured with a bearer token, but the secret is not shown.

1. An unavailable or invalid MCP connection cannot call a tool.

   ![Invalid bearer access is refused](docs/images/auth-flow/01-invalid-bearer.png)

2. After reconnecting with a valid token, the agent lists the six active
   exceptions.

   ![Valid bearer lists exceptions](docs/images/auth-flow/02-valid-bearer-list.png)

3. It inspects `ORD-1021`, creates an inert duplicate-order proposal, and
   presents the expected impact and risk.

   ![Reconnect and inspect the selected order](docs/images/auth-flow/03-relogin-and-inspect.png)

   ![Order details and proposed resolution](docs/images/auth-flow/04-details-and-proposal.png)

4. Only after the user approves does the agent call `confirm_resolution`. The
   server records **John Doe**, cancels the duplicate, refunds it, releases its
   stock, and removes it from the active queue.

   ![Explicit approval and confirmation](docs/images/auth-flow/05-explicit-approval.png)

   ![Successful resolution and queue verification](docs/images/auth-flow/06-resolution-applied.png)

## Verify the project

```bash
pnpm test
pnpm smoke
pnpm build
```

`pnpm test` covers the playbook, repeatable seed data, bearer-auth rejection,
and the proposal-to-confirm safety rules. `pnpm smoke` starts the real server
on an ephemeral port and uses the official MCP client to verify the HTTP
handshake, unauthenticated rejection, all tools, a successful confirmation,
proposal reuse rejection, and synthetic failure injection.

Other useful commands:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the TypeScript server in watch mode. |
| `pnpm build && pnpm start` | Run the compiled production path. |
| `pnpm seed:check` | Validate the synthetic seed data. |

## Deploy on Render

Create a Render **Web Service** for this repository and use:

```text
Build command: pnpm install --frozen-lockfile && pnpm build
Start command: pnpm start
```

Set these environment variables in Render, not in Git:

```text
PUBLIC_HOSTNAME=diligence-ai-order-ops-mcp.onrender.com
MCP_BEARER_TOKEN=<a-private-random-value>
```

Then check:

```bash
curl https://diligence-ai-order-ops-mcp.onrender.com/health
```

If Render returns `Invalid Host`, check that `PUBLIC_HOSTNAME` contains only
the hostname above and redeploy. The authenticated `/mcp` route needs the
same bearer token configured in your MCP client.

## Scope after this assignment

The focused demo is complete, but a production version would add durable
storage and transactional confirmation, a real order provider, token rotation
and role-based access, concurrency protection, and replace the demo failure
tool with real order events.

See [AGENTS.md](AGENTS.md) for the project handoff rules and technical
invariants.
