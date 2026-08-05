# AGENTS.md

## Purpose

Orientation for any agent (or human) picking up this repo. States what this
project actually is, what's being evaluated, and which decisions are already
made versus still open. Read this before changing anything.

## Sources of truth

- Assignment brief: "Take-Home Assignment — AI-First Commerce Operations
  Challenge" (Notion doc shared over email — see README for the workflow
  this repo commits to).
- MCP spec: https://modelcontextprotocol.io — this project targets the
  **2026-07-28** spec.
- MCP TypeScript SDK: this project uses **`@modelcontextprotocol/server` v2**
  (plus the `@modelcontextprotocol/express` and `@modelcontextprotocol/node`
  adapters), **not** the legacy monolithic `@modelcontextprotocol/sdk` v1
  package. If you're an agent and your training data suggests importing from
  `@modelcontextprotocol/sdk`, that's the old package — don't "fix" the
  imports back to it. See "Key decisions" below for why this matters.

## Scope and delivery priorities

In priority order:

1. The MCP tool surface — `list_order_exceptions → get_order_details →
propose_resolution → confirm_resolution` — works correctly and each tool's
   `description` is written for an LLM caller deciding whether/how to use it.
2. The safety pattern is airtight: nothing mutates order state except
   `confirm_resolution`, and only against a proposal that actually exists
   and hasn't already been used.
3. Everything else (extra tools, polish, deployment niceties).

Explicitly **out of scope** this sprint: frontend, a complete commerce
backend, complex CI/CD, OAuth, and user-management infrastructure — see
Security baseline.

## Domain language

- **Exception** — an order in a state that needs a decision: payment
  declined with inventory still held, fulfillment on hold, fulfillment
  incomplete, or a likely duplicate order.
- **Proposal** — a suggested fix returned by `propose_resolution`. Inert
  until confirmed; carries a `proposalId`.
- **Confirm** — the only path by which order state changes. Always requires
  a `proposalId` and records who approved it in the order's timeline.

Failure vocabulary (`CancelReason`, fulfillment hold `reason`) mirrors
Shopify's public taxonomy on purpose — see README "Synthetic data and limits".

## Non-negotiable invariants

- No tool mutates order state directly. Only `confirm_resolution` mutates,
  and only against a `pending` proposal.
- No real customer data, no production credentials, no live commerce-platform
  calls anywhere in this repo. Everything is synthetic and generated
  in-process (`src/data/seed.ts`).
- Every `registerTool` call has a `description` a model can act on without
  additional docs — that's the actual UX surface for this product.

## Security baseline

- **Caller authentication: implemented as one static bearer token.** Every
  `POST /mcp` request requires `MCP_BEARER_TOKEN`; `GET /health` remains public.
  The token maps to the deterministic demo operator `John Doe`, so
  `confirm_resolution` does not accept an arbitrary caller-supplied operator
  name. Missing configuration fails closed for `/mcp` while keeping health
  checks available. OAuth, expiry, rotation, issuance, and user management are
  deliberately excluded by the assignment scope.
- **Host-header validation: implemented.** DNS-rebinding protection via
  `hostHeaderValidation`, gated on the `PUBLIC_HOSTNAME` env var. This is a
  different, cheaper concern than "who's allowed to call this," and there's
  no reason to defer it too.
- **Known dependency advisory:** `@modelcontextprotocol/node` pulls in
  `@hono/node-server`, which has a moderate path-traversal advisory in its
  static-file-serving middleware (Windows-only, via an encoded backslash).
  This project never uses that middleware. Checked via `npm audit`,
  confirmed not applicable, not blocking.

## Local development and deployment

```bash
pnpm install
MCP_BEARER_TOKEN=<local-private-value> pnpm dev  # tsx watch, http://localhost:3000
pnpm test       # unit tests (vitest)
pnpm smoke      # real end-to-end check against a live server
pnpm build && pnpm start   # production path — what the host runs
```

See README.md for the Render deployment steps.

## Testing expectations

- `pnpm test` — unit tests for the resolution playbook, enriched synthetic
  fixtures, and the store's propose→confirm safety flow (double-confirm
  rejection, unknown-proposal rejection, no-mutation-before-confirm, and
  resolved-versus-escalated queue behavior).
- `pnpm smoke` — boots the real server and drives it with the actual
  `@modelcontextprotocol/client` over Streamable HTTP: initialize handshake,
  bearer-auth rejection paths, every tool, and both workflow error paths. Run this after touching `src/server.ts` or
  `src/tools/*` — unit tests alone don't catch wire-level mistakes.

## Time-box fallbacks

- Keep the bearer token out of the repository, README, screenshots, demos,
  commit history, and issue tracker. Set it locally or in Render’s environment
  settings and share it with a reviewer only out of band if they need to test
  the hosted endpoint.
- If a real Shopify dev-store integration was attempted and isn't stable by
  submission time: fall back to the in-memory mock, which is already the
  default behind `OrdersProvider`. A half-working integration should never
  replace a fully-working mock.

## Change discipline

Keep the data source behind `OrdersProvider` (`src/data/store.ts`).
Anything that wants to call a real backend implements that interface; tool
code in `src/tools` never changes as a result.

## Key decisions (feeds the AI worklog)

- **SDK version**: chose `@modelcontextprotocol/server` v2 over the more
  commonly-referenced `@modelcontextprotocol/sdk` v1 after installing both
  and reading their actual shipped type declarations — v1 is still `latest`
  under its old package name, which makes it an easy trap for an agent (or a
  human) to fall into by habit. v2 is the line aligned with the current spec.
- **Auth**: one shared bearer token was added after reviewer guidance;
  OAuth/user-management infrastructure remains intentionally out of scope.
- **Data source**: in-memory mock seeded with Shopify's real
  `OrderCancelReason` / fulfillment-hold-reason vocabulary, not a live
  Shopify dev store — see README "Synthetic data and limits" for the reasoning.
- **Synthetic dataset**: fixed Faker seed with 21 repeatable orders and six
  active exception scenarios. Enrichment is limited to evidence the existing
  diagnosis workflow can use; it does not introduce a second product surface.

## Definition of done

- `pnpm test` and `pnpm smoke` both green.
- Deployed health check responds and authenticated `POST /mcp` requests work.
- README has setup, usage, and decisions/assumptions/exclusions filled in.
