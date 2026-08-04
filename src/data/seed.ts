import { faker } from "@faker-js/faker";
import type {
  CustomerSegment,
  InventoryAllocation,
  OperationsContext,
  Order,
  OrderLineItem,
  PaymentAttempt,
  TimelineEvent,
} from "./types.js";
import { MILLISECONDS_PER_MINUTE } from "../constants.js";

// A fixed seed makes live demos and bug reports reproducible while keeping the
// records visibly synthetic. Restarting the process restores the same dataset.
faker.seed(20260803);

function money(): number {
  return faker.number.int({ min: 1500, max: 45000 }); // cents
}

function makeItems(): OrderLineItem[] {
  const count = faker.number.int({ min: 1, max: 3 });
  return Array.from({ length: count }, () => ({
    sku: faker.string.alphanumeric({ length: 8, casing: "upper" }),
    name: faker.commerce.productName(),
    quantity: faker.number.int({ min: 1, max: 3 }),
    unitPriceCents: money(),
  }));
}

function timeline(events: Array<[minutesAgo: number, label: string]>, now: Date): TimelineEvent[] {
  return events.map(([minutesAgo, label]) => ({
    at: new Date(now.getTime() - minutesAgo * MILLISECONDS_PER_MINUTE).toISOString(),
    label,
  }));
}

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * MILLISECONDS_PER_MINUTE).toISOString();
}

function minutesFromNow(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * MILLISECONDS_PER_MINUTE).toISOString();
}

let counter = 1000;
function nextId(): string {
  counter += 1;
  return `ORD-${counter}`;
}

function customerSegment(previousOrderCount: number): CustomerSegment {
  if (previousOrderCount === 0) return "new";
  if (previousOrderCount >= 8) return "vip";
  return "returning";
}

function makeInventoryAllocations(items: OrderLineItem[]): InventoryAllocation[] {
  const locationId = `LOC-${faker.number.int({ min: 1, max: 4 }).toString().padStart(2, "0")}`;
  const locationName = faker.helpers.arrayElement([
    "East Coast DC",
    "West Coast DC",
    "Central Fulfillment Hub",
    "New York Retail Store",
  ]);

  return items.map((item) => ({
    sku: item.sku,
    locationId,
    locationName,
    requestedQuantity: item.quantity,
    availableQuantity: faker.number.int({ min: item.quantity + 2, max: item.quantity + 40 }),
    reservedQuantity: 0,
    status: "available",
  }));
}

function paymentAttempt(
  order: Order,
  now: Date,
  status: PaymentAttempt["status"],
  declineCode?: string,
  adviceCode?: PaymentAttempt["adviceCode"],
  attemptedMinutesAgo = status === "declined" ? 238 : 175,
): PaymentAttempt {
  return {
    id: `PAY-${faker.string.alphanumeric({ length: 10, casing: "upper" })}`,
    gateway: faker.helpers.arrayElement(["shopify_payments", "stripe", "paypal"]),
    status,
    amountCents: order.totalCents,
    attemptedAt: minutesAgo(now, attemptedMinutesAgo),
    declineCode,
    adviceCode,
  };
}

function exceptionOperations(
  now: Date,
  detectedMinutesAgo: number,
  priority: OperationsContext["priority"],
  assignedTeam: OperationsContext["assignedTeam"],
  responseWindowMinutes: number,
): OperationsContext {
  const exceptionDetectedAt = minutesAgo(now, detectedMinutesAgo);
  return {
    priority,
    assignedTeam,
    exceptionDetectedAt,
    responseDueAt: new Date(
      new Date(exceptionDetectedAt).getTime() + responseWindowMinutes * MILLISECONDS_PER_MINUTE,
    ).toISOString(),
  };
}

