import { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-error";

type DbClient = PrismaClient | Prisma.TransactionClient;

type CalendarEventWithCreator = {
  id: string;
  ownerId: string;
  createdById: string;
  title: string;
  description: string;
  location: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  createdAt: Date;
  updatedAt: Date;
  owner: {
    id: string;
    displayName: string;
  };
  createdBy: {
    id: string;
    displayName: string;
  };
  attendees?: {
    userId: string;
    user: {
      id: string;
      displayName: string;
    };
  }[];
};

type CalendarEventDelegate = {
  findMany(args: unknown): Promise<CalendarEventWithCreator[]>;
  create(args: unknown): Promise<CalendarEventWithCreator>;
  findFirst(args: unknown): Promise<CalendarEventWithCreator | null>;
  update(args: unknown): Promise<CalendarEventWithCreator>;
  delete(args: unknown): Promise<{
    id: string;
    title: string;
    startAt: Date;
    endAt: Date;
  }>;
};

const CALENDAR_SCHEMA_HINT =
  "Calendar database table is missing. Run `npm run setup` (or `npm run db:push` then `npm run prisma:seed`) and restart the dev server.";

type TableInfoRow = {
  name: string | null;
};

export type CalendarEventView = {
  id: string;
  ownerId: string;
  createdById: string;
  createdByName: string;
  attendeeUserIds: string[];
  attendees: {
    id: string;
    displayName: string;
  }[];
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CalendarEventsResponse = {
  items: CalendarEventView[];
};

export type CreateCalendarEventInput = {
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  ownerId?: string;
  attendeeUserIds?: string[];
};

export type UpdateCalendarEventInput = {
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  attendeeUserIds?: string[];
};

export type CalendarListInput = {
  start?: string;
  end?: string;
  search?: string;
  limit?: number;
  ownerId?: string;
};

export type CalendarLookupHint = {
  eventId?: string | null;
  title?: string | null;
  startAt?: string | null;
  ownerId?: string | null;
};

export type DeletedCalendarEvent = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
};

function toCalendarEventView(event: CalendarEventWithCreator): CalendarEventView {
  const uniqueAttendees = new Map<string, { id: string; displayName: string }>();
  if (event.attendees) {
    for (const attendee of event.attendees) {
      uniqueAttendees.set(attendee.user.id, {
        id: attendee.user.id,
        displayName: attendee.user.displayName,
      });
    }
  }

  if (uniqueAttendees.size === 0) {
    uniqueAttendees.set(event.owner.id, {
      id: event.owner.id,
      displayName: event.owner.displayName,
    });
  }

  return {
    id: event.id,
    ownerId: event.ownerId,
    createdById: event.createdById,
    createdByName: event.createdBy.displayName,
    attendeeUserIds: Array.from(uniqueAttendees.keys()),
    attendees: Array.from(uniqueAttendees.values()),
    title: event.title,
    description: event.description,
    location: event.location,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    allDay: event.allDay,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

function isMissingCalendarTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (code !== "P2021") {
    return false;
  }

  const table = (error as { meta?: { table?: unknown } }).meta?.table;
  if (typeof table !== "string") {
    return true;
  }

  const normalized = table.toLowerCase();
  return normalized.includes("calendarevent");
}

async function hasCalendarTable(db: DbClient): Promise<boolean> {
  const columns = await db.$queryRaw<TableInfoRow[]>`PRAGMA table_info("CalendarEvent")`;
  return columns.length > 0;
}

async function hasCalendarAttendeeTable(db: DbClient): Promise<boolean> {
  const columns = await db.$queryRaw<TableInfoRow[]>`PRAGMA table_info("CalendarEventAttendee")`;
  return columns.length > 0;
}

function hasAttendeeRelationOnClient(): boolean {
  try {
    const model = Prisma.dmmf.datamodel.models.find((entry) => entry.name === "CalendarEvent");
    return Boolean(model?.fields.some((field) => field.name === "attendees"));
  } catch {
    return false;
  }
}

const CALENDAR_ATTENDEE_RELATION_SUPPORTED = hasAttendeeRelationOnClient();

async function canUseCalendarAttendees(db: DbClient): Promise<boolean> {
  if (!CALENDAR_ATTENDEE_RELATION_SUPPORTED) {
    return false;
  }
  return hasCalendarAttendeeTable(db);
}

async function ensureCalendarTableForWrite(db: DbClient): Promise<void> {
  if (!(await hasCalendarTable(db))) {
    throw new ApiError(503, "CALENDAR_SCHEMA_OUTDATED", CALENDAR_SCHEMA_HINT);
  }
}

async function withCalendarReadFallback<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingCalendarTableError(error)) {
      return fallback;
    }

    throw error;
  }
}

