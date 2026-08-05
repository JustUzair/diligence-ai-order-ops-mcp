import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import {
  ResolutionRisk,
  type AuditLogEntry,
  type ExceptionType,
  type Order,
  type OrdersProvider,
  type ResolutionAction,
  type ResolutionProposal,
  isResolutionAction,
} from "./types.js";
import { generateOneFailure, generateSeedOrders } from "./seed.js";

/**
 * Everything a diagnosis/resolution tool needs from a data source. The
 * in-memory implementation below is what ships for this assignment; a
 * Shopify-backed implementation could satisfy the same interface without
 * any change to src/tools/*.
 */
export function isException(order: Order): boolean {
  if (order.operations.resolvedAt) return false;
  return (
    order.status === "cancelled" ||
    order.fulfillmentStatus === "on_hold" ||
    order.fulfillmentStatus === "incomplete" ||
    (order.paymentStatus === "declined" && order.inventoryReserved) ||
    Boolean(order.possibleDuplicateOf)
  );
}

export function exceptionType(order: Order): ExceptionType {
  if (order.possibleDuplicateOf) return "possible_duplicate";
  if (order.paymentStatus === "declined" && order.inventoryReserved) {
    return "declined_payment_inventory_held";
  }
  if (order.fulfillmentStatus === "on_hold") return "fulfillment_hold";
  if (order.fulfillmentStatus === "incomplete") return "incomplete_fulfillment";
  return "cancelled_order";
}

export function exceptionSummary(order: Order): string {
  if (order.possibleDuplicateOf) return `possible duplicate of ${order.possibleDuplicateOf}`;
  if (order.paymentStatus === "declined" && order.inventoryReserved) {
    return `payment declined (${order.paymentFailureMessage ?? "no reason given"}), inventory still held`;
  }
  if (order.fulfillmentStatus === "on_hold") {
    return `fulfillment on hold: ${order.fulfillmentHoldReason ?? "unknown"}`;
  }
  if (order.fulfillmentStatus === "incomplete") {
    return "fulfillment service failed to complete";
  }
  if (order.status === "cancelled") {
    return `cancelled: ${order.cancelReason ?? "OTHER"}`;
  }
  return "no known exception";
}

class InMemoryOrdersProvider implements OrdersProvider {
  private orders = new Map<string, Order>();
  private proposals = new Map<string, ResolutionProposal>();
  private auditLogs = new Map<string, AuditLogEntry[]>();

  constructor(seed: Order[]) {
    for (const order of seed) this.orders.set(order.id, order);
  }

  async listExceptions(): Promise<Order[]> {
    return [...this.orders.values()].filter(isException);
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    return this.orders.get(orderId);
  }

  async getAuditLog(orderId: string): Promise<AuditLogEntry[]> {
    return [...(this.auditLogs.get(orderId) ?? [])];
  }