function baseOrder(now: Date, overrides: Partial<Order> = {}): Order {
  const items = overrides.items ?? makeItems();
  const totalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const previousOrderCount = faker.number.int({ min: 0, max: 14 });
  const createdAt = minutesAgo(now, faker.number.int({ min: 60, max: 60 * 24 * 5 }));

  const order: Order = {
    id: nextId(),
    createdAt,
    customerName: faker.person.fullName(),
    customerEmail: faker.internet.email(),
    customer: {
      segment: customerSegment(previousOrderCount),
      previousOrderCount,
      lifetimeValueCents: previousOrderCount * faker.number.int({ min: 3500, max: 24000 }),
      locale: faker.helpers.arrayElement(["en-US", "en-CA", "en-GB"]),
    },
    channel: faker.helpers.arrayElement(["online_store", "mobile_app", "marketplace"]),
    shippingDestination: {
      city: faker.location.city(),
      region: faker.location.state({ abbreviated: true }),
      countryCode: faker.helpers.arrayElement(["US", "CA", "GB"]),
      postalCode: faker.location.zipCode(),
    },
    status: "open",
    paymentStatus: "paid",
    paymentAttempts: [],
    inventoryReserved: false,
    inventoryAllocations: makeInventoryAllocations(items),
    fulfillmentStatus: "fulfilled",
    fulfillment: {
      fulfillmentOrderId: `FUL-${faker.string.alphanumeric({ length: 10, casing: "upper" })}`,
      warehouse: faker.helpers.arrayElement(["East Coast DC", "West Coast DC", "Central Fulfillment Hub"]),
      carrier: faker.helpers.arrayElement(["UPS", "FedEx", "USPS", "DHL"]),
      serviceLevel: faker.helpers.arrayElement(["standard", "express", "next_day"]),
      trackingNumber: faker.string.alphanumeric({ length: 14, casing: "upper" }),
      retryCount: 0,
      promisedShipBy: minutesFromNow(now, 24 * 60),
      promisedDeliveryBy: minutesFromNow(now, 4 * 24 * 60),
    },
    items,
    totalCents,
    currency: "USD",
    operations: {
      priority: "normal",
      assignedTeam: "order_operations",
    },
    timeline: [],
    ...overrides,
  };

  if (order.paymentAttempts.length === 0) {
    order.paymentAttempts = [paymentAttempt(order, now, "succeeded")];
  }
  return order;
}

/** A normal, healthy order — included to prove the exception filter is selective. */
function healthyOrder(now: Date): Order {
  const order = baseOrder(now);
  order.createdAt = minutesAgo(now, 180);
  order.timeline = timeline(
    [
      [180, "Order placed"],
      [178, "Payment authorized"],
      [175, "Payment captured"],
      [90, `Fulfillment started at ${order.fulfillment.warehouse}`],
      [10, `Order fulfilled via ${order.fulfillment.carrier}`],
    ],
    now,
  );
  return order;
}

/** Payment declined, but inventory remains committed and unavailable to other orders. */
function declinedPaymentStuckOrder(
  now: Date,
  declineCode: "insufficient_funds" | "do_not_honor" = "insufficient_funds",
): Order {
  const order = baseOrder(now, {
    paymentStatus: "declined",
    paymentFailureMessage: `card_declined: ${declineCode}`,
    inventoryReserved: true,
    fulfillmentStatus: "unfulfilled",
    status: "open",
  });
  order.createdAt = minutesAgo(now, 240);
  order.paymentAttempts = [
    paymentAttempt(
      order,
      now,
      "declined",
      declineCode,
      declineCode === "insufficient_funds" ? "confirm_payment_details" : "do_not_try_again",
    ),
  ];
  order.inventoryAllocations = order.inventoryAllocations.map((allocation) => ({
    ...allocation,
    reservedQuantity: allocation.requestedQuantity,
    status: "reserved",
  }));
  order.operations = exceptionOperations(now, 238, "high", "payments", 60);
  order.timeline = timeline(
    [
      [240, "Order placed"],
      [239, `Inventory reserved at ${order.inventoryAllocations[0]?.locationName}`],
      [238, `Payment declined: ${declineCode}`],
      [180, "Payment exception routed to operations"],
    ],
    now,
  );
  return order;
}

/** Fulfillment cannot proceed because one allocated SKU is short. */
function fulfillmentHoldOrder(now: Date): Order {
  const order = baseOrder(now, {
    paymentStatus: "paid",
    inventoryReserved: true,
    fulfillmentStatus: "on_hold",
    fulfillmentHoldReason: "inventory_out_of_stock",
    fulfillmentHoldNotes: "Allocated location cannot fulfill the complete quantity.",
  });
  order.createdAt = minutesAgo(now, 300);
  order.paymentAttempts = [paymentAttempt(order, now, "succeeded", undefined, undefined, 299)];
  order.inventoryAllocations[0] = {
    ...order.inventoryAllocations[0]!,
    availableQuantity: 0,
    reservedQuantity: 0,
    status: "short",
  };
  order.operations = exceptionOperations(now, 200, "high", "inventory", 120);
  order.timeline = timeline(
    [
      [300, "Order placed"],
      [299, "Payment captured"],
      [200, `Allocation shortage detected at ${order.inventoryAllocations[0]?.locationName}`],
      [200, "Fulfillment hold: inventory_out_of_stock"],
    ],
    now,
  );
  return order;
}

