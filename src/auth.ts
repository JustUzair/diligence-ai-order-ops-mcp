import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "./config/env.js";

export const AUTHENTICATED_OPERATOR = "John Doe";

const unauthorizedMessage = "Unauthorized";

function tokensMatch(expectedToken: string, suppliedToken: string): boolean {
  // Hashing first gives timingSafeEqual fixed-length buffers, including when
  // a malformed caller supplies a token with a different length.
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  const suppliedDigest = createHash("sha256").update(suppliedToken).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function rejectUnauthorized(res: Parameters<RequestHandler>[1]): void {
  res.setHeader("WWW-Authenticate", "Bearer");
  res.status(401).json({ error: unauthorizedMessage });
}

/**
 * Protects the MCP route with one deployment-configured bearer token.
 *
 * The configured token is captured when the app is built, so changing it
 * requires the same restart/redeploy as any other deployment environment
 * change. Missing configuration fails closed while leaving /health available.
 */
export function createBearerAuthMiddleware(): RequestHandler {
  const expectedToken = env.MCP_BEARER_TOKEN;

  if (!expectedToken) {
    // eslint-disable-next-line no-console
    console.error("[order-ops-mcp] MCP_BEARER_TOKEN is not configured; /mcp is disabled.");
    return (_req, res) => {
      res.status(503).json({ error: "MCP authentication unavailable" });
    };
  }

  return (req, res, next) => {
    const authorization = req.get("authorization");
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);

    if (!match || !tokensMatch(expectedToken, match[1])) {
      rejectUnauthorized(res);
      return;
    }

    next();
  };
}
