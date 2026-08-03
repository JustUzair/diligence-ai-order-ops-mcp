import { beforeEach, describe, expect, it } from "vitest";
import type { Order } from "../src/data/types.js";
import { createInMemoryOrdersProvider, exceptionSummary, isException, type OrdersProvider } from "../src/data/store.js";

function baseOrder(overrides: Partial<Order>): Order {
  return {
    id: "ORD-1",
    createdAt: new Date().toISOString(),
    customerName: "A",
    customerEmail: "a@example.com",
    customer: { segment: "new", previousOrderCount: 0, lifetimeValueCents: 0, locale: "en-US" },
    channel: "online_store",
    shippingDestination: { city: "Testville", region: "CA", countryCode: "US", postalCode: "90210" },
    status: "open",
    paymentStatus: "declined",
    paymentFailureMessage: "card_declined",
    paymentAttempts: [],
    inventoryReserved: true,
    inventoryAllocations: [
      {
        sku: "SKU-1",
        locationId: "LOC-1",
        locationName: "Test DC",
        requestedQuantity: 1,
        availableQuantity: 4,
        reservedQuantity: 1,
        status: "reserved",
      },
    ],
    fulfillmentStatus: "unfulfilled",
    fulfillment: {
      fulfillmentOrderId: "FUL-1",
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
    operations: {
      priority: "high",
      assignedTeam: "payments",
      exceptionDetectedAt: new Date().toISOString(),
    },
    timeline: [],
    ...overrides,
  };
}

describe("isException / exceptionSummary", () => {
  it("flags a declined payment with an active inventory hold as an exception", () => {
    const order = baseOrder({});
    expect(isException(order)).toBe(true);
    expect(exceptionSummary(order)).toContain("payment declined");
  });

  it("does not flag a normal fulfilled order", () => {
    const order = baseOrder({
      paymentStatus: "paid",
      inventoryReserved: false,
      fulfillmentStatus: "fulfilled",
    });
    expect(isException(order)).toBe(false);
  });
});

describe("propose -> confirm flow", () => {
  let provider: OrdersProvider;

  beforeEach(() => {
    provider = createInMemoryOrdersProvider([baseOrder({})]);
  });

  it("does not mutate the order when a resolution is only proposed", () => {
    provider.proposeResolution("ORD-1", "release_inventory_hold_and_cancel_order", "test");
    const order = provider.getOrder("ORD-1")!;
    expect(order.inventoryReserved).toBe(true);
    expect(order.status).toBe("open");
  });

  it("applies the action only once confirmed, and records who approved it", () => {
    const proposal = provider.proposeResolution("ORD-1", "release_inventory_hold_and_cancel_order", "test");
    const { order } = provider.confirmResolution(proposal.id, "jane@ops");
    expect(order.inventoryReserved).toBe(false);
    expect(order.inventoryAllocations[0]?.status).toBe("released");
    expect(order.status).toBe("cancelled");
    expect(order.operations.resolvedAt).toBeDefined();
    expect(provider.listExceptions()).toHaveLength(0);
    expect(order.timeline.at(-1)?.label).toContain("jane@ops");
  });

  it("rejects confirming the same proposal twice", () => {
    const proposal = provider.proposeResolution("ORD-1", "retry_fulfillment", "test");
    provider.confirmResolution(proposal.id, "jane@ops");
    expect(() => provider.confirmResolution(proposal.id, "jane@ops")).toThrow(/already confirmed/);
  });

  it("rejects confirming an unknown proposal id", () => {
    expect(() => provider.confirmResolution("PROP-does-not-exist")).toThrow(/No such proposal/);
  });

  it("stores evidence and expected changes with the inert proposal", () => {
    const proposal = provider.proposeResolution(
      "ORD-1",
      "release_inventory_hold_and_cancel_order",
      "test",
      { evidence: ["payment declined"], expectedChanges: ["release stock"], risk: "high" },
    );
    expect(proposal.evidence).toEqual(["payment declined"]);
    expect(proposal.expectedChanges).toEqual(["release stock"]);
    expect(proposal.risk).toBe("high");
    expect(provider.getOrder("ORD-1")?.status).toBe("open");
  });

  it("keeps a confirmed human escalation in the active queue", () => {
    const proposal = provider.proposeResolution("ORD-1", "escalate_to_human", "manual review needed");
    provider.confirmResolution(proposal.id, "jane@ops");
    expect(provider.getOrder("ORD-1")?.operations.resolvedAt).toBeUndefined();
    expect(provider.listExceptions()).toHaveLength(1);
  });
});