async function withCalendarWriteGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingCalendarTableError(error)) {
      throw new ApiError(503, "CALENDAR_SCHEMA_OUTDATED", CALENDAR_SCHEMA_HINT);
    }

    throw error;
  }
}

function parseDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, "INVALID_DATE", `${fieldName} must be a valid ISO date string.`);
  }

  return parsed;
}

function parseOptionalDate(value: string | undefined, fieldName: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseDate(value, fieldName);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(value), 200));
}

function ensureDateRange(startAt: Date, endAt: Date): void {
  if (endAt <= startAt) {
    throw new ApiError(400, "INVALID_EVENT_RANGE", "endAt must be after startAt.");
  }
}

function getCalendarEventDelegate(db: DbClient): CalendarEventDelegate {
  const delegate = (db as { calendarEvent?: unknown }).calendarEvent;

  if (!delegate) {
    throw new ApiError(
      500,
      "CALENDAR_MODEL_UNAVAILABLE",
      "Calendar model is unavailable on this Prisma client.",
    );
  }

  return delegate as CalendarEventDelegate;
}

function buildCalendarEventInclude(includeAttendees: boolean): Record<string, unknown> {
  return {
    owner: {
      select: {
        id: true,
        displayName: true,
      },
    },
    createdBy: {
      select: {
        id: true,
        displayName: true,
      },
    },
    ...(includeAttendees
      ? {
          attendees: {
            include: {
              user: {
                select: {
                  id: true,
                  displayName: true,
                },
              },
            },
          },
        }
      : {}),
  };
}

async function ensureUserExists(db: DbClient, userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User does not exist.");
  }
}

function normalizeOptionalId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildOwnerScope(ownerId: string | null, includeAttendees: boolean): Record<string, unknown> {
  if (!ownerId) {
    return {};
  }

  if (!includeAttendees) {
    return { ownerId };
  }

  return {
    OR: [
      {
        ownerId,
      },
      {
        attendees: {
          some: {
            userId: ownerId,
          },
        },
      },
    ],
  };
}

function parseAttendeeUserIds(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, "INVALID_ATTENDEES", "attendeeUserIds must be an array of user IDs.");
  }

  const ids = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new ApiError(400, "INVALID_ATTENDEES", "attendeeUserIds must contain only strings.");
    }

    const normalized = entry.trim();
    if (!normalized) {
      throw new ApiError(400, "INVALID_ATTENDEES", "attendeeUserIds cannot include empty values.");
    }

    return normalized;
  });

  if (ids.length > 30) {
    throw new ApiError(400, "INVALID_ATTENDEES", "attendeeUserIds cannot exceed 30 users.");
  }

  return Array.from(new Set(ids));
}

async function resolveAttendeeUserIds(
  db: DbClient,
  ownerId: string,
  inputAttendeeUserIds: unknown,
): Promise<string[]> {
  const attendeeSet = new Set<string>([ownerId]);
  for (const id of parseAttendeeUserIds(inputAttendeeUserIds)) {
    attendeeSet.add(id);
  }

  const attendeeUserIds = Array.from(attendeeSet);
  await Promise.all(attendeeUserIds.map((attendeeUserId) => ensureUserExists(db, attendeeUserId)));
  return attendeeUserIds;
}

