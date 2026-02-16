import { createPrismaClient } from "../src/lib/prisma";
import { resetDatabase, seedDatabase } from "../src/server/seed-data";

const prisma = createPrismaClient();

async function main() {
  await resetDatabase(prisma);
  await seedDatabase(prisma);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("Seed failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
