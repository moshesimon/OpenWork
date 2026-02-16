import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  createDmMessage,
  createConversationMessage,
  getBootstrapData,
  getConversationMessagesPage,
  markConversationRead,
} from "@/server/chat-service";
import { resetDatabase, seedDatabase } from "@/server/seed-data";

describe("chat-service integration", () => {
  let prisma: PrismaClient;
  let tempDir: string;
  let databaseUrl: string;
  let initSqlPath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "thin-slack-tests-"));
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
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns bootstrap payload with channels and DM roster", async () => {
    const payload = await getBootstrapData(prisma, "u_alex");

    expect(payload.activeUser.id).toBe("u_alex");
    expect(payload.users).toHaveLength(5);
    expect(payload.channels).toHaveLength(3);
    expect(payload.dms).toHaveLength(4);
  });

  it("tracks unread channel messages and clears on mark read", async () => {
    const before = await getBootstrapData(prisma, "u_brooke");
    const generalConversationId = before.channels.find(
      (channel) => channel.channel.slug === "general",
    )?.conversationId;

    expect(generalConversationId).toBeTruthy();

    await createConversationMessage(
      prisma,
      "u_alex",
      generalConversationId as string,
      "Status ping for Brooke",
    );

    const unreadPayload = await getBootstrapData(prisma, "u_brooke");
    const generalUnread = unreadPayload.channels.find(
      (channel) => channel.channel.slug === "general",
    )?.unreadCount;

    expect(generalUnread).toBeGreaterThan(0);

    await markConversationRead(prisma, "u_brooke", generalConversationId as string);

    const afterRead = await getBootstrapData(prisma, "u_brooke");
    const clearedUnread = afterRead.channels.find(
      (channel) => channel.channel.slug === "general",
    )?.unreadCount;

    expect(clearedUnread).toBe(0);
  });

  it("auto-creates DM conversation on first send", async () => {
    const dmResponse = await createDmMessage(
      prisma,
      "u_alex",
      "u_diego",
      "Want to pair on tests?",
    );

    expect(dmResponse.conversationId).toBeTruthy();

    const diegoView = await getBootstrapData(prisma, "u_diego");
    const alexDm = diegoView.dms.find((dm) => dm.otherUser.id === "u_alex");

    expect(alexDm?.conversationId).toBe(dmResponse.conversationId);
    expect(alexDm?.unreadCount).toBe(1);
  });

  it("supports latest-50 pagination and load older flow", async () => {
    const bootstrap = await getBootstrapData(prisma, "u_alex");
    const targetConversationId = bootstrap.channels[0]?.conversationId;
    expect(targetConversationId).toBeTruthy();

    const start = Date.now() - 1000 * 60 * 20;
    await prisma.message.createMany({
      data: Array.from({ length: 65 }).map((_, index) => ({
        id: `msg_bulk_${index}`,
        conversationId: targetConversationId as string,
        senderId: "u_alex",
        body: `bulk-${index}`,
        createdAt: new Date(start + index * 1000),
      })),
    });

    const firstPage = await getConversationMessagesPage(
      prisma,
      "u_alex",
      targetConversationId as string,
      null,
      "50",
    );

    expect(firstPage.messages).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();

    const firstPageIds = new Set(firstPage.messages.map((message) => message.id));

    const secondPage = await getConversationMessagesPage(
      prisma,
      "u_alex",
      targetConversationId as string,
      firstPage.nextCursor,
      "50",
    );

    expect(secondPage.messages.length).toBeGreaterThan(0);
    expect(secondPage.messages.every((message) => !firstPageIds.has(message.id))).toBe(true);
  });
});