  async proposeResolution(
    orderId: string,
    action: ResolutionAction,
    rationale: string,
    context = { evidence: [], expectedChanges: [], risk: ResolutionRisk.LOW },
  ): Promise<ResolutionProposal> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);
    if (!isException(order)) throw new Error(`Order ${orderId} is no longer an active exception.`);
    if (!isResolutionAction(action)) throw new Error(`Unsupported resolution action: ${action}`);
    const proposal: ResolutionProposal = {
      id: `PROP-${randomUUID().slice(0, 8)}`,
      orderId,
      action,
      rationale,
      evidence: context.evidence,
      expectedChanges: context.expectedChanges,
      risk: context.risk,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.proposals.set(proposal.id, proposal);
    this.appendAudit(orderId, {
      eventType: "resolution_proposed",
      actorType: "system",
      actorId: "order-ops-mcp",
      reason: rationale,
      occurredAt: proposal.createdAt,
      payload: { proposalId: proposal.id, action: proposal.action, risk: proposal.risk },
    });
    return proposal;
  }

  async confirmResolution(
    proposalId: string,
    approvedBy = "unknown",
  ): Promise<{ order: Order; proposal: ResolutionProposal }> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`No such proposal: ${proposalId}`);
    if (proposal.status === "confirmed") {
      const confirmedOrder = this.orders.get(proposal.orderId);
      if (!confirmedOrder) throw new Error(`No such order: ${proposal.orderId}`);
      return { order: confirmedOrder, proposal };
    }
    if (proposal.status !== "pending") throw new Error(`Proposal ${proposalId} is already ${proposal.status}`);

    const order = this.orders.get(proposal.orderId);
    if (!order) throw new Error(`No such order: ${proposal.orderId}`);

    const before = {
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      inventoryReserved: order.inventoryReserved,
    };
    applyAction(order, proposal.action);
    if (proposal.action !== "escalate_to_human") {
      order.operations.resolvedAt = new Date().toISOString();
    }
    order.timeline.push({
      at: new Date().toISOString(),
      label: `Resolution confirmed by ${approvedBy}: ${proposal.action}`,
    });

    proposal.status = "confirmed";
    this.appendAudit(order.id, {
      eventType: "resolution_confirmed",
      actorType: "operator",
      actorId: approvedBy,
      reason: proposal.rationale,
      occurredAt: order.timeline.at(-1)?.at ?? new Date().toISOString(),
      before,
      after: {
        status: order.status,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        inventoryReserved: order.inventoryReserved,
      },
      payload: { proposalId: proposal.id, action: proposal.action },
    });
    return { order, proposal };
  }

  async injectFailure(): Promise<Order> {
    const order = generateOneFailure();
    this.orders.set(order.id, order);
    this.appendAudit(order.id, {
      eventType: "failure_injected",
      actorType: "system",
      actorId: "order-ops-mcp",
      reason: "Synthetic failure injected by the demo helper",
      occurredAt: new Date().toISOString(),
      after: { exceptionType: exceptionType(order), summary: exceptionSummary(order) },
    });
    return order;
  }

  private appendAudit(orderId: string, event: AuditLogEntry): void {
    const current = this.auditLogs.get(orderId) ?? [];
    current.push(event);
    this.auditLogs.set(orderId, current);
  }
}

export function applyAction(order: Order, action: ResolutionAction): void {
  switch (action) {
    case "release_inventory_hold_and_cancel_order":
      order.inventoryReserved = false;
      order.inventoryAllocations = order.inventoryAllocations.map((allocation) => ({
        ...allocation,
        reservedQuantity: 0,
        status: "released",
      }));
      order.status = "cancelled";
      order.cancelReason = "DECLINED";
      break;
    case "notify_customer_backorder":
      order.fulfillmentHoldNotes = `${order.fulfillmentHoldNotes ?? ""} | customer notified of backorder`.trim();
      order.customerNotifiedAt = new Date().toISOString();
      break;
    case "retry_fulfillment":
      order.fulfillmentStatus = "in_progress";
      order.fulfillment.retryCount += 1;
      order.fulfillment.lastError = undefined;
      break;
    case "cancel_duplicate_order":
      order.status = "cancelled";
      order.cancelReason = "OTHER";
      if (order.paymentStatus === "paid") order.paymentStatus = "refunded";
      order.inventoryReserved = false;
      order.inventoryAllocations = order.inventoryAllocations.map((allocation) => ({
        ...allocation,
        reservedQuantity: 0,
        status: "released",
      }));
      break;
    case "escalate_to_human":
      // No state change — this is an explicit "I don't have a playbook for this" outcome.
      break;
  }
}

/** Exported for tests, which need isolated instances rather than the shared singleton below. */
export function createInMemoryOrdersProvider(seed: Order[]): OrdersProvider {
  return new InMemoryOrdersProvider(seed);
}

let singleton: OrdersProvider | undefined;

/** Process-wide store. Fine for a single-instance demo; not meant to survive a restart or scale past one node. */
export async function getOrdersProvider(): Promise<OrdersProvider> {
  if (singleton) return singleton;

  if (env.PERSISTENCE_MODE === "postgres") {
    const { createPostgresOrdersProvider } = await import("./postgres-store.js");
    const { getPrismaClient } = await import("./database.js");
    singleton = await createPostgresOrdersProvider(getPrismaClient());
    return singleton;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("PERSISTENCE_MODE=postgres is required in production.");
  }

  singleton = createInMemoryOrdersProvider(generateSeedOrders());
  return singleton;
}