export async function listCalendarEvents(
  db: DbClient,
  userId: string,
  input: CalendarListInput = {},
): Promise<CalendarEventsResponse> {
  await ensureUserExists(db, userId);
  const ownerId = normalizeOptionalId(input.ownerId);
  if (ownerId) {
    await ensureUserExists(db, ownerId);
  }
  if (!(await hasCalendarTable(db))) {
    return { items: [] };
  }
  const includeAttendees = await canUseCalendarAttendees(db);
  const calendarEvent = getCalendarEventDelegate(db);

  const start = parseOptionalDate(input.start, "start");
  const end = parseOptionalDate(input.end, "end");

  if (start && end && end <= start) {
    throw new ApiError(400, "INVALID_RANGE", "end must be after start.");
  }

  const search = input.search?.trim();
  const limit = clampLimit(input.limit, 120);
  const whereClauses: Record<string, unknown>[] = [];

  const ownerScope = buildOwnerScope(ownerId, includeAttendees);
  if (Object.keys(ownerScope).length > 0) {
    whereClauses.push(ownerScope);
  }

  if (end) {
    whereClauses.push({
      startAt: {
        lt: end,
      },
    });
  }

  if (start) {
    whereClauses.push({
      endAt: {
        gt: start,
      },
    });
  }

  if (search) {
    whereClauses.push({
      OR: [
        { title: { contains: search } },
        { description: { contains: search } },
        { location: { contains: search } },
      ],
    });
  }

  const where =
    whereClauses.length === 0
      ? {}
      : whereClauses.length === 1
        ? whereClauses[0]
        : { AND: whereClauses };

  const rows = await withCalendarReadFallback(
    () =>
      calendarEvent.findMany({
        where,
        include: buildCalendarEventInclude(includeAttendees),
        orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
        take: limit,
      }),
    [],
  );

  return {
    items: rows.map(toCalendarEventView),
  };
}

export async function createCalendarEvent(
  db: DbClient,
  userId: string,
  input: CreateCalendarEventInput,
): Promise<CalendarEventView> {
  await ensureUserExists(db, userId);
  const ownerId = normalizeOptionalId(input.ownerId) ?? userId;
  await ensureUserExists(db, ownerId);
  await ensureCalendarTableForWrite(db);
  const calendarEvent = getCalendarEventDelegate(db);
  const includeAttendees = await canUseCalendarAttendees(db);

  if (input.attendeeUserIds !== undefined && !includeAttendees) {
    throw new ApiError(503, "CALENDAR_SCHEMA_OUTDATED", CALENDAR_SCHEMA_HINT);
  }

  const attendeeUserIds = includeAttendees
    ? await resolveAttendeeUserIds(db, ownerId, input.attendeeUserIds)
    : [];

  const title = typeof input.title === "string" ? input.title.trim() : "";

  if (!title) {
    throw new ApiError(400, "INVALID_EVENT_TITLE", "title is required.");
  }

  const startAt = parseDate(input.startAt, "startAt");
  const endAt = parseDate(input.endAt, "endAt");
  ensureDateRange(startAt, endAt);

  const event = await withCalendarWriteGuard(() =>
    calendarEvent.create({
      data: {
        ownerId,
        createdById: userId,
        title,
        description: typeof input.description === "string" ? input.description.trim() : "",
        location: typeof input.location === "string" ? input.location.trim() : "",
        startAt,
        endAt,
        allDay: Boolean(input.allDay),
        ...(includeAttendees
          ? {
              attendees: {
                create: attendeeUserIds.map((attendeeUserId) => ({
                  userId: attendeeUserId,
                })),
              },
            }
          : {}),
      },
      include: buildCalendarEventInclude(includeAttendees),
    }),
  );

  return toCalendarEventView(event);
}

