/**
 * Domain types for the order-exceptions workflow.
 *
 * The enums below are not invented — they mirror Shopify's real, published
 * taxonomy (OrderCancelReason on the Admin/Storefront GraphQL API, and the
 * FulfillmentHold `reason` field) so that seeded data reads as authentic
 * rather than made up. See README.md "Data model" for sources.
 */

export type CancelReason =
  | "CUSTOMER" // customer requested the cancellation
  | "DECLINED" // payment was declined
  | "FRAUD" // flagged as fraudulent
  | "INVENTORY" // insufficient inventory
  | "STAFF" // staff error
  | "OTHER";

export type FulfillmentHoldReason =
  | "inventory_out_of_stock"
  | "awaiting_return_items"
  | "high_risk_of_fraud"
  | "incorrect_address"
  | "other";

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "paid"
  | "partially_refunded"
  | "refunded"
  | "voided"
  | "declined";

export type FulfillmentStatus =
  | "unfulfilled"
  | "in_progress"
  | "on_hold"
  | "incomplete" // fulfillment service accepted then failed to complete it
  | "fulfilled";

export type OrderStatus = "open" | "cancelled" | "completed";

export type OrderChannel = "online_store" | "mobile_app" | "marketplace" | "draft_order";
export type CustomerSegment = "new" | "returning" | "vip";
export type OperationalPriority = "low" | "normal" | "high" | "urgent";

export enum ResolutionRisk {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

export type ExceptionType =
  | "possible_duplicate"
  | "declined_payment_inventory_held"
  | "fulfillment_hold"
  | "incomplete_fulfillment"
  | "cancelled_order";

export interface OrderLineItem {
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface TimelineEvent {
  at: string; // ISO timestamp
  label: string;
}

export interface CustomerContext {
  segment: CustomerSegment;
  previousOrderCount: number;
  lifetimeValueCents: number;
  locale: string;
}

export interface ShippingDestination {
  city: string;
  region: string;
  countryCode: string;
  postalCode: string;
}

export interface PaymentAttempt {
  id: string;
  gateway: "shopify_payments" | "stripe" | "paypal";
  status: "succeeded" | "declined";
  amountCents: number;
  attemptedAt: string;
  declineCode?: string;
  adviceCode?: "try_again_later" | "confirm_payment_details" | "do_not_try_again";
}

export interface InventoryAllocation {
  sku: string;
  locationId: string;
  locationName: string;
  requestedQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  status: "available" | "reserved" | "released" | "short";
}

export interface FulfillmentContext {
  fulfillmentOrderId: string;
  warehouse: string;
  carrier: "UPS" | "FedEx" | "USPS" | "DHL";
  serviceLevel: "standard" | "express" | "next_day";
  trackingNumber?: string;
  retryCount: number;
  lastError?: string;
  promisedShipBy: string;
  promisedDeliveryBy: string;
}

export interface DuplicateEvidence {
  matchedOrderId: string;
  confidence: number;
  signals: Array<"same_customer" | "same_items" | "same_amount" | "placed_within_5_minutes">;
}

export interface OperationsContext {
  priority: OperationalPriority;
  assignedTeam: "payments" | "inventory" | "fulfillment" | "fraud" | "order_operations";
  exceptionDetectedAt?: string;
  responseDueAt?: string;
  resolvedAt?: string;
}

export interface Order {
  id: string;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  customer: CustomerContext;
  channel: OrderChannel;
  shippingDestination: ShippingDestination;

  status: OrderStatus;
  cancelReason?: CancelReason;

  paymentStatus: PaymentStatus;
  paymentFailureMessage?: string;
  paymentAttempts: PaymentAttempt[];
  inventoryReserved: boolean;
  inventoryAllocations: InventoryAllocation[];

  fulfillmentStatus: FulfillmentStatus;
  fulfillmentHoldReason?: FulfillmentHoldReason;
  fulfillmentHoldNotes?: string;
  fulfillment: FulfillmentContext;
  customerNotifiedAt?: string;

  possibleDuplicateOf?: string;
  duplicateEvidence?: DuplicateEvidence;

  items: OrderLineItem[];
  totalCents: number;
  currency: "USD";
  operations: OperationsContext;

  timeline: TimelineEvent[];
}

/** A suggested fix for a broken order. Never applied automatically. */
export interface ResolutionProposal {
  id: string;
  orderId: string;
  action: ResolutionAction;
  rationale: string;
  evidence: string[];
  expectedChanges: string[];
  risk: ResolutionRisk;
  createdAt: string;
  status: "pending" | "confirmed" | "expired";
}

export type ResolutionAction =
  | "release_inventory_hold_and_cancel_order"
  | "notify_customer_backorder"
  | "retry_fulfillment"
  | "cancel_duplicate_order"
  | "escalate_to_human";

export interface OrdersProvider {
  listExceptions(): Order[];
  getOrder(orderId: string): Order | undefined;
  proposeResolution(
    orderId: string,
    action: ResolutionAction,
    rationale: string,
    context?: { evidence: string[]; expectedChanges: string[]; risk: ResolutionRisk },
  ): ResolutionProposal;
  confirmResolution(proposalId: string, approvedBy?: string): { order: Order; proposal: ResolutionProposal };
  injectFailure(): Order;
}
