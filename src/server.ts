import {
  createMcpExpressApp,
} from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import type { Express, NextFunction, Request, Response } from "express";
import { getOrdersProvider } from "./data/store.js";
import { registerOrderTools } from "./tools/order-tools.js";
import {
  LOCAL_ALLOWED_HOSTS,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "./constants.js";

/**
 * SECURITY BASELINE (see AGENTS.md for the full statement)
 * ----------------------------------------------------------------
 * Caller authentication is intentionally NOT implemented in this sprint —
 * it's scoped as a deliberate backfill once the core workflow is proven.
 * This middleware is the seam where it plugs in later: swap the body for
 * `requireBearerAuth({ verifier })` from @modelcontextprotocol/express,
 * which this project already depends on. Nothing else in server.ts or
 * src/tools needs to change when that happens.
 *
 * What IS in place today: hostHeaderValidation below (DNS-rebinding
 * protection at the transport layer) — a different concern from "who is
 * allowed to call this server," and one that costs nothing to include now.
 */
function authPlaceholder(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next();
}

export function buildApp(): Express {
  const allowedHost = process.env.PUBLIC_HOSTNAME?.trim();
  const allowedHosts = allowedHost
    ? [allowedHost, ...LOCAL_ALLOWED_HOSTS]
    : undefined;

  // The adapter defaults to localhost validation. Render forwards the public
  // hostname to the process, so opt into non-localhost mode and provide the
  // explicit production allowlist through the adapter itself.
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });

  if (!allowedHost) {
    // eslint-disable-next-line no-console
    console.warn(
      "[order-ops-mcp] PUBLIC_HOSTNAME is not set — skipping host-header validation. " +
        "Set it once deployed (see README).",
    );
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: SERVICE_NAME });
  });

  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  registerOrderTools(server, getOrdersProvider());

  app.post("/mcp", authPlaceholder, async (req, res) => {
    // Stateless: a fresh transport per request. Sessions aren't needed for
    // this workflow — every tool call is self-contained given an orderId
    // or proposalId, so there's no per-connection state worth keeping.
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
