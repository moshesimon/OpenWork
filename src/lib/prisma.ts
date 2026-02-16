import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function resolveDatabaseUrl(explicitUrl?: string): string {
  const url = explicitUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured.");
  }
  return url;
}

export function createPrismaClient(explicitUrl?: string): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl(explicitUrl) });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
