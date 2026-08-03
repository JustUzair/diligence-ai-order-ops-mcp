import { describe, expect, it } from "vitest";
import { suggestResolution } from "../src/data/playbook.js";
import type { Order } from "../src/data/types.js";

function order(overrides: Partial<Order>): Order {
  return {
    id: "ORD-TEST",
    createdAt: new Date().toISOString(),
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    customer: { segment: "returning", previousOrderCount: 2, lifetimeValueCents: 5000, locale: "en-US" },
    channel: "online_store",
    shippingDestination: { city: "Testville", region: "CA", countryCode: "US", postalCode: "90210" },
    status: "open",
    paymentStatus: "paid",
    paymentAttempts: [],
    inventoryReserved: false,
    inventoryAllocations: [],
    fulfillmentStatus: "fulfilled",
    fulfillment: {
      fulfillmentOrderId: "FUL-TEST",
      warehouse: "Test DC",
      carrier: "UPS",
      serviceLevel: "standard",
      retryCount: 0,
      promisedShipBy: new Date().toISOString(),
      promisedDeliveryBy: new Date().toISOString(),
    },
    items: [],
    totalCents: 1000,
    currency: "USD",
    operations: { priority: "normal", assignedTeam: "order_operations" },
    timeline: [],
    ...overrides,
  };
}

describe("suggestResolution", () => {
  it("proposes releasing the hold when payment was declined but inventory is still reserved", () => {
    const result = suggestResolution(
      order({ paymentStatus: "declined", inventoryReserved: true, paymentFailureMessage: "card_declined" }),
    );
    expect(result.action).toBe("release_inventory_hold_and_cancel_order");
    expect(result.rationale).toContain("card_declined");
    expect(result.expectedChanges).toContain("Release every inventory allocation");
    expect(result.risk).toBe("high");
  });

  it("proposes a backorder notification for stock-related fulfillment holds", () => {
    const result = suggestResolution(
      order({ fulfillmentStatus: "on_hold", fulfillmentHoldReason: "inventory_out_of_stock" }),
    );
    expect(result.action).toBe("notify_customer_backorder");
  });

  it("proposes a fulfillment retry when the fulfillment service failed silently", () => {
    const result = suggestResolution(order({ fulfillmentStatus: "incomplete" }));
    expect(result.action).toBe("retry_fulfillment");
  });

  it("proposes cancelling the duplicate when possibleDuplicateOf is set", () => {
    const result = suggestResolution(order({ possibleDuplicateOf: "ORD-1000" }));
    expect(result.action).toBe("cancel_duplicate_order");
    expect(result.rationale).toContain("ORD-1000");
  });

  it("escalates to a human instead of guessing when nothing matches", () => {
    const result = suggestResolution(order({}));
    expect(result.action).toBe("escalate_to_human");
    expect(result.expectedChanges).toContain("Keep the exception active for human review");
  });

  it("checks the duplicate pattern before the declined-payment pattern when both could apply", () => {
    // An order can technically satisfy more than one condition; duplicate
    // should win because "this is probably a mistake, cancel it" is a
    // stronger claim than "retry the payment side of it."
    const result = suggestResolution(
      order({
        possibleDuplicateOf: "ORD-1000",
        paymentStatus: "declined",
        inventoryReserved: true,
      }),
    );
    expect(result.action).toBe("cancel_duplicate_order");
  });
});
