import {
  createMcpExpressApp,
} from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import type { Express } from "express";
import { createBearerAuthMiddleware } from "./auth.js";
import { env } from "./config/env.js";
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
 * Caller authentication uses one deployment-configured bearer token. This is
 * deliberately a shared-secret boundary, not OAuth or user management.
 *
 * What IS in place today: hostHeaderValidation below (DNS-rebinding
 * protection at the transport layer) — a different concern from "who is
 * allowed to call this server," and one that costs nothing to include now.
 */
export function buildApp(): Express {
  const allowedHost = env.PUBLIC_HOSTNAME;
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

  app.post("/mcp", createBearerAuthMiddleware(), async (req, res) => {
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
