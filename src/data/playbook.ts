import { ResolutionRisk, type Order, type ResolutionAction } from "./types.js";

export interface ResolutionSuggestion {
  action: ResolutionAction;
  rationale: string;
  evidence: string[];
  expectedChanges: string[];
  risk: ResolutionRisk;
}

/**
 * Deterministic, rule-based suggestion — not a model call. Keeping this a
 * plain function (rather than an LLM prompt) means the same broken order
 * always gets the same suggestion, and it's trivial to unit test. The
 * MCP tool layer is where AI judgment comes in (deciding *when* to call
 * this, and how to explain it to the ops person); the rule itself is
 * intentionally boring.
 */
export function suggestResolution(order: Order): ResolutionSuggestion {
  if (order.possibleDuplicateOf) {
    return {
      action: "cancel_duplicate_order",
      rationale: `This looks like a duplicate of ${order.possibleDuplicateOf} — same customer, same items, placed minutes apart. Cancel this one and refund if payment was captured.`,
      evidence: order.duplicateEvidence
        ? [
            `Duplicate confidence: ${Math.round(order.duplicateEvidence.confidence * 100)}%`,
            `Matched signals: ${order.duplicateEvidence.signals.join(", ")}`,
            `Matched order: ${order.duplicateEvidence.matchedOrderId}`,
          ]
        : [`Order is linked to possible duplicate ${order.possibleDuplicateOf}`],
      expectedChanges: [
        "Cancel the duplicate order",
        "Refund the captured payment",
        "Release its reserved inventory",
        "Remove it from the active exception queue",
      ],
      risk: ResolutionRisk.HIGH,
    };
  }

  if (order.paymentStatus === "declined" && order.inventoryReserved) {
    return {
      action: "release_inventory_hold_and_cancel_order",
      rationale: `Payment was declined (${order.paymentFailureMessage ?? "no reason given"}) but inventory is still held. Release the hold so stock isn't blocked, and cancel the order.`,
      evidence: [
        `Latest payment status: ${order.paymentStatus}`,
        `Decline code: ${order.paymentAttempts.at(-1)?.declineCode ?? "not provided"}`,
        `${order.inventoryAllocations.reduce((sum, item) => sum + item.reservedQuantity, 0)} unit(s) remain reserved`,
      ],
      expectedChanges: [
        "Release every inventory allocation",
        "Cancel the unpaid order with reason DECLINED",
        "Remove it from the active exception queue",
      ],
      risk: ResolutionRisk.HIGH,
    };
  }

  if (order.fulfillmentStatus === "on_hold" && order.fulfillmentHoldReason === "inventory_out_of_stock") {
    return {
      action: "notify_customer_backorder",
      rationale: "Fulfillment is on hold for stock. The customer hasn't been told yet — offer a backorder ETA or a substitution instead of leaving them guessing.",
      evidence: [
        `Fulfillment hold: ${order.fulfillmentHoldReason}`,
        ...order.inventoryAllocations
          .filter((item) => item.status === "short")
          .map((item) => `${item.sku}: requested ${item.requestedQuantity}, available ${item.availableQuantity}`),
        `Promised ship-by: ${order.fulfillment.promisedShipBy}`,
      ],
      expectedChanges: [
        "Record that the customer was notified of the backorder",
        "Keep the fulfillment hold in place until inventory is available",
        "Remove the communication exception from the active queue",
      ],
      risk: ResolutionRisk.MEDIUM,
    };
  }

  if (order.fulfillmentStatus === "incomplete") {
    return {
      action: "retry_fulfillment",
      rationale: "The fulfillment service accepted this order and then failed to complete it. Nothing has retried it since — that's most likely a transient carrier-side failure.",
      evidence: [
        `Carrier: ${order.fulfillment.carrier}`,
        `Last error: ${order.fulfillment.lastError ?? "not provided"}`,
        `Previous retries: ${order.fulfillment.retryCount}`,
      ],
      expectedChanges: [
        "Move fulfillment status to in_progress",
        "Increment the retry counter",
        "Clear the previous carrier error",
        "Remove it from the active exception queue",
      ],
      risk: ResolutionRisk.MEDIUM,
    };
  }

  return {
    action: "escalate_to_human",
    rationale: "This doesn't match a known exception pattern. Flagging for manual review rather than guessing.",
    evidence: [
      `Payment status: ${order.paymentStatus}`,
      `Fulfillment status: ${order.fulfillmentStatus}`,
      `Fulfillment hold: ${order.fulfillmentHoldReason ?? "none"}`,
      `Assigned team: ${order.operations.assignedTeam}`,
    ],
    expectedChanges: ["Add an escalation event to the order timeline", "Keep the exception active for human review"],
    risk: ResolutionRisk.LOW,
  };
}
