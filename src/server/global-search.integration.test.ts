import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { resetDatabase, seedDatabase } from "@/server/seed-data";

type SearchWorkspaceGlobalFn = (typeof import("@/server/global-search"))["searchWorkspaceGlobal"];

describe("global-search integration", () => {
  let prisma: PrismaClient;
  let tempDir: string;
  let workspaceRoot: string;
  let databaseUrl: string;
  let initSqlPath: string;
  let searchWorkspaceGlobal: SearchWorkspaceGlobalFn;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalWorkspaceRoot = process.env.WORKSPACE_FILES_ROOT;
  const originalChatIndexUrl = process.env.CHATINDEX_SEARCH_URL;
  const originalPageIndexUrl = process.env.PAGEINDEX_SEARCH_URL;
  const originalOfficeIndexUrl = process.env.OFFICEINDEX_SEARCH_URL;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-global-search-"));
    workspaceRoot = path.join(tempDir, "workspace");
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
    process.env.WORKSPACE_FILES_ROOT = workspaceRoot;

    vi.resetModules();
    ({ searchWorkspaceGlobal } = await import("@/server/global-search"));
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CHATINDEX_SEARCH_URL;
    delete process.env.PAGEINDEX_SEARCH_URL;
    delete process.env.OFFICEINDEX_SEARCH_URL;
    await resetDatabase(prisma);
    await seedDatabase(prisma);
    await mkdir(path.join(workspaceRoot, "plans"), { recursive: true });
  });

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalWorkspaceRoot === undefined) {
      delete process.env.WORKSPACE_FILES_ROOT;
    } else {
      process.env.WORKSPACE_FILES_ROOT = originalWorkspaceRoot;
    }

    if (originalChatIndexUrl === undefined) {
      delete process.env.CHATINDEX_SEARCH_URL;
    } else {
      process.env.CHATINDEX_SEARCH_URL = originalChatIndexUrl;
    }

    if (originalPageIndexUrl === undefined) {
      delete process.env.PAGEINDEX_SEARCH_URL;
    } else {
      process.env.PAGEINDEX_SEARCH_URL = originalPageIndexUrl;
    }

    if (originalOfficeIndexUrl === undefined) {
      delete process.env.OFFICEINDEX_SEARCH_URL;
    } else {
      process.env.OFFICEINDEX_SEARCH_URL = originalOfficeIndexUrl;
    }

    await prisma.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFixtures(marker: string): Promise<{
    filePath: string;
    taskId: string;
    eventId: string;
    userId: string;
    messageId: string;
  }> {
    const filePath = `plans/${marker}-notes.md`;
    await writeFile(
      path.join(workspaceRoot, filePath),
      `Roadmap notes for ${marker}. This file tracks ${marker} launch details.`,
      "utf8",
    );

    const task = await prisma.workspaceTask.create({
      data: {
        title: `${marker} launch checklist`,
        description: `Prepare ${marker} rollout and confirm ownership.`,
        urgency: "HIGH",
        status: "OPEN",
        sortRank: 42,
        createdById: "u_alex",
        assigneeId: "u_alex",
      },
    });

    const startAt = new Date();
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);
    const event = await prisma.calendarEvent.create({
      data: {
        ownerId: "u_alex",
        createdById: "u_alex",
        title: `${marker} launch sync`,
        description: `Discuss ${marker} readiness and handoff.`,
        location: `${marker} room`,
        startAt,
        endAt,
        allDay: false,
      },
    });

    const userId = `u_${marker.toLowerCase()}`;
    await prisma.user.create({
      data: {
        id: userId,
        displayName: `${marker} Coordinator`,
        avatarColor: "#0EA5E9",
      },
    });

    const message = await prisma.message.create({
      data: {
        conversationId: "conv_ch_general",
        senderId: "u_alex",
        body: `${marker} migration is complete and ready for review.`,
      },
    });

    return {
      filePath,
      taskId: task.id,
      eventId: event.id,
      userId,
      messageId: message.id,
    };
  }

  it("returns native matches across message, file, task, event, and user", async () => {
    const marker = "zephyrscope";
    const fixtures = await createFixtures(marker);

    const payload = await searchWorkspaceGlobal(prisma, "u_alex", {
      query: marker,
      limit: 50,
    });

    expect(payload.providers).toEqual({
      chat: "native",
      files: "native",
    });
    expect(payload.results.some((entry) => entry.kind === "message" && entry.messageId === fixtures.messageId)).toBe(true);
    expect(payload.results.some((entry) => entry.kind === "file" && entry.filePath === fixtures.filePath)).toBe(true);
    expect(payload.results.some((entry) => entry.kind === "task" && entry.taskId === fixtures.taskId)).toBe(true);
    expect(payload.results.some((entry) => entry.kind === "event" && entry.eventId === fixtures.eventId)).toBe(true);
    expect(payload.results.some((entry) => entry.kind === "user" && entry.userId === fixtures.userId)).toBe(true);
  });

  it("merges external provider results with native search when endpoints are configured", async () => {
    const marker = "orbitmerge";
    await createFixtures(marker);

    process.env.CHATINDEX_SEARCH_URL = "https://chatindex.test/search";
    process.env.PAGEINDEX_SEARCH_URL = "https://pageindex.test/search";
    process.env.OFFICEINDEX_SEARCH_URL = "https://officeindex.test/search";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === process.env.CHATINDEX_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            results: [
              {
                kind: "message",
                id: "ext-msg-1",
                messageId: "ext-msg-1",
                conversationId: "conv_ch_general",
                title: `${marker} external chat`,
                subtitle: "ChatIndex hit",
                snippet: `External chat hit for ${marker}`,
                score: 300,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === process.env.PAGEINDEX_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            results: [
              {
                filePath: `external/${marker}.md`,
                title: `${marker} external file`,
                snippet: `External file hit for ${marker}`,
                score: 280,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === process.env.OFFICEINDEX_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            results: [
              {
                filePath: `office/${marker}.docx`,
                title: `${marker} external office file`,
                snippet: `Office file hit for ${marker}`,
                score: 310,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("{}", { status: 404 });
    });

    const payload = await searchWorkspaceGlobal(prisma, "u_alex", {
      query: marker,
      limit: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(payload.providers).toEqual({
      chat: "chatindex-service+native",
      files: "officeindex-service+pageindex-service+native",
    });
    expect(payload.results.some((entry) => entry.source === "chatindex-service" && entry.id === "chatidx:ext-msg-1")).toBe(true);
    expect(payload.results.some((entry) => entry.source === "pageindex-service" && entry.filePath === `external/${marker}.md`)).toBe(true);
    expect(payload.results.some((entry) => entry.source === "officeindex-service" && entry.filePath === `office/${marker}.docx`)).toBe(true);
  });

  it("uses mocked OfficeIndex endpoint when only office provider is configured", async () => {
    const marker = "officeonly";
    await createFixtures(marker);

    process.env.OFFICEINDEX_SEARCH_URL = "https://officeindex.test/search";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === process.env.OFFICEINDEX_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            results: [
              {
                filePath: `office/${marker}.pptx`,
                title: `${marker} deck`,
                snippet: `office endpoint hit for ${marker}`,
                score: 315,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("{}", { status: 404 });
    });

    const payload = await searchWorkspaceGlobal(prisma, "u_alex", {
      query: marker,
      limit: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload.providers.files).toBe("officeindex-service+native");
    expect(payload.results.some((entry) => entry.source === "officeindex-service" && entry.filePath === `office/${marker}.pptx`)).toBe(true);
  });

  it("falls back to native provider labels when external search endpoints fail", async () => {
    const marker = "nativefallback";
    const fixtures = await createFixtures(marker);

    process.env.CHATINDEX_SEARCH_URL = "https://chatindex.test/search";
    process.env.PAGEINDEX_SEARCH_URL = "https://pageindex.test/search";
    process.env.OFFICEINDEX_SEARCH_URL = "https://officeindex.test/search";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("service unavailable", { status: 503 }),
    );

    const payload = await searchWorkspaceGlobal(prisma, "u_alex", {
      query: marker,
      limit: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(payload.providers).toEqual({
      chat: "native",
      files: "native",
    });
    expect(payload.results.some((entry) => entry.kind === "task" && entry.taskId === fixtures.taskId)).toBe(true);
  });

  it("dedupes same file path from office/page/native providers using the highest score", async () => {
    const marker = "filededupe";
    const fixtures = await createFixtures(marker);

    process.env.PAGEINDEX_SEARCH_URL = "https://pageindex.test/search";
    process.env.OFFICEINDEX_SEARCH_URL = "https://officeindex.test/search";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === process.env.PAGEINDEX_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            results: [
              {
                filePath: fixtures.filePath,
                title: `${marker} page provider`,
                snippet: `${marker} page snippet`,
                score: 290,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === process.env.OFFICEINDEX_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            results: [
              {
                filePath: fixtures.filePath,
                title: `${marker} office provider`,
                snippet: `${marker} office snippet`,
                score: 360,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("{}", { status: 404 });
    });

    const payload = await searchWorkspaceGlobal(prisma, "u_alex", {
      query: marker,
      limit: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payload.providers.files).toBe("officeindex-service+pageindex-service+native");

    const matchingFiles = payload.results.filter(
      (entry) => entry.kind === "file" && entry.filePath === fixtures.filePath,
    );
    expect(matchingFiles).toHaveLength(1);
    expect(matchingFiles[0]?.source).toBe("officeindex-service");
    expect(matchingFiles[0]?.id).toBe(`officeidx:${fixtures.filePath}`);
  });
});