/** A deliberately unsupported pattern: the safe proposal should be human escalation. */
function fraudReviewHoldOrder(now: Date): Order {
  const order = baseOrder(now, {
    paymentStatus: "paid",
    inventoryReserved: true,
    fulfillmentStatus: "on_hold",
    fulfillmentHoldReason: "high_risk_of_fraud",
    fulfillmentHoldNotes: "Automated risk screening requested manual identity review.",
  });
  order.createdAt = minutesAgo(now, 55);
  order.paymentAttempts = [paymentAttempt(order, now, "succeeded", undefined, undefined, 54)];
  order.operations = exceptionOperations(now, 45, "urgent", "fraud", 30);
  order.timeline = timeline(
    [
      [55, "Order placed"],
      [54, "Payment captured"],
      [45, "Fulfillment hold: high_risk_of_fraud"],
      [44, "Manual risk review requested"],
    ],
    now,
  );
  return order;
}

/** Fulfillment service accepted the order, then failed without completing it. */
function incompleteFulfillmentOrder(now: Date): Order {
  const order = baseOrder(now, {
    paymentStatus: "paid",
    inventoryReserved: true,
    fulfillmentStatus: "incomplete",
  });
  order.createdAt = minutesAgo(now, 400);
  order.paymentAttempts = [paymentAttempt(order, now, "succeeded", undefined, undefined, 399)];
  order.fulfillment.promisedShipBy = minutesAgo(now, 120);
  order.fulfillment.trackingNumber = undefined;
  order.fulfillment.lastError = "carrier_api_timeout_after_acceptance";
  order.fulfillment.retryCount = 0;
  order.operations = exceptionOperations(now, 149, "high", "fulfillment", 90);
  order.timeline = timeline(
    [
      [400, "Order placed"],
      [399, "Payment captured"],
      [150, `Fulfillment accepted by ${order.fulfillment.carrier}`],
      [149, "Fulfillment service failed: carrier_api_timeout_after_acceptance"],
    ],
    now,
  );
  return order;
}

/** Likely duplicate — same customer, item fingerprint, amount, and a three-minute gap. */
function duplicateOrderPair(now: Date): [Order, Order] {
  const items = makeItems();
  const customerName = faker.person.fullName();
  const customerEmail = faker.internet.email();
  const first = baseOrder(now, {
    items,
    customerName,
    customerEmail,
    paymentStatus: "paid",
    inventoryReserved: true,
  });
  first.createdAt = minutesAgo(now, 60);
  first.paymentAttempts = [paymentAttempt(first, now, "succeeded", undefined, undefined, 59)];
  first.inventoryAllocations = first.inventoryAllocations.map((allocation) => ({
    ...allocation,
    reservedQuantity: allocation.requestedQuantity,
    status: "reserved",
  }));
  first.timeline = timeline([[60, "Order placed"], [59, "Payment captured"]], now);

  const second = baseOrder(now, {
    items,
    customerName,
    customerEmail,
    paymentStatus: "paid",
    inventoryReserved: true,
  });
  second.paymentAttempts = [paymentAttempt(second, now, "succeeded", undefined, undefined, 56)];
  second.inventoryAllocations = second.inventoryAllocations.map((allocation) => ({
    ...allocation,
    reservedQuantity: allocation.requestedQuantity,
    status: "reserved",
  }));
  second.createdAt = minutesAgo(now, 57);
  second.possibleDuplicateOf = first.id;
  second.duplicateEvidence = {
    matchedOrderId: first.id,
    confidence: 0.98,
    signals: ["same_customer", "same_items", "same_amount", "placed_within_5_minutes"],
  };
  second.operations = exceptionOperations(now, 56, "urgent", "order_operations", 30);
  second.timeline = timeline(
    [
      [57, "Order placed"],
      [56, "Payment captured"],
      [55, `Possible duplicate detected: ${first.id} (98% confidence)`],
    ],
    now,
  );
  return [first, second];
}

export function generateSeedOrders(now: Date = new Date()): Order[] {
  const orders: Order[] = [];
  for (let i = 0; i < 14; i += 1) orders.push(healthyOrder(now));
  orders.push(declinedPaymentStuckOrder(now, "insufficient_funds"));
  orders.push(declinedPaymentStuckOrder(now, "do_not_honor"));
  orders.push(fulfillmentHoldOrder(now));
  orders.push(fraudReviewHoldOrder(now));
  orders.push(incompleteFulfillmentOrder(now));
  orders.push(...duplicateOrderPair(now));
  return orders;
}

export function generateOneFailure(now: Date = new Date()): Order {
  const generators = [
    () => declinedPaymentStuckOrder(now),
    () => fulfillmentHoldOrder(now),
    () => fraudReviewHoldOrder(now),
    () => incompleteFulfillmentOrder(now),
  ];
  return faker.helpers.arrayElement(generators)();
}
