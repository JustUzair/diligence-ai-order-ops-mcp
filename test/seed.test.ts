import { describe, expect, it } from "vitest";
import { generateOneFailure, generateSeedOrders } from "../src/data/seed.js";
import { isException } from "../src/data/store.js";

const fixedNow = new Date("2026-08-03T12:00:00.000Z");

describe("synthetic commerce dataset", () => {
  it("contains healthy orders and six varied, diagnosable exception scenarios", () => {
    const orders = generateSeedOrders(fixedNow);
    const exceptions = orders.filter(isException);

    expect(orders).toHaveLength(21);
    expect(exceptions).toHaveLength(6);
    expect(new Set(exceptions.map((order) => order.operations.assignedTeam))).toEqual(
      new Set(["payments", "inventory", "fraud", "fulfillment", "order_operations"]),
    );
  });

  it("gives every order agent-useful payment, inventory, fulfillment, customer, and shipping context", () => {
    const orders = generateSeedOrders(fixedNow);

    for (const order of orders) {
      expect(order.customer.segment).toMatch(/new|returning|vip/);
      expect(order.shippingDestination.countryCode).toBeTruthy();
      expect(order.paymentAttempts.length).toBeGreaterThan(0);
      expect(order.inventoryAllocations).toHaveLength(order.items.length);
      expect(order.fulfillment.fulfillmentOrderId).toMatch(/^FUL-/);
      expect(order.fulfillment.promisedDeliveryBy).toBeTruthy();
      expect(new Date(order.fulfillment.promisedDeliveryBy).getTime()).toBeGreaterThan(
        new Date(order.fulfillment.promisedShipBy).getTime(),
      );
      expect(order.paymentAttempts.every((attempt) => attempt.attemptedAt >= order.createdAt)).toBe(true);
      expect(order.timeline.every((event) => event.at >= order.createdAt)).toBe(true);
    }
  });

  it("includes concrete evidence for each supported exception pattern", () => {
    const exceptions = generateSeedOrders(fixedNow).filter(isException);

    expect(exceptions.some((order) => order.paymentAttempts.some((attempt) => attempt.declineCode))).toBe(true);
    expect(exceptions.some((order) => order.inventoryAllocations.some((item) => item.status === "short"))).toBe(true);
    expect(exceptions.some((order) => order.fulfillment.lastError)).toBe(true);
    expect(exceptions.some((order) => order.duplicateEvidence?.confidence === 0.98)).toBe(true);
    expect(exceptions.some((order) => order.fulfillmentHoldReason === "high_risk_of_fraud")).toBe(true);
  });

  it("injects a fully enriched failure rather than a partial fixture", () => {
    const order = generateOneFailure(fixedNow);

    expect(isException(order)).toBe(true);
    expect(order.operations.exceptionDetectedAt).toBeTruthy();
    expect(order.operations.responseDueAt).toBeTruthy();
    expect(order.paymentAttempts.length).toBeGreaterThan(0);
    expect(order.inventoryAllocations).toHaveLength(order.items.length);
  });
});
