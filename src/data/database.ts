import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../config/env.js";

let prisma: PrismaClient | undefined;

export function createPrismaClient(connectionString = env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required when PERSISTENCE_MODE=postgres.");
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export function getPrismaClient(): PrismaClient {
  prisma ??= createPrismaClient();
  return prisma;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = undefined;
}
