import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { resetDatabase, seedDatabase } from "@/server/seed-data";

type CalendarEventTestRow = {
  id: string;
  ownerId: string;
  title: string;
  startAt: Date;
  attendees?: {
    userId: string;
  }[];
};

type CalendarEventTestDelegate = {
  findFirst(args: unknown): Promise<CalendarEventTestRow | null>;
  findUnique(args: unknown): Promise<CalendarEventTestRow | null>;
};

function getCalendarEventDelegate(prisma: PrismaClient): CalendarEventTestDelegate {
  const delegate = (prisma as { calendarEvent?: unknown }).calendarEvent;
  if (!delegate) {
    throw new Error("Calendar model is unavailable on this Prisma client.");
  }

  return delegate as CalendarEventTestDelegate;
}

describe("orchestrator calendar intents", () => {
  let prisma: PrismaClient;
  let tempDir: string;
  let databaseUrl: string;
  let initSqlPath: string;
  let runAgentCommandFn: (typeof import("@/agent/orchestrator"))["runAgentCommand"];
  const originalProvider = process.env.AI_PROVIDER;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-orchestrator-calendar-"));
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
    ({ runAgentCommand: runAgentCommandFn } = await import("@/agent/orchestrator"));
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

  it("creates, updates, and deletes calendar events from AI commands", async () => {
    const calendarEvent = getCalendarEventDelegate(prisma);

    const createResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: 'Schedule a meeting "Roadmap review" tomorrow at 3pm for 45 minutes',
    });

    expect(createResult.reply).toContain('Created calendar event "Roadmap review"');

    const created = await calendarEvent.findFirst({
      where: { ownerId: "u_alex", title: "Roadmap review" },
    });

    expect(created).toBeTruthy();

    const originalStart = created?.startAt.toISOString();

    const updateResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: 'Reschedule "Roadmap review" to tomorrow at 4pm',
    });

    expect(updateResult.reply).toContain('Updated calendar event "Roadmap review"');

    const updated = await calendarEvent.findUnique({
      where: { id: created?.id ?? "" },
    });

    expect(updated).toBeTruthy();
    expect(updated?.startAt.toISOString()).not.toBe(originalStart);

    const deleteResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: 'Cancel meeting "Roadmap review"',
    });

    expect(deleteResult.reply).toContain('Deleted calendar event "Roadmap review"');

    const deleted = await calendarEvent.findUnique({
      where: { id: created?.id ?? "" },
    });

    expect(deleted).toBeNull();
  });

  it("returns calendar schedule summaries when user asks", async () => {
    const queryResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: "What's on my calendar this week?",
    });

    expect(queryResult.reply).toContain("Here is your calendar");
    expect(queryResult.reply).toContain("Launch planning sync");
  });

  it("can read and write calendar events for another user", async () => {
    const calendarEvent = getCalendarEventDelegate(prisma);

    const createResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: 'Schedule a meeting "Cross-team alignment" for Brooke tomorrow at 9am for 30 minutes',
    });

    expect(createResult.reply).toContain('Created calendar event "Cross-team alignment"');

    const created = await calendarEvent.findFirst({
      where: { ownerId: "u_brooke", title: "Cross-team alignment" },
    });
    expect(created).toBeTruthy();

    const queryResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: "Show Brooke's calendar for this week",
    });

    expect(queryResult.reply).toContain("Here is your calendar");
    expect(queryResult.reply).toContain("Cross-team alignment");

    const originalStart = created?.startAt.toISOString();
    const updateResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: 'Reschedule "Cross-team alignment" to tomorrow at 11am for Brooke',
    });

    expect(updateResult.reply).toContain('Updated calendar event "Cross-team alignment"');

    const updated = await calendarEvent.findUnique({
      where: { id: created?.id ?? "" },
    });
    expect(updated).toBeTruthy();
    expect(updated?.startAt.toISOString()).not.toBe(originalStart);
  });

  it("creates one shared event with multiple attendees", async () => {
    const calendarEvent = getCalendarEventDelegate(prisma);

    const createResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: 'Schedule a meeting "Shared planning" tomorrow at 2pm with Diego',
    });

    expect(createResult.reply).toContain('Created calendar event "Shared planning"');

    const created = await calendarEvent.findFirst({
      where: { ownerId: "u_alex", title: "Shared planning" },
      include: {
        attendees: {
          select: {
            userId: true,
          },
        },
      },
    });

    expect(created).toBeTruthy();
    const attendeeIds = (created?.attendees ?? []).map((attendee) => attendee.userId).sort();
    expect(attendeeIds).toEqual(["u_alex", "u_diego"]);

    const duplicates = await prisma.calendarEvent.findMany({
      where: { title: "Shared planning" },
    });
    expect(duplicates).toHaveLength(1);
  });

  it("includes earlier same-day events in calendar queries", async () => {
    const calendarEvent = getCalendarEventDelegate(prisma);
    const todayNine = new Date();
    todayNine.setHours(9, 0, 0, 0);
    const todayTen = new Date(todayNine.getTime() + 60 * 60 * 1000);

    await prisma.calendarEvent.create({
      data: {
        ownerId: "u_brooke",
        createdById: "u_brooke",
        title: "Morning sync check",
        description: "",
        location: "",
        startAt: todayNine,
        endAt: todayTen,
        allDay: false,
      },
    });

    const queryResult = await runAgentCommandFn(prisma, {
      userId: "u_alex",
      input: "Check Brooke's calendar today",
    });

    expect(queryResult.reply).toContain("Here is your calendar");
    expect(queryResult.reply).toContain("Morning sync check");

    const persisted = await calendarEvent.findFirst({
      where: { ownerId: "u_brooke", title: "Morning sync check" },
    });
    expect(persisted).toBeTruthy();
  });
});