export async function updateCalendarEvent(
  db: DbClient,
  userId: string,
  eventId: string,
  input: UpdateCalendarEventInput,
  scope: { ownerId?: string | null } = {},
): Promise<CalendarEventView> {
  await ensureUserExists(db, userId);
  const ownerId = normalizeOptionalId(scope.ownerId);
  if (ownerId) {
    await ensureUserExists(db, ownerId);
  }
  await ensureCalendarTableForWrite(db);
  const calendarEvent = getCalendarEventDelegate(db);
  const includeAttendees = await canUseCalendarAttendees(db);
  const ownerScope = buildOwnerScope(ownerId, includeAttendees);

  const existing = await withCalendarWriteGuard(() =>
    calendarEvent.findFirst({
      where:
        Object.keys(ownerScope).length > 0
          ? {
              AND: [{ id: eventId }, ownerScope],
            }
          : {
              id: eventId,
            },
    }),
  );

  if (!existing) {
    throw new ApiError(404, "EVENT_NOT_FOUND", "Calendar event not found.");
  }

  const data: {
    title?: string;
    description?: string;
    location?: string;
    startAt?: Date;
    endAt?: Date;
    allDay?: boolean;
    attendees?: {
      deleteMany: Record<string, never>;
      create: {
        userId: string;
      }[];
    };
  } = {};

  if (input.title !== undefined) {
    if (typeof input.title !== "string") {
      throw new ApiError(400, "INVALID_EVENT_TITLE", "title must be a string.");
    }
    const title = input.title.trim();
    if (!title) {
      throw new ApiError(400, "INVALID_EVENT_TITLE", "title cannot be empty.");
    }
    data.title = title;
  }

  if (input.description !== undefined) {
    if (typeof input.description !== "string") {
      throw new ApiError(400, "INVALID_EVENT_DESCRIPTION", "description must be a string.");
    }
    data.description = input.description.trim();
  }

  if (input.location !== undefined) {
    if (typeof input.location !== "string") {
      throw new ApiError(400, "INVALID_EVENT_LOCATION", "location must be a string.");
    }
    data.location = input.location.trim();
  }

  if (input.allDay !== undefined) {
    if (typeof input.allDay !== "boolean") {
      throw new ApiError(400, "INVALID_EVENT_ALL_DAY", "allDay must be a boolean.");
    }
    data.allDay = Boolean(input.allDay);
  }

  if (input.startAt !== undefined && typeof input.startAt !== "string") {
    throw new ApiError(400, "INVALID_DATE", "startAt must be a valid ISO date string.");
  }

  if (input.endAt !== undefined && typeof input.endAt !== "string") {
    throw new ApiError(400, "INVALID_DATE", "endAt must be a valid ISO date string.");
  }

  if (input.attendeeUserIds !== undefined && !Array.isArray(input.attendeeUserIds)) {
    throw new ApiError(400, "INVALID_ATTENDEES", "attendeeUserIds must be an array of user IDs.");
  }

  if (input.attendeeUserIds !== undefined && !includeAttendees) {
    throw new ApiError(503, "CALENDAR_SCHEMA_OUTDATED", CALENDAR_SCHEMA_HINT);
  }

  const nextStartAt =
    input.startAt !== undefined ? parseDate(input.startAt, "startAt") : existing.startAt;
  const nextEndAt = input.endAt !== undefined ? parseDate(input.endAt, "endAt") : existing.endAt;

  ensureDateRange(nextStartAt, nextEndAt);

  if (input.startAt !== undefined) {
    data.startAt = nextStartAt;
  }

  if (input.endAt !== undefined) {
    data.endAt = nextEndAt;
  }

  if (includeAttendees && input.attendeeUserIds !== undefined) {
    const attendeeUserIds = await resolveAttendeeUserIds(
      db,
      existing.ownerId,
      input.attendeeUserIds,
    );
    data.attendees = {
      deleteMany: {},
      create: attendeeUserIds.map((attendeeUserId) => ({
        userId: attendeeUserId,
      })),
    };
  }

  const updated = await withCalendarWriteGuard(() =>
    calendarEvent.update({
      where: { id: eventId },
      data,
      include: buildCalendarEventInclude(includeAttendees),
    }),
  );

  return toCalendarEventView(updated);
}

export async function deleteCalendarEvent(
  db: DbClient,
  userId: string,
  eventId: string,
  scope: { ownerId?: string | null } = {},
): Promise<DeletedCalendarEvent> {
  await ensureUserExists(db, userId);
  const ownerId = normalizeOptionalId(scope.ownerId);
  if (ownerId) {
    await ensureUserExists(db, ownerId);
  }
  await ensureCalendarTableForWrite(db);
  const calendarEvent = getCalendarEventDelegate(db);
  const includeAttendees = await canUseCalendarAttendees(db);
  const ownerScope = buildOwnerScope(ownerId, includeAttendees);

  const existing = await withCalendarWriteGuard(() =>
    calendarEvent.findFirst({
      where:
        Object.keys(ownerScope).length > 0
          ? {
              AND: [{ id: eventId }, ownerScope],
            }
          : {
              id: eventId,
            },
    }),
  );

  if (!existing) {
    throw new ApiError(404, "EVENT_NOT_FOUND", "Calendar event not found.");
  }

  await withCalendarWriteGuard(() =>
    calendarEvent.delete({
      where: { id: eventId },
    }),
  );

  return {
    id: existing.id,
    title: existing.title,
    startAt: existing.startAt.toISOString(),
    endAt: existing.endAt.toISOString(),
  };
}

