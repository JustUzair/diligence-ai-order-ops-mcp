import { beforeEach, describe, expect, it } from "vitest";
import { ResolutionRisk, type Order, type OrdersProvider } from "../src/data/types.js";
import { createInMemoryOrdersProvider, exceptionSummary, isException } from "../src/data/store.js";

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

  it("does not mutate the order when a resolution is only proposed", async () => {
    await provider.proposeResolution("ORD-1", "release_inventory_hold_and_cancel_order", "test");
    const order = (await provider.getOrder("ORD-1"))!;
    expect(order.inventoryReserved).toBe(true);
    expect(order.status).toBe("open");
  });

  it("applies the action only once confirmed, and records who approved it", async () => {
    const proposal = await provider.proposeResolution("ORD-1", "release_inventory_hold_and_cancel_order", "test");
    const { order } = await provider.confirmResolution(proposal.id, "jane@ops");
    expect(order.inventoryReserved).toBe(false);
    expect(order.inventoryAllocations[0]?.status).toBe("released");
    expect(order.status).toBe("cancelled");
    expect(order.operations.resolvedAt).toBeDefined();
    expect(await provider.listExceptions()).toHaveLength(0);
    expect(order.timeline.at(-1)?.label).toContain("jane@ops");
    const audit = await provider.getAuditLog("ORD-1");
    expect(audit.map((entry) => entry.eventType)).toEqual(["resolution_proposed", "resolution_confirmed"]);
    expect(audit.at(-1)?.actorId).toBe("jane@ops");
  });

  it("returns the recorded result when the same proposal is confirmed twice", async () => {
    const proposal = await provider.proposeResolution("ORD-1", "retry_fulfillment", "test");
    const first = await provider.confirmResolution(proposal.id, "jane@ops");
    const second = await provider.confirmResolution(proposal.id, "jane@ops");
    expect(second.order).toEqual(first.order);
    expect(second.proposal.status).toBe("confirmed");
  });

  it("rejects confirming an unknown proposal id", async () => {
    await expect(provider.confirmResolution("PROP-does-not-exist")).rejects.toThrow(/No such proposal/);
  });

  it("stores evidence and expected changes with the inert proposal", async () => {
    const proposal = await provider.proposeResolution(
      "ORD-1",
      "release_inventory_hold_and_cancel_order",
      "test",
      { evidence: ["payment declined"], expectedChanges: ["release stock"], risk: ResolutionRisk.HIGH },
    );
    expect(proposal.evidence).toEqual(["payment declined"]);
    expect(proposal.expectedChanges).toEqual(["release stock"]);
    expect(proposal.risk).toBe(ResolutionRisk.HIGH);
    expect((await provider.getOrder("ORD-1"))?.status).toBe("open");
  });

  it("keeps a confirmed human escalation in the active queue", async () => {
    const proposal = await provider.proposeResolution("ORD-1", "escalate_to_human", "manual review needed");
    await provider.confirmResolution(proposal.id, "jane@ops");
    expect((await provider.getOrder("ORD-1"))?.operations.resolvedAt).toBeUndefined();
    expect(await provider.listExceptions()).toHaveLength(1);
  });
});
