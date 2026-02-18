import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { resetDatabase, seedDatabase } from "@/server/seed-data";

function asMetaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected event log meta to be a JSON object.");
  }

  return value as Record<string, unknown>;
}

describe("orchestrator task intents", () => {
  let prisma: PrismaClient;
  let tempDir: string;
  let databaseUrl: string;
  let initSqlPath: string;
  let runAgentTurnFn: (typeof import("@/agent/orchestrator"))["runAgentTurn"];
  const originalProvider = process.env.AI_PROVIDER;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-orchestrator-tasks-"));
    databaseUrl = `file:${path.join(tempDir, "integration.db")}`;
    initSqlPath = path.join(tempDir, "init.sql");

    const commonExecConfig = {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      stdio: "pipe" as const,
    };

    execSync(
      `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > ${initSqlPath}`,
      commonExecConfig,
    );
    execSync(`npx prisma db execute --file ${initSqlPath}`, commonExecConfig);

    const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
    prisma = new PrismaClient({ adapter });

    process.env.DATABASE_URL = databaseUrl;
    ({ runAgentTurn: runAgentTurnFn } = await import("@/agent/orchestrator"));
  });

  beforeEach(async () => {
    process.env.AI_PROVIDER = "mock";
    await resetDatabase(prisma);
    await seedDatabase(prisma);
  });

  afterAll(async () => {
    if (originalProvider === undefined) {
      delete process.env.AI_PROVIDER;
    } else {
      process.env.AI_PROVIDER = originalProvider;
    }

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    await prisma.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function runUserMessageTurn(userId: string, input: string): Promise<{ taskId: string; reply: string }> {
    const result = await runAgentTurnFn(prisma, {
      userId,
      trigger: {
        type: "USER_MESSAGE",
        payload: {
          input,
        },
      },
    });

    if (result.triggerType !== "USER_MESSAGE") {
      throw new Error("Expected USER_MESSAGE result.");
    }

    return result;
  }

  it("creates tasks and updates their status from AI commands", async () => {
    const createResult = await runUserMessageTurn("u_alex", 'Add a task: "Legal review"');

    expect(createResult.reply).toContain("Created task");

    const createdTask = await prisma.workspaceTask.findFirst({
      where: {
        createdById: "u_alex",
        title: {
          contains: "Legal review",
        },
      },
      orderBy: { createdAt: "desc" },
    });

    expect(createdTask).toBeTruthy();
    expect(createdTask?.status).toBe("OPEN");

    const updateResult = await runUserMessageTurn("u_alex", 'Mark task "Legal review" done');

    expect(updateResult.reply).toContain('Moved "');
    expect(updateResult.reply).toContain("to done");

    const doneTask = await prisma.workspaceTask.findUnique({
      where: { id: createdTask?.id ?? "" },
    });

    expect(doneTask?.status).toBe("DONE");

    const completionLog = await prisma.agentEventLog.findFirst({
      where: {
        taskId: createResult.taskId,
        eventType: "turn_completed",
      },
      orderBy: { createdAt: "desc" },
      select: { metaJson: true },
    });

    const completionMeta = asMetaRecord(completionLog?.metaJson);
    expect(completionMeta.triggerType).toBe("USER_MESSAGE");
    expect(completionMeta.actionMix).toMatchObject({
      CREATE_WORKSPACE_TASK: 1,
    });
  });

  it("updates task status across users", async () => {
    const sharedTask = await prisma.workspaceTask.create({
      data: {
        title: "Cross-user incident audit",
        description: "Validate incident timelines.",
        urgency: "HIGH",
        status: "OPEN",
        sortRank: 1,
        createdById: "u_brooke",
        assigneeId: "u_brooke",
      },
    });

    const updateResult = await runUserMessageTurn(
      "u_alex",
      'Mark task "Cross-user incident audit" done',
    );

    expect(updateResult.reply).toContain("to done");

    const updatedTask = await prisma.workspaceTask.findUnique({
      where: { id: sharedTask.id },
    });

    expect(updatedTask?.status).toBe("DONE");
  });
});
