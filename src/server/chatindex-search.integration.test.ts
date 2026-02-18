import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { ConversationType, PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { resetDatabase, seedDatabase } from "@/server/seed-data";

type SearchChatIndexFn = (typeof import("@/server/chatindex-search"))["searchChatIndex"];

describe("chatindex-search integration", () => {
  let prisma: PrismaClient;
  let tempDir: string;
  let databaseUrl: string;
  let initSqlPath: string;
  let searchChatIndex: SearchChatIndexFn;

  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-chatindex-search-"));
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

    vi.resetModules();
    ({ searchChatIndex } = await import("@/server/chatindex-search"));
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedDatabase(prisma);
  });

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    await prisma.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns channel, dm, and message hits for a user-scoped query", async () => {
    const marker = "chatidxorion";

    const dmPeer = await prisma.user.create({
      data: {
        id: `u_${marker}`,
        displayName: `${marker} teammate`,
        avatarColor: "#0EA5E9",
      },
    });

    const channel = await prisma.channel.create({
      data: {
        id: `ch_${marker}`,
        slug: marker,
        name: `${marker} updates`,
      },
    });

    const channelConversation = await prisma.conversation.create({
      data: {
        type: ConversationType.CHANNEL,
        channelId: channel.id,
      },
    });

    const dmConversation = await prisma.conversation.create({
      data: {
        type: ConversationType.DM,
        dmUserAId: "u_alex",
        dmUserBId: dmPeer.id,
      },
    });

    const channelMessage = await prisma.message.create({
      data: {
        conversationId: channelConversation.id,
        senderId: "u_alex",
        body: `${marker} launch prep is complete.`,
      },
    });

    const dmMessage = await prisma.message.create({
      data: {
        conversationId: dmConversation.id,
        senderId: dmPeer.id,
        body: `Confirming ${marker} rollout in DM.`,
      },
    });

    const payload = await searchChatIndex(prisma, {
      query: marker,
      userId: "u_alex",
      limit: 30,
    });

    expect(payload.total).toBeGreaterThanOrEqual(4);
    expect(
      payload.results.some(
        (entry) =>
          entry.kind === "channel" &&
          entry.conversationId === channelConversation.id &&
          entry.channelSlug === marker,
      ),
    ).toBe(true);
    expect(
      payload.results.some(
        (entry) =>
          entry.kind === "dm" &&
          entry.conversationId === dmConversation.id &&
          entry.otherUserId === dmPeer.id,
      ),
    ).toBe(true);
    expect(
      payload.results.some(
        (entry) =>
          entry.kind === "message" &&
          (entry.messageId === channelMessage.id || entry.messageId === dmMessage.id),
      ),
    ).toBe(true);
  });

  it("returns USER_NOT_FOUND when the user does not exist", async () => {
    await expect(
      searchChatIndex(prisma, {
        query: "general",
        userId: "u_missing",
      }),
    ).rejects.toMatchObject({
      errorCode: "USER_NOT_FOUND",
      status: 404,
    });
  });
});
