# Order Ops MCP

Order Ops MCP helps a commerce operations agent find stuck orders, explain the
evidence, propose a safe next step, and apply it only after explicit approval.
It is a TypeScript MCP server using Streamable HTTP.

- Hosted MCP: `https://diligence-ai-order-ops-mcp.onrender.com/mcp`
- Health check: `https://diligence-ai-order-ops-mcp.onrender.com/health`
- Local MCP: `http://127.0.0.1:3000/mcp`
- Data: synthetic Faker records; Postgres is optional locally and required for
  the durable production mode

> [!IMPORTANT]
> `GET /health` is public. Every `POST /mcp` request needs
> `Authorization: Bearer <token>`. The token value is never committed or
> shown in this repository.

## Workflow and tools

```text
list exceptions → inspect order → propose → explicit approval → confirm → audit
```

| Tool | Purpose | Writes state? |
| --- | --- | :---: |
| `list_order_exceptions` | Lists active issues, owner, priority, SLA, value, and summary. | No |
| `get_order_details` | Returns payment, inventory, fulfillment, duplicate, customer, and timeline evidence. | No |
| `propose_resolution` | Returns an allowlisted action, rationale, evidence, expected changes, and risk. | No |
| `confirm_resolution` | Applies one existing pending proposal after server-side checks. | Yes |
| `get_order_audit_log` | Shows who did what, when, and why for one public order id. | No |
| `simulate_new_failure` | Explicit demo helper that creates one new synthetic exception. | Yes |

Only `confirm_resolution` changes an order. It locks the proposal and order,
checks the current state, updates the order, stores the result, and writes an
audit event in one Postgres transaction. Repeating the same confirmation
returns the stored result instead of applying the action twice.

## Connect as a first-time user

### Hosted server with Codex

Ask the deployer for the private token out of band, then add this to
`~/.codex/config.toml`:

```toml
[mcp_servers.order-ops]
url = "https://diligence-ai-order-ops-mcp.onrender.com/mcp"
enabled = true

[mcp_servers.order-ops.http_headers]
"Authorization" = "Bearer YOUR_RENDER_MCP_TOKEN"
```

Restart Codex and try:

```text
Use order-ops to list the active order exceptions. Pick the highest-priority
one, inspect its details, and explain the evidence. Propose a resolution, but
do not confirm it until I explicitly approve it.
```

### Hosted server with Claude Code

```bash
claude mcp add --transport http --scope user \
  order-ops https://diligence-ai-order-ops-mcp.onrender.com/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Use `claude mcp list` to verify the connection. MCP Inspector can use the same
URL with **Streamable HTTP** and an `Authorization` request header.

> [!NOTE]
> The hosted service runs on Render's free tier. It can cold-start after being
> idle, so the first MCP request may take longer. Check `/health` or retry once
> before treating a timeout as a tool failure.

## Local setup

Requirements: Node.js 20+, pnpm, and an HTTP-capable MCP client.

```bash
git clone https://github.com/JustUzair/diligence-ai-order-ops-mcp.git
cd diligence-ai-order-ops-mcp
pnpm install
cp .env.example .env
```

Set a private local token in `.env`:

```bash
MCP_BEARER_TOKEN=$(openssl rand -hex 32)
```

The simplest local mode is memory-backed:

```text
PERSISTENCE_MODE=memory
```

Start it with `pnpm dev`. Health is public, but MCP still needs the bearer
header:

```bash
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{"status":"ok","service":"order-ops-mcp"}
```

Codex local configuration:

```toml
[mcp_servers.order-ops-local]
url = "http://127.0.0.1:3000/mcp"
enabled = true

[mcp_servers.order-ops-local.http_headers]
"Authorization" = "Bearer YOUR_LOCAL_MCP_TOKEN"
```

Claude Code uses the same header with the local URL:

```bash
claude mcp add --transport http --scope local \
  order-ops-local http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

## Local Supabase/Postgres mode

This app connects to Supabase through PostgreSQL and Prisma; it does not need a
Supabase anon key or REST Data API key.

1. Create or use a Supabase project and open **Connect**.
2. Put the session-mode pooler URL in `DATABASE_URL` for the long-running Node
   service. Put a direct migration-capable URL in `DIRECT_URL` when available.
3. Set these in `.env` and keep the values private:

   ```text
   PERSISTENCE_MODE=postgres
   DATABASE_URL=<supabase-session-pooler-url>
   DIRECT_URL=<supabase-direct-or-migration-url>
   MCP_BEARER_TOKEN=<private-local-token>
   ```

