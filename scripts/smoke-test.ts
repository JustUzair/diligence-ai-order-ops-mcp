/**
 * End-to-end smoke test. Boots the real server on an ephemeral port and
 * talks to it with the official MCP client over actual Streamable HTTP —
 * this is deliberately separate from the vitest unit tests, which only
 * exercise internal functions directly. Run with: npm run smoke
 */
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Test-only fallback; never use this value for a deployed service.
const SMOKE_TEST_TOKEN = "smoke-test-token";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  assert(block?.text, "expected a text content block");
  return block.text;
}

async function main(): Promise<void> {
  // Unit-style smoke defaults to memory. Set SMOKE_PERSISTENCE_MODE=postgres
  // when you intentionally want to drive the configured database over MCP.
  process.env.PERSISTENCE_MODE = process.env.SMOKE_PERSISTENCE_MODE ?? "memory";
  const smokeToken = process.env.MCP_BEARER_TOKEN ?? SMOKE_TEST_TOKEN;
  process.env.MCP_BEARER_TOKEN = smokeToken;
  const { buildApp } = await import("../src/server.js");
  const app = await buildApp();
  const httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("failed to bind server");
  const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

  let passed = 0;
  const step = (label: string) => {
    passed += 1;
    console.log(`  ✓ ${label}`);
  };

  const unauthorized = await fetch(baseUrl, { method: "POST", body: "{}" });
  assert(unauthorized.status === 401, `expected missing bearer token to return 401, got ${unauthorized.status}`);
  assert(unauthorized.headers.get("www-authenticate") === "Bearer", "expected WWW-Authenticate bearer challenge");
  step("unauthenticated MCP requests are rejected with 401");

  const wrongToken = await fetch(baseUrl, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
    body: "{}",
  });
  assert(wrongToken.status === 401, `expected wrong bearer token to return 401, got ${wrongToken.status}`);
  step("MCP requests with the wrong bearer token are rejected");

  const client = new Client({ name: "smoke-test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(baseUrl, {
    requestInit: { headers: { Authorization: `Bearer ${smokeToken}` } },
  });

  try {
    await client.connect(transport);
    step("initialize handshake succeeded");

    const listResult = await client.callTool({ name: "list_order_exceptions", arguments: {} });
    assert(!listResult.isError, "list_order_exceptions should not error");
    const listOutput = listResult.structuredContent as { count: number; exceptions: Array<{ orderId: string }> };
    assert(listOutput.count >= 4, `expected at least 4 seeded exceptions, got ${listOutput.count}`);
    step(`list_order_exceptions returned ${listOutput.count} exceptions`);

    const target = listOutput.exceptions.find((e) => e.orderId)!;
    const detail = await client.callTool({
      name: "get_order_details",
      arguments: { orderId: target.orderId },
    });
    assert(!detail.isError, "get_order_details should not error for a real order id");
    const detailBeforeProposal = textOf(detail);
    step(`get_order_details returned detail for ${target.orderId}`);

    const bogusDetail = await client.callTool({
      name: "get_order_details",
      arguments: { orderId: "ORD-DOES-NOT-EXIST" },
    });
    assert(bogusDetail.isError, "get_order_details should report an error for an unknown order id");
    step("get_order_details correctly reports isError for an unknown order id");

    const proposeResult = await client.callTool({
      name: "propose_resolution",
      arguments: { orderId: target.orderId },
    });
    assert(!proposeResult.isError, "propose_resolution should not error");
    const proposal = proposeResult.structuredContent as {
      proposalId: string;
      action: string;
      evidence: string[];
      expectedChanges: string[];
      risk: string;
    };
    assert(proposal.proposalId?.startsWith("PROP-"), "expected a PROP- prefixed proposal id");
    assert(proposal.evidence.length > 0, "proposal should explain the evidence it used");
    assert(proposal.expectedChanges.length > 0, "proposal should disclose expected state changes");
    assert(["low", "medium", "high"].includes(proposal.risk), "proposal should include a risk level");
    step(`propose_resolution suggested "${proposal.action}" (proposalId ${proposal.proposalId})`);

    const beforeConfirm = await client.callTool({
      name: "get_order_details",
      arguments: { orderId: target.orderId },
    });
    assert(
      textOf(beforeConfirm) === detailBeforeProposal,
      "order should be byte-for-byte unchanged before confirmation",
    );
    step("order is unchanged before confirm_resolution is called (proposal-only, as designed)");

    const confirmResult = await client.callTool({
      name: "confirm_resolution",
      arguments: { proposalId: proposal.proposalId },
    });
    assert(!confirmResult.isError, "confirm_resolution should not error on first confirmation");
    const confirmation = confirmResult.structuredContent as { approvedBy: string };
    assert(confirmation.approvedBy === "John Doe", "confirmation should use the server-side operator identity");
    step("confirm_resolution applied the proposed action");

    const afterConfirmList = (
      await client.callTool({ name: "list_order_exceptions", arguments: {} })
    ).structuredContent as { exceptions: Array<{ orderId: string }> };
    assert(
      !afterConfirmList.exceptions.some((exception) => exception.orderId === target.orderId),
      "resolved order should leave the active exception queue",
    );
    step("resolved order no longer appears in list_order_exceptions");

    const repeatConfirm = await client.callTool({
      name: "confirm_resolution",
      arguments: { proposalId: proposal.proposalId },
    });
    assert(!repeatConfirm.isError, "re-confirming the same proposal should be idempotent");
    step("confirm_resolution returns the recorded result on repeat confirmation");

    const auditResult = await client.callTool({
      name: "get_order_audit_log",
      arguments: { orderId: target.orderId },
    });
    assert(!auditResult.isError, "get_order_audit_log should return the order audit trail");
    const audit = auditResult.structuredContent as { count: number; entries: Array<{ eventType: string }> };
    assert(audit.count >= 2, "audit trail should include proposal and confirmation events");
    assert(audit.entries.some((entry) => entry.eventType === "resolution_confirmed"), "audit should record confirmation");
    step(`get_order_audit_log returned ${audit.count} durable-style audit entries`);

    const beforeInject = (
      (await client.callTool({ name: "list_order_exceptions", arguments: {} })).structuredContent as {
        count: number;
      }
    ).count;
    const injectResult = await client.callTool({ name: "simulate_new_failure", arguments: {} });
    assert(!injectResult.isError, "simulate_new_failure should not error");
    const afterInject = (
      (await client.callTool({ name: "list_order_exceptions", arguments: {} })).structuredContent as {
        count: number;
      }
    ).count;
    assert(afterInject === beforeInject + 1, `expected exception count to grow by 1 (${beforeInject} -> ${afterInject})`);
    step(`simulate_new_failure grew the exception list from ${beforeInject} to ${afterInject}`);

    console.log(`\nAll ${passed} smoke-test checks passed against a live server on port ${address.port}.`);
    process.exitCode = 0;
  } catch (error) {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  } finally {
    await transport.close?.().catch(() => undefined);
    httpServer.close();
  }
}

main();
