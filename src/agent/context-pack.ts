import { Prisma, PrismaClient } from "@prisma/client";
import type { AgentContextPack, ContextHints } from "@/agent/provider/types";

type DbClient = PrismaClient | Prisma.TransactionClient;

type ContextCalendarEventRow = {
  id: string;
  ownerId: string;
  createdById: string;
  attendees?: {
    userId: string;
  }[];
  title: string;
  description: string;
  location: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
};

type CalendarEventDelegate = {
  findMany(args: unknown): Promise<ContextCalendarEventRow[]>;
};

type TableInfoRow = {
  name: string | null;
};

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }

  return Array.from(unique);
}

function jsonStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function getCalendarEventDelegate(db: DbClient): CalendarEventDelegate {
  const delegate = (db as { calendarEvent?: unknown }).calendarEvent;

  if (!delegate) {
    throw new Error("Calendar model is unavailable on this Prisma client.");
  }

  return delegate as CalendarEventDelegate;
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

  return table.toLowerCase().includes("calendarevent");
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

export async function buildContextPack(
  db: DbClient,
  userId: string,
  hints?: ContextHints,
): Promise<AgentContextPack> {
  const hintedUserIds = normalizeStringList(hints?.userIds);
  const hintedChannelIds = normalizeStringList(hints?.channelIds);
  const hintedConversationIds = normalizeStringList(hints?.conversationIds);
  const hintedEventIds = normalizeStringList(hints?.eventIds);
  let calendarEvents: ContextCalendarEventRow[] = [];
  let includeCalendarAttendees = false;

  if (await hasCalendarTable(db)) {
    try {
      const calendarEvent = getCalendarEventDelegate(db);
      includeCalendarAttendees =
        CALENDAR_ATTENDEE_RELATION_SUPPORTED && (await hasCalendarAttendeeTable(db));
      const userScope =
        hintedUserIds.length > 0
          ? includeCalendarAttendees
            ? {
                OR: [
                  {
                    ownerId: {
                      in: hintedUserIds,
                    },
                  },
                  {
                    attendees: {
                      some: {
                        userId: {
                          in: hintedUserIds,
                        },
                      },
                    },
                  },
                ],
              }
            : {
                ownerId: {
                  in: hintedUserIds,
                },
              }
          : null;
      const explicitEventScope =
        hintedEventIds.length > 0
          ? {
              id: {
                in: hintedEventIds,
              },
            }
          : null;

      calendarEvents = await calendarEvent.findMany({
        where:
          userScope && explicitEventScope
            ? {
                OR: [userScope, explicitEventScope],
              }
            : explicitEventScope ?? userScope ?? {},
        orderBy: [{ startAt: "desc" }, { createdAt: "desc" }],
        take: 80,
        select: {
          id: true,
          ownerId: true,
          createdById: true,
          ...(includeCalendarAttendees
            ? {
                attendees: {
                  select: {
                    userId: true,
                  },
                },
              }
            : {}),
          title: true,
          description: true,
          location: true,
          startAt: true,
          endAt: true,
          allDay: true,
        },
      });
    } catch (error) {
      if (!isMissingCalendarTableError(error)) {
        throw error;
      }
    }
  }

  const [
    activeUser,
    users,
    channels,
    relevanceProfile,
    messages,
    chatMessages,
  ] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, displayName: true },
    }),
    db.user.findMany({
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
    }),
    db.conversation.findMany({
      where: {
        type: "CHANNEL",
        ...(hintedChannelIds.length
          ? {
              channelId: {
                in: hintedChannelIds,
              },
            }
          : {}),
      },
      select: {
        id: true,
        channel: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
      },
    }),
    db.userRelevanceProfile.findUnique({
      where: { userId },
    }),
    db.message.findMany({
      where: {
        ...(hintedUserIds.length > 0 && hintedConversationIds.length > 0
          ? {
              OR: [
                {
                  senderId: {
                    in: hintedUserIds,
                  },
                },
                {
                  conversationId: {
                    in: hintedConversationIds,
                  },
                },
              ],
            }
          : hintedUserIds.length > 0
          ? {
              senderId: {
                in: hintedUserIds,
              },
            }
          : hintedConversationIds.length > 0
            ? {
                conversationId: {
                  in: hintedConversationIds,
                },
              }
            : {}),
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 30,
      select: {
        id: true,
        body: true,
        conversationId: true,
        senderId: true,
        createdAt: true,
      },
    }),
    db.agentChatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { role: true, body: true },
    }),
  ]);

  return {
    activeUser,
    users,
    channels: channels
      .filter((conversation) => conversation.channel)
      .map((conversation) => ({
        id: conversation.channel!.id,
        slug: conversation.channel!.slug,
        name: conversation.channel!.name,
        conversationId: conversation.id,
      })),
    recentMessages: messages.map((message) => ({
      id: message.id,
      body: message.body,
      conversationId: message.conversationId,
      senderId: message.senderId,
      createdAt: message.createdAt.toISOString(),
    })),
    chatHistory: chatMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      body: m.body,
    })),
    calendarEvents: calendarEvents.map((event: {
      id: string;
      ownerId: string;
      createdById: string;
      attendees?: {
        userId: string;
      }[];
      title: string;
      description: string;
      location: string;
      startAt: Date;
      endAt: Date;
      allDay: boolean;
    }) => ({
      id: event.id,
      ownerId: event.ownerId,
      createdById: event.createdById,
      attendeeUserIds:
        event.attendees && event.attendees.length > 0
          ? Array.from(new Set(event.attendees.map((attendee) => attendee.userId)))
          : [event.ownerId],
      title: event.title,
      description: event.description,
      location: event.location,
      startAt: event.startAt.toISOString(),
      endAt: event.endAt.toISOString(),
      allDay: event.allDay,
    })),
    relevanceProfile: {
      priorityPeople: jsonStringArray(relevanceProfile?.priorityPeopleJson),
      priorityChannels: jsonStringArray(relevanceProfile?.priorityChannelsJson),
      priorityTopics: jsonStringArray(relevanceProfile?.priorityTopicsJson),
      urgencyKeywords: jsonStringArray(relevanceProfile?.urgencyKeywordsJson),
      mutedTopics: jsonStringArray(relevanceProfile?.mutedTopicsJson),
    },
  };
}