4. Create the tables and seed the canonical synthetic dataset:

   ```bash
   pnpm prisma:generate
   pnpm db:deploy
   pnpm db:smoke
   ```

5. Start the real MCP server and connect Codex or Claude using the local
   configuration above:

   ```bash
   pnpm dev
   ```

The first bootstrap inserts the fixed canonical seed only when its public
`ORD-...` rows are missing. Restarting the server does not regenerate or
overwrite existing records. `simulate_new_failure` is the only path that
creates another synthetic order, and it allocates the next number from a
database-locked sequence.

The Supabase dashboard will show these tables in **Table Editor**:

- `orders` — queryable lifecycle fields plus the complete synthetic payload in
  `data` JSONB;
- `resolution_proposals` — inert proposals and stored confirmation results;
- `order_audit_events` — append-only application audit events;
- `seed_metadata` and `order_number_sequences` — bootstrap and public-id state.

To drive the same official MCP client against Postgres instead of memory:

```bash
SMOKE_PERSISTENCE_MODE=postgres pnpm smoke
```

This intentionally writes synthetic smoke data to the configured database.
Use a disposable project or remove the smoke rows from the dashboard after
reviewing them.

## Data and safety decisions

The initial dataset is 21 repeatable synthetic orders: 14 healthy records, six
varied active exceptions, and the healthy side of the duplicate pair. Each
record includes customer context, payment attempts, inventory allocations,
fulfillment state, delivery promises, ownership, SLA timing, and a timeline.

The database has an internal UUID for joins, but operators and tools see only
the stable public order number, such as `ORD-1015`. Public numbers are unique
and allocated by Postgres; Faker generates content, not durable identity.

The valid static bearer token maps to the deterministic demo operator **John
Doe**. The client cannot submit an arbitrary `approvedBy` value. This is a
deliberate assignment-sized auth boundary: no OAuth, token issuing, expiry,
rotation, or user-management system is included.

For order confirmation, consistency is preferred over availability. The
provider uses a short `Serializable` transaction and `SELECT ... FOR UPDATE`
row locks so two operators cannot both apply a duplicate-order refund or
release the same reservation. Lock acquisition order is consistent and no
external call runs while the lock is held.

MCP diagnostic logging is not the business audit store. The durable source of
truth is `order_audit_events`, exposed through the read-only
`get_order_audit_log` tool. In a larger production system, an append-only event
broker such as Kafka and a transactional outbox would be a stronger delivery
boundary for downstream consumers. Pagination, richer retention controls,
lock contention metrics, and a full role-based auth layer remain future work.

## Verify the project

```bash
pnpm test       # unit tests, memory provider
pnpm smoke      # official MCP client over Streamable HTTP, memory provider
pnpm build      # generates Prisma client and compiles TypeScript
pnpm db:smoke   # explicit Supabase/Postgres integration check
```

The database smoke check verifies connectivity, idempotent bootstrap, public
order ids, proposal/confirm persistence, repeat-confirmation idempotency, and
audit retrieval without exposing internal UUIDs.

## Render deployment

Use:

```text
Build command: pnpm install --frozen-lockfile && pnpm build
Start command: pnpm start
```

Set these Render environment variables. Never commit their values:

```text
PERSISTENCE_MODE=postgres
DATABASE_URL=<Supabase session-mode pooler URL>
DIRECT_URL=<Supabase migration-capable URL>
PUBLIC_HOSTNAME=diligence-ai-order-ops-mcp.onrender.com
MCP_BEARER_TOKEN=<private random value>
```

Run `pnpm db:deploy` from a trusted local environment or migration job before
starting a new deployment. Render's service must be able to reach the chosen
database URL. Keep `/health` public for Render health checks; protect `/mcp`
with the static bearer token.

## Repository map

| Area | Location |
| --- | --- |
| HTTP, host validation, MCP route | `src/server.ts` |
| Validated `.env` configuration | `src/config/env.ts` |
| Static bearer auth and demo identity | `src/auth.ts` |
| MCP tool contracts | `src/tools/order-tools.ts` |
| Provider interface and memory implementation | `src/data/types.ts`, `src/data/store.ts` |
| Prisma client, schema, and migration | `src/data/database.ts`, `prisma/` |
| Durable provider and transaction logic | `src/data/postgres-store.ts` |
| Synthetic fixtures and Faker lifecycle | `src/data/seed.ts` |
| Tests and smoke checks | `test/`, `scripts/` |

See [AGENTS.md](AGENTS.md) for invariants and [db-plan.md](db-plan.md) for the
design record behind the persistence work.
