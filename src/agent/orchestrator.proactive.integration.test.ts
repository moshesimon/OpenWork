import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { AgentTaskSource, PrismaClient } from "@prisma/client";
import { resetDatabase, seedDatabase } from "@/server/seed-data";

function asMetaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected event log meta to be a JSON object.");
  }

  return value as Record<string, unknown>;
}

function stableTriggerRef(sourceMessageId: string): string {
  return `message:${sourceMessageId}`;
}

describe("orchestrator system-event dedupe", () => {
  let prisma: PrismaClient;
  let tempDir: string;
  let databaseUrl: string;
  let initSqlPath: string;
  let runAgentTurnFn: (typeof import("@/agent/orchestrator"))["runAgentTurn"];
  const originalProvider = process.env.AI_PROVIDER;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-orchestrator-proactive-"));
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

  async function runSystemEventTurn(input: {
    userId: string;
    source: AgentTaskSource;
    triggerRef: string;
    event: {
      sourceConversationId: string;
      sourceMessageId: string;
      sourceSenderId: string;
      messageBody: string;
      isDm: boolean;
    };
    idempotencyKey?: string;
  }): Promise<void> {
    const result = await runAgentTurnFn(prisma, {
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      trigger: {
        type: "SYSTEM_EVENT",
        payload: {
          source: input.source,
          triggerRef: input.triggerRef,
          event: input.event,
        },
      },
    });

    expect(result).toEqual({
      triggerType: "SYSTEM_EVENT",
      handled: true,
    });
  }

  it("skips duplicate system-event runs for the same triggerRef", async () => {
    const sourceMessage = await prisma.message.findFirst({
      where: {
        senderId: "u_alex",
        conversation: {
          type: "DM",
        },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
      },
    });

    expect(sourceMessage).toBeTruthy();

    const baseline = Date.now();
    const normalizedTriggerRef = stableTriggerRef(sourceMessage?.id ?? "");
    const input = {
      userId: "u_brooke",
      triggerRef: sourceMessage?.id ?? "",
      event: {
        sourceConversationId: sourceMessage?.conversationId ?? "",
        sourceMessageId: sourceMessage?.id ?? "",
        sourceSenderId: sourceMessage?.senderId ?? "",
        messageBody: sourceMessage?.body ?? "",
        isDm: true,
      },
    };

    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.INBOUND_DM_MESSAGE,
    });
    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.BOOTSTRAP_REFRESH,
    });

    const tasks = await prisma.agentTask.findMany({
      where: {
        userId: input.userId,
        triggerRef: normalizedTriggerRef,
        source: {
          in: [
            AgentTaskSource.INBOUND_CHANNEL_MESSAGE,
            AgentTaskSource.INBOUND_DM_MESSAGE,
            AgentTaskSource.BOOTSTRAP_REFRESH,
          ],
        },
      },
      orderBy: { createdAt: "asc" },
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.source).toBe(AgentTaskSource.INBOUND_DM_MESSAGE);
    expect(tasks[0]?.status).toBe("COMPLETED");

    const profile = await prisma.agentProfile.findUnique({
      where: { userId: input.userId },
      select: { lastAnalysisAt: true },
    });

    expect(profile?.lastAnalysisAt).toBeTruthy();
    expect((profile?.lastAnalysisAt?.getTime() ?? 0) >= baseline).toBe(true);
  });

  it("dedupes concurrent system-event runs with the same triggerRef", async () => {
    const sourceMessage = await prisma.message.findFirst({
      where: {
        senderId: "u_alex",
        conversation: {
          type: "DM",
        },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
      },
    });

    expect(sourceMessage).toBeTruthy();

    const input = {
      userId: "u_brooke",
      source: AgentTaskSource.INBOUND_DM_MESSAGE,
      triggerRef: sourceMessage?.id ?? "",
      event: {
        sourceConversationId: sourceMessage?.conversationId ?? "",
        sourceMessageId: sourceMessage?.id ?? "",
        sourceSenderId: sourceMessage?.senderId ?? "",
        messageBody: sourceMessage?.body ?? "",
        isDm: true,
      },
    };

    await Promise.all([
      runSystemEventTurn(input),
      runSystemEventTurn(input),
      runSystemEventTurn(input),
      runSystemEventTurn(input),
    ]);

    const tasks = await prisma.agentTask.findMany({
      where: {
        userId: input.userId,
        triggerRef: stableTriggerRef(sourceMessage?.id ?? ""),
        source: {
          in: [
            AgentTaskSource.INBOUND_CHANNEL_MESSAGE,
            AgentTaskSource.INBOUND_DM_MESSAGE,
            AgentTaskSource.BOOTSTRAP_REFRESH,
          ],
        },
      },
      select: { id: true, status: true },
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("COMPLETED");
  });

  it("uses a stable system-event idempotency key in runAgentTurn", async () => {
    const sourceMessage = await prisma.message.findFirst({
      where: {
        senderId: "u_alex",
        conversation: {
          type: "DM",
        },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
      },
    });

    expect(sourceMessage).toBeTruthy();

    const eventPayload = {
      source: AgentTaskSource.INBOUND_DM_MESSAGE,
      event: {
        sourceConversationId: sourceMessage?.conversationId ?? "",
        sourceMessageId: sourceMessage?.id ?? "",
        sourceSenderId: sourceMessage?.senderId ?? "",
        messageBody: sourceMessage?.body ?? "",
        isDm: true,
      },
    };

    await runAgentTurnFn(prisma, {
      userId: "u_brooke",
      trigger: {
        type: "SYSTEM_EVENT",
        payload: {
          ...eventPayload,
          triggerRef: "legacy-trigger-a",
        },
      },
    });
    await runAgentTurnFn(prisma, {
      userId: "u_brooke",
      trigger: {
        type: "SYSTEM_EVENT",
        payload: {
          ...eventPayload,
          triggerRef: "legacy-trigger-b",
        },
      },
    });

    const tasks = await prisma.agentTask.findMany({
      where: {
        userId: "u_brooke",
        source: AgentTaskSource.INBOUND_DM_MESSAGE,
        triggerRef: `message:${sourceMessage?.id ?? ""}`,
      },
      select: { id: true },
    });

    expect(tasks).toHaveLength(1);
  });

  it("does not create a second system-event briefing for the same source message", async () => {
    const dmConversation = await prisma.conversation.findFirst({
      where: {
        type: "DM",
        OR: [
          { dmUserAId: "u_alex", dmUserBId: "u_brooke" },
          { dmUserAId: "u_brooke", dmUserBId: "u_alex" },
        ],
      },
      select: { id: true },
    });

    expect(dmConversation).toBeTruthy();

    const sourceMessage = await prisma.message.create({
      data: {
        conversationId: dmConversation?.id ?? "",
        senderId: "u_alex",
        body: "Urgent blocker: please send an update today.",
      },
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
      },
    });

    const input = {
      userId: "u_brooke",
      event: {
        sourceConversationId: sourceMessage.conversationId,
        sourceMessageId: sourceMessage.id,
        sourceSenderId: sourceMessage.senderId,
        messageBody: sourceMessage.body,
        isDm: true,
      },
    };

    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.INBOUND_DM_MESSAGE,
      triggerRef: sourceMessage.id,
    });
    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.BOOTSTRAP_REFRESH,
      triggerRef: `${sourceMessage.id}-bootstrap-retry`,
    });

    const briefings = await prisma.briefingItem.findMany({
      where: {
        userId: "u_brooke",
        sourceConversationId: sourceMessage.conversationId,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        sourceMessageIdsJson: true,
      },
    });

    const matchingBriefings = briefings.filter((item) =>
      Array.isArray(item.sourceMessageIdsJson) &&
      item.sourceMessageIdsJson.some(
        (sourceId): sourceId is string =>
          typeof sourceId === "string" && sourceId === sourceMessage.id,
      ),
    );

    expect(matchingBriefings).toHaveLength(1);

    const tasks = await prisma.agentTask.findMany({
      where: {
        userId: "u_brooke",
        triggerRef: stableTriggerRef(sourceMessage.id),
      },
      select: { id: true },
    });

    expect(tasks).toHaveLength(1);
  });

  it("writes a single system-event AI chat note for repeated source events", async () => {
    const dmConversation = await prisma.conversation.findFirst({
      where: {
        type: "DM",
        OR: [
          { dmUserAId: "u_alex", dmUserBId: "u_brooke" },
          { dmUserAId: "u_brooke", dmUserBId: "u_alex" },
        ],
      },
      select: { id: true },
    });

    expect(dmConversation).toBeTruthy();

    const sourceMessage = await prisma.message.create({
      data: {
        conversationId: dmConversation?.id ?? "",
        senderId: "u_alex",
        body: "FYI: note to me that latency has stabilized.",
      },
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
      },
    });

    const input = {
      userId: "u_brooke",
      event: {
        sourceConversationId: sourceMessage.conversationId,
        sourceMessageId: sourceMessage.id,
        sourceSenderId: sourceMessage.senderId,
        messageBody: sourceMessage.body,
        isDm: true,
      },
    };

    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.INBOUND_DM_MESSAGE,
      triggerRef: sourceMessage.id,
    });
    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.BOOTSTRAP_REFRESH,
      triggerRef: `${sourceMessage.id}-chat-retry`,
    });

    const proactiveNotes = await prisma.agentChatMessage.findMany({
      where: {
        userId: "u_brooke",
        role: "assistant",
        body: {
          contains: sourceMessage.body,
        },
        task: {
          source: {
            in: [
              AgentTaskSource.INBOUND_CHANNEL_MESSAGE,
              AgentTaskSource.INBOUND_DM_MESSAGE,
              AgentTaskSource.BOOTSTRAP_REFRESH,
            ],
          },
        },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    expect(proactiveNotes).toHaveLength(1);

    const completionLog = await prisma.agentEventLog.findFirst({
      where: {
        eventType: "turn_completed",
        task: {
          userId: "u_brooke",
          triggerRef: stableTriggerRef(sourceMessage.id),
        },
      },
      orderBy: { createdAt: "desc" },
      select: { metaJson: true },
    });

    const completionMeta = asMetaRecord(completionLog?.metaJson);
    expect(completionMeta.triggerType).toBe("SYSTEM_EVENT");
    expect(completionMeta.actionMix).toMatchObject({
      WRITE_AI_CHAT_MESSAGE: 1,
    });
  });

  it("does not send duplicate system-event messages for the same source event", async () => {
    const dmConversation = await prisma.conversation.findFirst({
      where: {
        type: "DM",
        OR: [
          { dmUserAId: "u_alex", dmUserBId: "u_brooke" },
          { dmUserAId: "u_brooke", dmUserBId: "u_alex" },
        ],
      },
      select: { id: true },
    });

    expect(dmConversation).toBeTruthy();

    const sourceMessage = await prisma.message.create({
      data: {
        conversationId: dmConversation?.id ?? "",
        senderId: "u_alex",
        body: "Please respond when you can.",
      },
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
      },
    });

    const input = {
      userId: "u_brooke",
      event: {
        sourceConversationId: sourceMessage.conversationId,
        sourceMessageId: sourceMessage.id,
        sourceSenderId: sourceMessage.senderId,
        messageBody: sourceMessage.body,
        isDm: true,
      },
    };

    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.INBOUND_DM_MESSAGE,
      triggerRef: sourceMessage.id,
    });
    await runSystemEventTurn({
      ...input,
      source: AgentTaskSource.BOOTSTRAP_REFRESH,
      triggerRef: `${sourceMessage.id}-send-retry`,
    });

    const deliveries = await prisma.outboundDelivery.findMany({
      where: {
        task: {
          userId: "u_brooke",
          source: {
            in: [
              AgentTaskSource.INBOUND_CHANNEL_MESSAGE,
              AgentTaskSource.INBOUND_DM_MESSAGE,
              AgentTaskSource.BOOTSTRAP_REFRESH,
            ],
          },
        },
        action: {
          type: "SEND_MESSAGE",
        },
      },
      select: {
        id: true,
      },
    });

    expect(deliveries).toHaveLength(1);
  });

  it("dedupes concurrent system-event sends by source event and action kind", async () => {
    const dmConversation = await prisma.conversation.findFirst({
      where: {
        type: "DM",
        OR: [
          { dmUserAId: "u_alex", dmUserBId: "u_brooke" },
          { dmUserAId: "u_brooke", dmUserBId: "u_alex" },
        ],
      },
      select: { id: true },
    });

    expect(dmConversation).toBeTruthy();

    const sourceMessage = await prisma.message.create({
      data: {
        conversationId: dmConversation?.id ?? "",
        senderId: "u_alex",
        body: "Please reply with an update.",
      },
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
      },
    });

    const sharedInput = {
      userId: "u_brooke",
      source: AgentTaskSource.INBOUND_DM_MESSAGE,
      event: {
        sourceConversationId: sourceMessage.conversationId,
        sourceMessageId: sourceMessage.id,
        sourceSenderId: sourceMessage.senderId,
        messageBody: sourceMessage.body,
        isDm: true,
      },
    };

    await Promise.all([
      runSystemEventTurn({
        ...sharedInput,
        triggerRef: `${sourceMessage.id}-race-1`,
      }),
      runSystemEventTurn({
        ...sharedInput,
        triggerRef: `${sourceMessage.id}-race-2`,
      }),
    ]);

    const deliveries = await prisma.outboundDelivery.findMany({
      where: {
        task: {
          userId: "u_brooke",
          source: {
            in: [
              AgentTaskSource.INBOUND_CHANNEL_MESSAGE,
              AgentTaskSource.INBOUND_DM_MESSAGE,
              AgentTaskSource.BOOTSTRAP_REFRESH,
            ],
          },
        },
        action: {
          type: "SEND_MESSAGE",
        },
      },
      select: { id: true },
    });

    expect(deliveries).toHaveLength(1);

    const dedupeRecords = await prisma.agentProactiveOutputDedup.findMany({
      where: {
        userId: "u_brooke",
        sourceConversationId: sourceMessage.conversationId,
        sourceEventId: sourceMessage.id,
        actionKind: "SEND_MESSAGE",
      },
      select: {
        id: true,
        outputId: true,
      },
    });

    expect(dedupeRecords).toHaveLength(1);
    expect(dedupeRecords[0]?.outputId).toBeTruthy();
  });
});
