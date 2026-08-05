import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { AUTHENTICATED_OPERATOR } from "../auth.js";
import { ResolutionRisk, type OrdersProvider } from "../data/types.js";
import { exceptionSummary, exceptionType } from "../data/store.js";
import { suggestResolution } from "../data/playbook.js";
import { MILLISECONDS_PER_MINUTE } from "../constants.js";

export function registerOrderTools(server: McpServer, orders: OrdersProvider): void {
  server.registerTool(
    "list_order_exceptions",
    {
      title: "List order exceptions",
      description:
        "Returns every order currently in a state that needs human attention: payment declined with " +
        "inventory still held, fulfillment on hold or incomplete, or a likely duplicate order. This is the " +
        "starting point for 'what's broken right now' — call this before get_order_details when you don't " +
        "already have a specific order id. Read-only, safe to call at any time.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        count: z.number(),
        exceptions: z.array(
          z.object({
            orderId: z.string(),
            customerName: z.string(),
            createdAt: z.string(),
            exceptionType: z.string(),
            priority: z.string(),
            assignedTeam: z.string(),
            exceptionAgeMinutes: z.number(),
            responseSlaBreached: z.boolean(),
            orderValueCents: z.number(),
            currency: z.string(),
            summary: z.string(),
          }),
        ),
      }),
    },
    async () => {
      const now = Date.now();
      const exceptions = orders.listExceptions().map((order) => {
        const detectedAt = order.operations.exceptionDetectedAt ?? order.createdAt;
        return {
          orderId: order.id,
          customerName: order.customerName,
          createdAt: order.createdAt,
          exceptionType: exceptionType(order),
          priority: order.operations.priority,
          assignedTeam: order.operations.assignedTeam,
          exceptionAgeMinutes: Math.max(
            0,
            Math.floor((now - new Date(detectedAt).getTime()) / MILLISECONDS_PER_MINUTE),
          ),
          responseSlaBreached: order.operations.responseDueAt
            ? new Date(order.operations.responseDueAt).getTime() < now
            : false,
          orderValueCents: order.totalCents,
          currency: order.currency,
          summary: exceptionSummary(order),
        };
      });
      const output = { count: exceptions.length, exceptions };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_order_details",
    {
      title: "Get order details",
      description:
        "Returns full diagnostic detail for one order: customer and channel context, payment attempts and " +
        "decline advice, per-SKU inventory allocation, fulfillment/carrier state, delivery promises, duplicate " +
        "signals, operational SLA ownership, line items, and the complete event timeline. " +
        "Use this to understand *why* an order showed up in list_order_exceptions before proposing a fix. " +
        "Read-only.",
      inputSchema: z.object({ orderId: z.string().describe("e.g. ORD-1042") }),
    },
    async ({ orderId }) => {
      const order = orders.getOrder(orderId);
      if (!order) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `No order found with id ${orderId}.` }],
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(order, null, 2) }] };
    },
  );

  server.registerTool(
    "propose_resolution",
    {
      title: "Propose a resolution",
      description:
        "Looks at one order's exception pattern and returns a suggested fix with a plain-language reason. " +
        "This DOES NOT change anything — it only returns a proposalId. Nothing is applied until a human " +
        "calls confirm_resolution with that id. Use this after get_order_details, once you understand what's " +
        "wrong. If the order doesn't match a known pattern, the suggestion will be to escalate to a human " +
        "rather than guess.",
      inputSchema: z.object({ orderId: z.string() }),
      outputSchema: z.object({
        proposalId: z.string(),
        orderId: z.string(),
        action: z.string(),
        rationale: z.string(),
        evidence: z.array(z.string()),
        expectedChanges: z.array(z.string()),
        risk: z.enum([
          ResolutionRisk.LOW,
          ResolutionRisk.MEDIUM,
          ResolutionRisk.HIGH,
        ]),
      }),
    },
    async ({ orderId }) => {
      const order = orders.getOrder(orderId);
      if (!order) {
        return { isError: true, content: [{ type: "text" as const, text: `No order found with id ${orderId}.` }] };
      }
      const suggestion = suggestResolution(order);
      const proposal = orders.proposeResolution(orderId, suggestion.action, suggestion.rationale, {
        evidence: suggestion.evidence,
        expectedChanges: suggestion.expectedChanges,
        risk: suggestion.risk,
      });
      const output = {
        proposalId: proposal.id,
        orderId,
        action: proposal.action,
        rationale: proposal.rationale,
        evidence: proposal.evidence,
        expectedChanges: proposal.expectedChanges,
        risk: proposal.risk,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "confirm_resolution",
    {
      title: "Confirm a proposed resolution",
      description:
        "Applies a previously proposed fix. Requires the exact proposalId returned by propose_resolution — " +
        "there is no way to change order state through this server without going through that proposal step " +
        "first. The authenticated shared bearer token maps to the server-side demo operator identity used in " +
        "the audit timeline; caller-supplied operator names are not accepted. Fails loudly if the proposal is " +
        "unknown or was already confirmed.",
      inputSchema: z.object({
        proposalId: z.string(),
      }),
      outputSchema: z.object({
        proposalId: z.string(),
        orderId: z.string(),
        proposalStatus: z.literal("confirmed"),
        appliedAction: z.string(),
        approvedBy: z.literal(AUTHENTICATED_OPERATOR),
        orderStatus: z.string(),
        paymentStatus: z.string(),
        fulfillmentStatus: z.string(),
        exceptionStillActive: z.boolean(),
      }),
    },
    async ({ proposalId }) => {
      try {
        const { order, proposal } = orders.confirmResolution(proposalId, AUTHENTICATED_OPERATOR);
        const output = {
          proposalId: proposal.id,
          orderId: order.id,
          proposalStatus: "confirmed" as const,
          appliedAction: proposal.action,
          approvedBy: AUTHENTICATED_OPERATOR,
          orderStatus: order.status,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          exceptionStillActive: !order.operations.resolvedAt,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  );

  server.registerTool(
    "simulate_new_failure",
    {
      title: "Simulate a new order failure",
      description:
        "Demo/testing helper only — injects one freshly broken synthetic order into the dataset so you can " +
        "show the diagnosis loop working on something list_order_exceptions hasn't returned before. Not part " +
        "of the core workflow; a real deployment would remove this tool and receive exceptions from actual " +
        "order events instead.",
      inputSchema: z.object({}),
    },
    async () => {
      const order = orders.injectFailure();
      return {
        content: [
          { type: "text" as const, text: `Injected ${order.id}: ${exceptionSummary(order)}` },
        ],
      };
    },
  );
}
