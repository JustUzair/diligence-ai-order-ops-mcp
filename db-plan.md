# Order Ops MCP: Durable Persistence Plan

Status: implementation in progress on `db-persistance`. This file remains the
design record for the Prisma/Postgres work; the final verification checklist
will be updated before the branch is pushed.

## Goal

Replace the process-local order store with durable PostgreSQL persistence so
that:

- seeded orders survive Render restarts and cold starts;
- each order has an internal UUID and a separate public `ORD-...` number;
- public order numbers are unique, persistent, and never reused;
- confirmed resolutions and audit events survive crashes;
- proposals remain available across MCP sessions;
- concurrent operators cannot apply conflicting changes to the same order;
- Faker creates synthetic records, but PostgreSQL becomes the source of truth.

The implementation keeps the data source behind `OrdersProvider`. The MCP
tools remain database-agnostic while `src/data/postgres-store.ts` supplies the
durable provider and `src/data/store.ts` supplies the test-friendly memory
provider.

## Recommended provider

Use Supabase Postgres with Prisma for this sprint. Neon is also technically
valid, but using both would add configuration and operational work without
improving this workflow.

Supabase's current Prisma guidance recommends using a dedicated database user
and explains that a project using Prisma alone can disable the Supabase Data
API. The application should connect directly through PostgreSQL rather than
through Supabase's REST layer.

References:

