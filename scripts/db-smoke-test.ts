/**
 * Small integration check for a disposable Supabase/Postgres database.
 * Run only with PERSISTENCE_MODE=postgres and a DATABASE_URL configured.
 */
import "dotenv/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Copy a Supabase connection string into .env first.");
  }
  process.env.PERSISTENCE_MODE = "postgres";

  const { getPrismaClient, disconnectPrismaClient } = await import("../src/data/database.js");
  const { createPostgresOrdersProvider } = await import("../src/data/postgres-store.js");
  const prisma = getPrismaClient();

  try {
    const provider = await createPostgresOrdersProvider(prisma);
    const firstList = await provider.listExceptions();
    assert(firstList.length >= 4, `expected seeded exceptions, got ${firstList.length}`);

    const firstOrderCount = await prisma.orderRecord.count();
    await createPostgresOrdersProvider(prisma);
    const secondOrderCount = await prisma.orderRecord.count();
    assert(firstOrderCount === secondOrderCount, "re-running bootstrap must not duplicate orders");

    const target = firstList[0];
    assert(target, "expected at least one exception for the workflow check");
    const proposal = await provider.proposeResolution(target.id, "escalate_to_human", "database smoke test");
    const firstConfirmation = await provider.confirmResolution(proposal.id, "Database Smoke Test");
    const repeatConfirmation = await provider.confirmResolution(proposal.id, "Database Smoke Test");
    assert(firstConfirmation.order.id === target.id, "confirmation must keep the public order id");
    assert(repeatConfirmation.proposal.status === "confirmed", "repeat confirmation must be idempotent");

    const audit = await provider.getAuditLog(target.id);
    assert(audit.length >= 2, "proposal and confirmation must create audit events");
    assert(!audit.some((entry) => "id" in entry), "audit output must not expose internal event ids");

    console.log(`Database smoke passed: ${firstOrderCount} orders, ${audit.length} audit events for ${target.id}.`);
  } finally {
    await disconnectPrismaClient();
  }
}

main().catch((error) => {
  console.error("DATABASE SMOKE FAILED:", error);
  process.exitCode = 1;
});
