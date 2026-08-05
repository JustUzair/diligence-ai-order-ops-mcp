import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type OrderRecord } from "../generated/prisma/client.js";
import { AUTHENTICATED_OPERATOR } from "../auth.js";
import {
  FIRST_PUBLIC_ORDER_SEQUENCE,
  SEED_DATASET_NAME,
  SEED_DATASET_VERSION,
} from "../constants.js";
import { generateOneFailure, generateSeedOrders } from "./seed.js";
import { applyAction, exceptionSummary, exceptionType, isException } from "./store.js";
import {
  ResolutionRisk,
  type AuditLogEntry,
  type Order,
  type OrdersProvider,
  type ResolutionAction,
  type ResolutionProposal,
  isResolutionAction,
} from "./types.js";

const ORDER_NUMBER_SEQUENCE = "orders";
const ORDER_NUMBER_PATTERN = /^ORD-(\d+)$/;

type ProposalRecord = Awaited<ReturnType<PrismaClient["resolutionProposalRecord"]["findUnique"]>>;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function orderSequence(orderId: string): number {
  const match = ORDER_NUMBER_PATTERN.exec(orderId);
  if (!match) throw new Error(`Order id must match ORD-<number>: ${orderId}`);
  return Number(match[1]);
}

function publicOrder(record: OrderRecord): Order {
  const order = record.data as unknown as Order;
  return {
    ...order,
    id: record.orderNumber,
    operations: {
      ...order.operations,
      resolvedAt: record.resolvedAt?.toISOString() ?? order.operations.resolvedAt,
    },
  };
}

function proposalFromRecord(record: NonNullable<ProposalRecord> & { order: OrderRecord }): ResolutionProposal {
  return {
    id: record.id,
    orderId: publicOrderIdFromInternalRecord(record),
    action: record.action as ResolutionAction,
    rationale: record.rationale,
    evidence: record.evidence as string[],
    expectedChanges: record.expectedChanges as string[],
    risk: record.risk as ResolutionRisk,
    createdAt: record.createdAt.toISOString(),
    status: record.status as ResolutionProposal["status"],
  };
}

function publicOrderIdFromInternalRecord(record: NonNullable<ProposalRecord> & { order: OrderRecord }): string {
  if (record.order?.orderNumber) return record.order.orderNumber;
  throw new Error(`Proposal ${record.id} is missing its order relation.`);
}

function auditFromRecord(record: {
  eventType: string;
  actorType: string;
  actorId: string;
  reason: string;
  occurredAt: Date;
  beforeState: unknown;
  afterState: unknown;
  payload: unknown;
}): AuditLogEntry {
  return {
    eventType: record.eventType as AuditLogEntry["eventType"],
    actorType: record.actorType as AuditLogEntry["actorType"],
    actorId: record.actorId,
    reason: record.reason,
    occurredAt: record.occurredAt.toISOString(),
    before: (record.beforeState as Record<string, unknown> | null) ?? undefined,
    after: (record.afterState as Record<string, unknown> | null) ?? undefined,
    payload: (record.payload as Record<string, unknown> | null) ?? undefined,
  };
}

function orderWriteData(order: Order, source: string, seedKey?: string) {
  return {
    orderNumber: order.id,
    orderSequence: orderSequence(order.id),
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    priority: order.operations.priority,
    assignedTeam: order.operations.assignedTeam,
    isActiveException: isException(order),
    resolvedAt: order.operations.resolvedAt ? new Date(order.operations.resolvedAt) : null,
    data: jsonValue(order),
    source,
    seedKey,
    createdAt: new Date(order.createdAt),
  };
}

function ensureOrderRecord(record: OrderRecord | null, orderId: string): OrderRecord {
  if (!record) throw new Error(`No such order: ${orderId}`);
  return record;
}

export class PostgresOrdersProvider implements OrdersProvider {
  constructor(private readonly prisma: PrismaClient) {}

  async initialize(): Promise<void> {
    await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);