- [Supabase Prisma guide](https://supabase.com/docs/guides/database/prisma)
- [Supabase PostgreSQL connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Neon pooled connection URI](https://api-docs.neon.tech/reference/getconnectionuri)

## Connection strategy

The Render service is a persistent Node.js backend, not a serverless function.
The planned environment variables are:

```text
DATABASE_URL=<runtime application connection>
DIRECT_URL=<migration or administrative connection>
```

For an IPv4-only Render runtime, use Supabase's Supavisor session-mode
connection for application traffic. Session mode uses port `5432` and is
intended for persistent backends. Transaction mode uses port `6543` and is
primarily intended for short-lived or serverless workloads.

Use SSL for all database connections. Keep both URLs in local `.env` and the
Render environment only; never commit them.

The Prisma version and lockfile must be pinned when implementation begins.

## Proposed schema

The existing `Order` object contains a lot of nested synthetic commerce data.
To keep the first migration focused, store the complete domain object in a
JSONB payload while promoting fields needed for locking and queue queries to
regular columns.

### `orders`

Suggested fields:

- `id` — internal UUID primary key, never returned to MCP callers;
- `order_number` — public value such as `ORD-1015`, unique and stable;
- `order_sequence` — persistent numeric allocator for newly generated public
  order numbers;
- `status`, `payment_status`, `fulfillment_status` — queryable state fields;
- `priority`, `assigned_team` — queue fields;
- `is_active_exception`, `resolved_at` — queue and lifecycle fields;
- `version` — optimistic diagnostic/version marker;
- `data` — complete order payload as JSONB;
- `source` — `canonical_seed` or `generated_demo`;
- `seed_key` — stable key for canonical fixture identity;
- `created_at`, `updated_at` — database timestamps.

The scalar columns let the exception queue remain simple while the JSONB
payload preserves the current TypeScript shape. A later production provider
can normalize high-volume fields without changing the MCP contract.

The internal UUID is used for database joins and foreign keys. Tools accept and
return only `order_number` values such as `ORD-1015`. The UUID must not appear
in tool output, prompts, screenshots, audit responses, or error messages.

Canonical fixtures keep their existing public numbers. Newly generated orders
use a PostgreSQL-backed sequence or equivalent atomic allocator, then format
the result as `ORD-<number>`. Faker should create the order content, not
allocate public identifiers; a database uniqueness constraint is the final
guard against collisions.

### `resolution_proposals`

Suggested fields:

- `id` — `PROP-...`, primary key;
- `order_id` — foreign key to `orders`;
- `action` — database-validated allowlisted action;
- `rationale`, `evidence`, `expected_changes`, `risk`;
- `status` — `pending` or `confirmed`;
- `created_at`, `confirmed_at`;
- `approved_by` — server-side operator identity, currently `John Doe`;
- `confirmation_key` — unique key for idempotent confirmation.

The proposal remains inert until confirmation. The client cannot submit an
arbitrary action or operator identity.

### `order_audit_events`

Store one append-only row for every meaningful state transition:

- `id` — event UUID, primary key;
- `order_id` and optional `proposal_id`;
- `event_type` — for example `resolution_confirmed`;
- `actor_type`, `actor_id` — currently `operator` and `John Doe`;
- `occurred_at`;
- `before_state` and `after_state` as JSONB, or a compact state diff;
- `payload` as versioned JSONB;
- `request_id` or correlation ID.

Use rows instead of a mutable JSONB array on `orders`. Rows are easier to
query, retain, index, and protect from concurrent rewrites. The application
role should only insert audit events; updates and deletes should be denied or
blocked by a database-level policy/trigger.

### Viewing audit events through MCP

Add one small read-only tool such as `get_order_audit_log`:

- input: public `orderId` such as `ORD-1021`;
- output: chronological audit entries for that order;
- output fields: action, actor, timestamp, reason, proposal reference, and
  relevant before/after summary;
- no internal UUIDs, database connection details, bearer tokens, or raw SQL;
- no pagination in the first version because the assignment dataset is small.

This gives an operator or agent a direct way to answer “who did what, when, and
why” without a separate UI. It should be read-only and order-scoped rather
than exposing an unbounded database log endpoint.

MCP has a structured `notifications/message` logging utility, but it is not a
durable business audit store: clients may display or persist those
notifications, and the protocol does not provide historical audit-query
semantics. The logging utility is also deprecated in the `2026-07-28` protocol
line targeted by this repository. Do not build the business audit trail on it;
use `order_audit_events` and `get_order_audit_log` as the source of truth. [MCP
logging status](https://modelcontextprotocol.io/specification/draft/server/utilities/logging)

Supabase Logs Explorer and Postgres/pgAudit logs remain useful for infrastructure
and database troubleshooting, but they are not a replacement for the
application-level order audit table. [Supabase logging](https://supabase.com/docs/guides/telemetry/logs)

### `seed_metadata`

Track the canonical fixture version and bootstrap state:

- `dataset_name`;
- `dataset_version`;
- `seed_key`;
- `created_at`.

This prevents a server restart from treating a previously persisted dataset as
a new empty environment.

## Seed and Faker lifecycle

Faker is a data generator, not a persistence layer. The application should not
regenerate all canonical orders every time the process starts.

### Startup

1. Connect to PostgreSQL.
2. Run migrations before serving MCP traffic.
3. Check `seed_metadata` for the current dataset version.
4. Insert missing canonical fixtures by unique `seed_key` and public
   `order_number`.
5. Never overwrite an existing order during normal bootstrap.
6. Load orders, proposals, and audit events from PostgreSQL.

If a fixture changes later, handle it through an explicit migration or data
backfill. Do not silently overwrite an operator's confirmed resolution.

### On-demand synthetic failures

`simulate_new_failure` should run only when the operator explicitly asks for a
new synthetic failure. It should generate one order, allocate the next public
`ORD-...` number atomically, insert it, and return it only after the transaction
commits. The new row must include `source: generated_demo` and remain
available after a restart.

There is no need for an unlimited pre-generated dataset. This implementation
keeps the existing six varied exception scenarios so the take-home demo stays
small and legible. The database-backed provider can create more synthetic
failures explicitly, and startup never creates an already-seeded or
already-processed order again.

If the generation tool later accepts a caller-provided request key, store it
with a unique constraint so a retried request cannot create two orders. Without
such a key, each explicit successful tool call represents one new requested
synthetic order.

## Confirm transaction

`confirm_resolution` must remain the only state-changing MCP operation.

The implemented transaction is:

1. Begin a short database transaction.
2. Lock the proposal row for the supplied `proposalId`.
3. Load the associated order and lock it with `SELECT ... FOR UPDATE`.
4. Re-check that the proposal is pending.
5. Re-check the order's current state and the action's server-side
   preconditions.
6. Apply exactly one allowlisted action.
7. Update the order payload and queryable state columns.
8. Insert one immutable audit event containing the actor, proposal, action,
   timestamp, and before/after evidence.
9. Mark the proposal confirmed and store the confirmation result.
10. Commit all changes together.

No LLM call, external API call, or slow operation should run while the order
lock is held.

PostgreSQL holds row locks until the transaction ends. A conflicting operator
therefore waits rather than reading and mutating stale state. [PostgreSQL
explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
documents this behavior and also notes that deadlocks can occur if transactions
acquire locks in inconsistent orders.

Every confirmation path must acquire locks in the same order and keep the
transaction short. Lock timeouts and serialization failures must return a
non-success response without applying a partial change.

### Pessimistic locking decision

PostgreSQL provides an out-of-the-box pessimistic row lock through
`SELECT ... FOR UPDATE`; this is not inherently a future-only feature. Prisma
provides the transaction API, but the exact Prisma version may require a
parameterized raw SQL query inside the interactive transaction for the locking
clause. This has been exercised against the configured Supabase connection
with Prisma 7.

If future changes introduce a different connection mode or transaction shape,
the lock behavior must be re-tested before presenting the confirmation path as
multi-operator safe.

The primary race this prevents is two operators confirming the same duplicate
order and processing the refund or inventory release twice. The database
transaction, proposal status, unique confirmation key, and audit constraint
must work together; a lock alone is not idempotency.

## Idempotency

The database must make confirmation safe to retry.

The first successful confirmation stores a unique confirmation key and result.
A repeated request for the same proposal should return the stored result or a
clear `already_confirmed` result without applying the action again or creating
another audit record.

This is a deliberate change from the current in-memory double-confirm
rejection. The important invariant is that a retry cannot duplicate the
mutation, refund, inventory release, or audit event.

Unknown proposals, expired proposals, stale order state, and actions that no
longer satisfy their preconditions must fail safely.

Prisma supports interactive transactions with configurable timeouts, wait
limits, and PostgreSQL isolation levels including `Serializable`. [Prisma
transaction documentation](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions)

## Consistency and availability policy

The correct CAP statement for this service is narrow:

> During database contention or a network partition, the confirm write path
> prioritizes consistency and operational safety over availability.

CAP describes a tradeoff during a network partition; it does not mean every
read must be unavailable. The practical policy is:

- reads come from the primary PostgreSQL database;
- writes require a successful transaction and current row lock;
- database outage, lock timeout, or unresolved serialization failure means no
  mutation and no success response;
- the operator can retry after the database is healthy.

This is appropriate for a cancellation, refund, inventory release, or
fulfillment action where a false success is more dangerous than a temporary
failure.

## Audit evolution: database first, broker later

For this sprint, PostgreSQL is the durable audit store. Each confirmed action
creates a JSONB-backed audit event in the same transaction as the order change.

For a larger commerce platform, an event broker such as Kafka can distribute
append-only operational events to analytics, fraud, customer support, and
reconciliation consumers. The safer evolution is a transactional outbox:

1. Commit the order change, audit event, and an `outbox_events` row together.
2. A worker publishes the outbox event to Kafka.
3. The worker records delivery state and retries safely.

This avoids a dual-write gap where PostgreSQL commits but the broker publish
fails.

## Supabase security boundaries

- Keep PostgreSQL credentials in Render environment variables.
- Use a dedicated database role for Prisma with only the required schema
  privileges.
- Do not expose the tables through the Supabase Data API unless that is an
  intentional future design.
- If tables remain in an exposed schema, enable RLS and define policies that
  match the actual access model. Supabase states that RLS must be enabled for
  tables in exposed schemas and that access grants are separate from row
  policies. [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security)
- Never put a database URL, password, or Supabase service credential in Git.

The MCP server's static bearer token remains the application boundary. This
database plan does not add OAuth, per-user Supabase Auth, or user management.

## Implementation status

Implemented on `db-persistance`:

1. Pinned Prisma/Postgres dependencies, centralized database environment
   settings, schema, client lifecycle, and migration commands.
2. Idempotent canonical seeding and database-backed public order-number
   allocation for explicit synthetic failures.
3. A PostgreSQL `OrdersProvider` that preserves the tool contract and keeps
   internal UUIDs out of MCP output.
4. Persisted proposals, serializable confirmation transactions, row locks,
   idempotent confirmation, and append-only audit events.
5. The read-only `get_order_audit_log` tool.
6. Unit, memory smoke, and real Supabase/Postgres smoke verification.
7. README, Render environment, and operator setup documentation.

The remaining verification is deployment-specific: apply the migration and
configure `PERSISTENCE_MODE=postgres`, `DATABASE_URL`, and `DIRECT_URL` in the
Render service before redeploying.

The completed README must explicitly document:

- the internal UUID versus public `ORD-...` identifier boundary;
- restart-safe canonical seeding and explicit on-demand generation;
- persisted proposals and JSONB-backed audit events;
- the `get_order_audit_log` MCP tool and its no-pagination assumption;
- the tested pessimistic-locking and idempotency behavior;
- the consistency-over-availability policy for critical writes;
- Kafka and a transactional outbox as a future production evolution;
- pagination, richer operator identity, and other deferred improvements.

## Small database smoke test

The repository now has `pnpm db:smoke`, backed by a small script. It requires
`DATABASE_URL`; run it against a dedicated or disposable test database rather
than a production dataset.

The check should verify only the important database path:

1. Prisma can connect and run a simple query.
2. The expected tables exist.
3. Seed bootstrap is idempotent: running it twice does not duplicate public
   `ORD-...` values.
4. A proposal can be stored and read by public order number.
5. A confirmation creates one audit row and a repeated confirmation does not
   create a second one.
6. `get_order_audit_log` returns the action, actor, timestamp, and reason while
   hiding internal UUIDs.

The script uses clearly synthetic records and is intentionally small. It does
not need a UI, a full performance test, or pagination coverage.

## Verification checklist

- Restart the service and verify resolved orders remain resolved.
- Restart the service and verify audit events and pending proposals remain.
- Run bootstrap twice and verify no duplicate canonical orders.
- Generate a new synthetic failure, restart, and find it again.
- Send two concurrent confirmations for one proposal.
- Retry the same confirmation after a successful response.
- Force a failure after the order update but before commit and verify rollback.
- Verify exactly one audit event exists for a confirmed proposal.
- Verify a stale or unsupported proposal cannot mutate an order.
- Verify lock timeout and database outage fail without reporting success.
- Verify audit event rows cannot be updated or deleted through the application
  role.
- Verify the database smoke test runs successfully with the configured
  connection and fails clearly when `DATABASE_URL` is missing.

## Decisions made

1. Use Supabase Postgres with Prisma; Neon remains a compatible future option.
2. Keep the existing six varied exception scenarios for a focused demo, and
   create additional failures only through an explicit tool request.
3. Use a database UUID plus a unique public incremental `ORD-...` number, with
   only the public number exposed through MCP.
4. Use the JSONB-backed domain payload with indexed scalar columns for the
   first migration.
5. Make repeated confirmation return the original result rather than the
   previous double-confirm error.
6. Keep the fixed `John Doe` operator identity until per-operator auth is
   explicitly added later.
7. Keep Kafka and the transactional outbox as documented production evolution,
   rather than adding a broker to this assignment sprint.
