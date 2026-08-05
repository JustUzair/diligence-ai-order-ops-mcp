import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "test-bearer-token";

type AuthResult = {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  next: ReturnType<typeof vi.fn>;
};

async function runMiddleware(authorization?: string): Promise<AuthResult> {
  const { createBearerAuthMiddleware } = await import("../src/auth.js");
  const result: AuthResult = {
    statusCode: 200,
    headers: {},
    next: vi.fn(),
  };
  const response = {
    setHeader(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
      return response;
    },
    status(code: number) {
      result.statusCode = code;
      return response;
    },
    json(body: unknown) {
      result.body = body;
      return response;
    },
  } as unknown as Response;
  const request = {
    get(name: string) {
      return name.toLowerCase() === "authorization" ? authorization : undefined;
    },
  } as unknown as Request;

  createBearerAuthMiddleware()(request, response, result.next);
  return result;
}

afterEach(() => {
  delete process.env.MCP_BEARER_TOKEN;
});

beforeEach(() => {
  vi.resetModules();
});

describe("bearer authentication", () => {
  it("fails closed when the token is not configured", async () => {
    // Keep dotenv from rehydrating a developer's private local token for this case.
    process.env.MCP_BEARER_TOKEN = "";
    const result = await runMiddleware();
    expect(result.statusCode).toBe(503);
    expect(result.body).toEqual({ error: "MCP authentication unavailable" });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("rejects missing and incorrect bearer tokens with the standard challenge", async () => {
    process.env.MCP_BEARER_TOKEN = TEST_TOKEN;

    const missing = await runMiddleware();
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");

    const incorrect = await runMiddleware("Bearer wrong-token");
    expect(incorrect.statusCode).toBe(401);
    expect(incorrect.body).toEqual({ error: "Unauthorized" });
  });

  it("allows the configured bearer token through", async () => {
    process.env.MCP_BEARER_TOKEN = TEST_TOKEN;
    const result = await runMiddleware(`Bearer ${TEST_TOKEN}`);
    expect(result.statusCode).toBe(200);
    expect(result.next).toHaveBeenCalledOnce();
  });
});