    const seedOrders = generateSeedOrders();
    await this.prisma.$transaction(async (tx) => {
      await tx.orderRecord.createMany({
        data: seedOrders.map((order) =>
          orderWriteData(order, "seed", `order-ops:${SEED_DATASET_VERSION}:${order.id}`),
        ),
        skipDuplicates: true,
      });

      await tx.seedMetadata.upsert({
        where: {
          datasetName_datasetVersion: {
            datasetName: SEED_DATASET_NAME,
            datasetVersion: SEED_DATASET_VERSION,
          },
        },
        update: {},
        create: { datasetName: SEED_DATASET_NAME, datasetVersion: SEED_DATASET_VERSION },
      });

      const highest = await tx.$queryRaw<Array<{ max_sequence: number | null }>>(
        Prisma.sql`SELECT MAX(order_sequence) AS max_sequence FROM orders`,
      );
      const nextValue = Math.max(
        FIRST_PUBLIC_ORDER_SEQUENCE,
        Number(highest[0]?.max_sequence ?? FIRST_PUBLIC_ORDER_SEQUENCE - 1) + 1,
      );
      await tx.orderNumberSequence.upsert({
        where: { name: ORDER_NUMBER_SEQUENCE },
        update: { nextValue: { set: nextValue } },
        create: { name: ORDER_NUMBER_SEQUENCE, nextValue },
      });
    }, { timeout: 20_000 });
  }

  async listExceptions(): Promise<Order[]> {
    const records = await this.prisma.orderRecord.findMany({
      where: { isActiveException: true },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });
    return records.map(publicOrder);
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    const record = await this.prisma.orderRecord.findUnique({ where: { orderNumber: orderId } });
    return record ? publicOrder(record) : undefined;
  }

  async getAuditLog(orderId: string): Promise<AuditLogEntry[]> {
    const record = await this.prisma.orderRecord.findUnique({
      where: { orderNumber: orderId },
      select: { id: true },
    });
    if (!record) throw new Error(`No such order: ${orderId}`);
    const events = await this.prisma.orderAuditEvent.findMany({
      where: { orderInternalId: record.id },
      orderBy: { occurredAt: "asc" },
    });
    return events.map(auditFromRecord);
  }

  async proposeResolution(
    orderId: string,
    action: ResolutionAction,
    rationale: string,
    context = { evidence: [], expectedChanges: [], risk: ResolutionRisk.LOW },
  ): Promise<ResolutionProposal> {
    return this.prisma.$transaction(async (tx) => {
      const orderRecord = ensureOrderRecord(
        await tx.orderRecord.findUnique({ where: { orderNumber: orderId } }),
        orderId,
      );
      if (!isException(publicOrder(orderRecord))) {
        throw new Error(`Order ${orderId} is no longer an active exception.`);
      }
      if (!isResolutionAction(action)) throw new Error(`Unsupported resolution action: ${action}`);
      const proposalId = `PROP-${randomUUID().slice(0, 8)}`;
      const createdAt = new Date();
      const record = await tx.resolutionProposalRecord.create({
        data: {
          id: proposalId,
          orderInternalId: orderRecord.id,
          action,
          rationale,
          evidence: jsonValue(context.evidence),
          expectedChanges: jsonValue(context.expectedChanges),
          risk: context.risk,
          status: "pending",
          createdAt,
        },
        include: { order: true },
      });
      await tx.orderAuditEvent.create({
        data: {
          orderInternalId: orderRecord.id,
          proposalId,
          eventType: "resolution_proposed",
          actorType: "system",
          actorId: "order-ops-mcp",
          reason: rationale,
          occurredAt: createdAt,
          payload: jsonValue({ action, risk: context.risk }),
        },
      });
      return proposalFromRecord(record);
    });
  }

  async confirmResolution(
    proposalId: string,
    approvedBy = AUTHENTICATED_OPERATOR,
  ): Promise<{ order: Order; proposal: ResolutionProposal }> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM resolution_proposals WHERE id = ${proposalId} FOR UPDATE`);
        const proposalRecord = await tx.resolutionProposalRecord.findUnique({
          where: { id: proposalId },
          include: { order: true },
        });
        if (!proposalRecord) throw new Error(`No such proposal: ${proposalId}`);

        if (proposalRecord.status === "confirmed") {
          const result = proposalRecord.confirmationResult as { order: Order; proposal: ResolutionProposal } | null;
          if (result) return result;
          throw new Error(`Proposal ${proposalId} is confirmed but has no recorded result.`);
        }
        if (proposalRecord.status !== "pending") {
          throw new Error(`Proposal ${proposalId} is already ${proposalRecord.status}`);
        }

        await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id = ${proposalRecord.orderInternalId} FOR UPDATE`);
        const orderRecord = ensureOrderRecord(
          await tx.orderRecord.findUnique({ where: { id: proposalRecord.orderInternalId } }),
          proposalRecord.order.orderNumber,
        );
        const order = publicOrder(orderRecord);
        if (!isException(order)) throw new Error(`Order ${order.id} is no longer an active exception.`);
        if (!isResolutionAction(proposalRecord.action)) {
          throw new Error(`Unsupported resolution action: ${proposalRecord.action}`);
        }
        const before = {
          status: order.status,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          inventoryReserved: order.inventoryReserved,
        };
        applyAction(order, proposalRecord.action as ResolutionAction);
        const occurredAt = new Date();
        if (proposalRecord.action !== "escalate_to_human") order.operations.resolvedAt = occurredAt.toISOString();
        order.timeline.push({
          at: occurredAt.toISOString(),
          label: `Resolution confirmed by ${approvedBy}: ${proposalRecord.action}`,
        });

        const proposal = proposalFromRecord(proposalRecord);
        proposal.status = "confirmed";
        const result = { order, proposal };
        await tx.orderRecord.update({
          where: { id: orderRecord.id },
          data: {
            status: order.status,
            paymentStatus: order.paymentStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            priority: order.operations.priority,
            assignedTeam: order.operations.assignedTeam,
            isActiveException: isException(order),
            resolvedAt: order.operations.resolvedAt ? new Date(order.operations.resolvedAt) : null,
            data: jsonValue(order),
            version: { increment: 1 },
          },
        });
        await tx.resolutionProposalRecord.update({
          where: { id: proposalId },
          data: {
            status: "confirmed",
            confirmedAt: occurredAt,
            approvedBy,
            confirmationKey: proposalId,
            confirmationResult: jsonValue(result),
          },
        });
        await tx.orderAuditEvent.create({
          data: {
            orderInternalId: orderRecord.id,
            proposalId,
            eventType: "resolution_confirmed",
            actorType: "operator",
            actorId: approvedBy,
            reason: proposalRecord.rationale,
            occurredAt,
            beforeState: jsonValue(before),
            afterState: jsonValue({
              status: order.status,
              paymentStatus: order.paymentStatus,
              fulfillmentStatus: order.fulfillmentStatus,
              inventoryReserved: order.inventoryReserved,
            }),
            payload: jsonValue({ action: proposalRecord.action }),
          },
        });
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      },
    );
  }

  async injectFailure(): Promise<Order> {
    const generated = generateOneFailure();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ next_value: number }>>(
        Prisma.sql`SELECT next_value FROM order_number_sequences WHERE name = ${ORDER_NUMBER_SEQUENCE} FOR UPDATE`,
      );
      const current = Number(rows[0]?.next_value ?? FIRST_PUBLIC_ORDER_SEQUENCE);
      const id = `ORD-${current}`;
      await tx.orderNumberSequence.update({ where: { name: ORDER_NUMBER_SEQUENCE }, data: { nextValue: current + 1 } });
      generated.id = id;
      const created = await tx.orderRecord.create({ data: orderWriteData(generated, "generated") });
      await tx.orderAuditEvent.create({
        data: {
          orderInternalId: created.id,
          eventType: "failure_injected",
          actorType: "system",
          actorId: "order-ops-mcp",
          reason: "Synthetic failure injected by the demo helper",
          occurredAt: new Date(),
          afterState: jsonValue({ exceptionType: exceptionType(generated), summary: exceptionSummary(generated) }),
          payload: jsonValue({ source: "simulate_new_failure" }),
        },
      });
      return generated;
    });
  }
}

export async function createPostgresOrdersProvider(prisma: PrismaClient): Promise<OrdersProvider> {
  const provider = new PostgresOrdersProvider(prisma);
  await provider.initialize();
  return provider;
}