export async function listCalendarContextEvents(
  db: DbClient,
  userId: string,
  options: { ownerId?: string; start?: string; end?: string; limit?: number } = {},
): Promise<CalendarEventView[]> {
  await ensureUserExists(db, userId);
  const ownerId = normalizeOptionalId(options.ownerId);
  if (ownerId) {
    await ensureUserExists(db, ownerId);
  }
  if (!(await hasCalendarTable(db))) {
    return [];
  }
  const includeAttendees = await canUseCalendarAttendees(db);
  const calendarEvent = getCalendarEventDelegate(db);

  const start = parseOptionalDate(options.start, "start");
  const end = parseOptionalDate(options.end, "end");
  if (start && end && end <= start) {
    throw new ApiError(400, "INVALID_RANGE", "end must be after start.");
  }
  const limit = clampLimit(options.limit, 30);
  const whereClauses: Record<string, unknown>[] = [];

  const ownerScope = buildOwnerScope(ownerId, includeAttendees);
  if (Object.keys(ownerScope).length > 0) {
    whereClauses.push(ownerScope);
  }

  if (end) {
    whereClauses.push({
      startAt: {
        lt: end,
      },
    });
  }

  if (start) {
    whereClauses.push({
      endAt: {
        gt: start,
      },
    });
  }

  const where =
    whereClauses.length === 0
      ? {}
      : whereClauses.length === 1
        ? whereClauses[0]
        : { AND: whereClauses };

  const rows = await withCalendarReadFallback(
    () =>
      calendarEvent.findMany({
        where,
        include: buildCalendarEventInclude(includeAttendees),
        orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
        take: limit,
      }),
    [],
  );

  return rows.map(toCalendarEventView);
}

export async function resolveCalendarEventByHint(
  db: DbClient,
  userId: string,
  hint: CalendarLookupHint,
): Promise<CalendarEventView | null> {
  await ensureUserExists(db, userId);
  const ownerId = normalizeOptionalId(hint.ownerId);
  if (ownerId) {
    await ensureUserExists(db, ownerId);
  }
  if (!(await hasCalendarTable(db))) {
    return null;
  }
  const includeAttendees = await canUseCalendarAttendees(db);
  const calendarEvent = getCalendarEventDelegate(db);
  const ownerScope = buildOwnerScope(ownerId, includeAttendees);
  const eventIdHint = hint.eventId?.trim() ?? "";

  if (eventIdHint) {
    const byId = await withCalendarReadFallback(
      () =>
        calendarEvent.findFirst({
          where:
            Object.keys(ownerScope).length > 0
              ? {
                  AND: [{ id: eventIdHint }, ownerScope],
                }
              : {
                  id: eventIdHint,
                },
          include: buildCalendarEventInclude(includeAttendees),
        }),
      null,
    );

    if (byId) {
      return toCalendarEventView(byId);
    }
  }

  const titleHint = hint.title?.trim();
  if (!titleHint) {
    return null;
  }

  const candidates = await withCalendarReadFallback(
    () =>
      calendarEvent.findMany({
        where:
          Object.keys(ownerScope).length > 0
            ? {
                AND: [
                  ownerScope,
                  {
                    OR: [
                      { title: { contains: titleHint } },
                      { description: { contains: titleHint } },
                      { location: { contains: titleHint } },
                    ],
                  },
                ],
              }
            : {
                OR: [
                  { title: { contains: titleHint } },
                  { description: { contains: titleHint } },
                  { location: { contains: titleHint } },
                ],
              },
        include: buildCalendarEventInclude(includeAttendees),
        orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
        take: 60,
      }),
    [],
  );

  if (candidates.length === 0) {
    return null;
  }

  const targetStart = hint.startAt ? new Date(hint.startAt) : null;
  const useTargetStart = targetStart && !Number.isNaN(targetStart.getTime());

  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  const normalizedHint = titleHint.toLowerCase();

  for (const candidate of candidates) {
    const normalizedTitle = candidate.title.toLowerCase();
    let score = 0;

    if (normalizedTitle === normalizedHint) {
      score += 100;
    } else if (normalizedTitle.includes(normalizedHint)) {
      score += 60;
    } else {
      score += 30;
    }

    if (useTargetStart) {
      const diffMs = Math.abs(candidate.startAt.getTime() - (targetStart as Date).getTime());
      score -= diffMs / (1000 * 60 * 60 * 24);
    }

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return toCalendarEventView(best);
}
