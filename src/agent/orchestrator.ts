import {
  AgentTaskSource,
  AgentTaskStatus,
  AutonomyLevel,
  Prisma,
  PrismaClient,
  TaskItemStatus,
} from "@prisma/client";
import { z } from "zod";
import { buildContextPack } from "@/agent/context-pack";
import { createBriefingItem, createChannelWithConversation, executeSendAction } from "@/agent/executor";
import { createAgentAction, logTaskEvent, markActionStatus } from "@/agent/logging";
import { resolvePolicyAutonomy } from "@/agent/policy-resolver";
import { decideRoute } from "@/agent/routing";
import { resolveAgentProvider, resolveFallbackProvider } from "@/agent/provider";
import type {
  AgentRuntimeTool,
  ContextHints,
  IntentClassification,
  RelevanceInput,
} from "@/agent/provider/types";
import type { AgentMention } from "@/types/agent";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  resolveCalendarEventByHint,
  updateCalendarEvent,
} from "@/server/calendar-service";

type DbClient = PrismaClient | Prisma.TransactionClient;

const TIME_BUDGET_MS = 2000;

function nowMs(): number {
  return Date.now();
}

function isReadonlyDatabaseMovedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (code === "SQLITE_READONLY_DBMOVED") {
    return true;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.toLowerCase().includes("readonly database");
}

function asJsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseCalendarDate(value: string | null | undefined): Date | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function normalizeOptionalUserId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultEventStart(): Date {
  const next = new Date();
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next;
}

function defaultEventEnd(startAt: Date): Date {
  return new Date(startAt.getTime() + 30 * 60 * 1000);
}

function formatCalendarEventLabel(event: {
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  location: string;
}): string {
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);

  const time = event.allDay
    ? "All day"
    : `${new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(start)}-${new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(end)}`;

  return event.location ? `${day} ${time} (${event.location})` : `${day} ${time}`;
}

function extractTaskIdHint(input: string): string | null {
  const match = input.match(/(?:task(?:\s+id)?|id)[:\s]+([a-z0-9][a-z0-9_\-]{7,})/i);
  return match?.[1] ?? null;
}

function cleanTaskTitleHint(value: string): string {
  return value
    .replace(/^the\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function extractTaskTitleHint(input: string): string | null {
  const quoted = input.match(/"([^"]+)"|'([^']+)'/);
  const quotedValue = quoted?.[1] ?? quoted?.[2];
  if (quotedValue) {
    const cleaned = cleanTaskTitleHint(quotedValue);
    return cleaned.length >= 2 ? cleaned : null;
  }

  const lower = input.toLowerCase();
  const statusWords = "(?:open|in progress|in-progress|done|completed|cancelled|canceled)";
  const patterns = [
    new RegExp(`(?:task|todo)\\s+(.+?)\\s+(?:to|as|status\\s+to)\\s+${statusWords}\\b`, "i"),
    /(?:move|mark|set|update|change|reopen|complete|finish)\s+(?:task|todo)\s+(.+?)(?:\s+to\b|$)/i,
    /(?:task|todo)\s*[:\-]\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = match?.[1];
    if (!value) {
      continue;
    }

    const cleaned = cleanTaskTitleHint(value);
    if (cleaned.length >= 2) {
      return cleaned;
    }
  }

  if (lower.startsWith("task ")) {
    const cleaned = cleanTaskTitleHint(input.slice(5));
    return cleaned.length >= 2 ? cleaned : null;
  }

  return null;
}

function inferTaskStatus(input: string): TaskItemStatus | null {
  const lower = input.toLowerCase();

  if (/\b(reopen|backlog|to do|todo|open)\b/.test(lower)) {
    return "OPEN";
  }

  if (/\b(in progress|in-progress|working on|start|started|doing)\b/.test(lower)) {
    return "IN_PROGRESS";
  }

  if (/\b(done|complete|completed|finish|finished|close|closed)\b/.test(lower)) {
    return "DONE";
  }

  if (/\b(cancel|cancelled|canceled|drop|abandon|wont do|won't do)\b/.test(lower)) {
    return "CANCELLED";
  }

  return null;
}

export type RunCommandInput = {
  userId: string;
  input: string;
  mode?: AutonomyLevel;
  contextHints?: ContextHints;
  mentions?: AgentMention[];
};

export type RunCommandResult = {
  taskId: string;
  reply: string;
};

export async function runAgentCommand(db: DbClient, input: RunCommandInput): Promise<RunCommandResult> {
  const startedAtMs = nowMs();

  const task = await db.agentTask.create({
    data: {
      userId: input.userId,
      source: AgentTaskSource.USER_COMMAND,
      inputText: input.input,
      status: AgentTaskStatus.RUNNING,
      startedAt: new Date(),
    },
  });

  await logTaskEvent(db, task.id, "task_started", "Agent command accepted.", {
    mode: input.mode ?? "AUTO",
  });

  try {
    const contextPack = await buildContextPack(db, input.userId, input.contextHints);

    if (nowMs() - startedAtMs > TIME_BUDGET_MS) {
      throw new Error("time_budget_exceeded");
    }

    const provider = resolveAgentProvider();
    const runtimeState = {
      toolCalls: 0,
      confidence: 0.72,
      lastToolMessage: null as string | null,
    };

    function markToolExecution(message: string, confidence = runtimeState.confidence): void {
      runtimeState.toolCalls += 1;
      runtimeState.lastToolMessage = message;
      runtimeState.confidence = Math.max(runtimeState.confidence, confidence);
    }

    const tools: AgentRuntimeTool[] = [
      {
        name: "list_users",
        description: "List users for routing by name or id.",
        inputSchema: z.object({
          query: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              query: z.string().optional(),
              limit: z.number().int().min(1).max(50).default(20),
            })
            .parse(payload);
          const needle = parsed.query?.toLowerCase();
          const users = contextPack.users
            .filter((user) => (needle ? user.displayName.toLowerCase().includes(needle) : true))
            .slice(0, parsed.limit);
          return { users };
        },
      },
      {
        name: "list_channels",
        description: "List channels for routing by slug/name.",
        inputSchema: z.object({
          query: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              query: z.string().optional(),
              limit: z.number().int().min(1).max(50).default(20),
            })
            .parse(payload);
          const needle = parsed.query?.toLowerCase();
          const channels = contextPack.channels
            .filter((channel) => {
              if (!needle) {
                return true;
              }
              return (
                channel.slug.toLowerCase().includes(needle) ||
                channel.name.toLowerCase().includes(needle)
              );
            })
            .slice(0, parsed.limit);
          return { channels };
        },
      },
      {
        name: "list_recent_messages",
        description: "List recent inbound/outbound messages.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(50).default(20),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              limit: z.number().int().min(1).max(50).default(20),
            })
            .parse(payload);
          return { messages: contextPack.recentMessages.slice(0, parsed.limit) };
        },
      },
      {
        name: "list_calendar_events",
        description:
          "List calendar events from the database, optionally scoped by user, time range, and search text.",
        inputSchema: z.object({
          ownerUserId: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          search: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              ownerUserId: z.string().optional(),
              start: z.string().optional(),
              end: z.string().optional(),
              search: z.string().optional(),
              limit: z.number().int().min(1).max(50).default(20),
            })
            .parse(payload);
          const events = await listCalendarEvents(db, input.userId, {
            ownerId: normalizeOptionalUserId(parsed.ownerUserId) ?? undefined,
            start: parsed.start,
            end: parsed.end,
            search: parsed.search,
            limit: parsed.limit,
          });
          return { events: events.items };
        },
      },
      {
        name: "list_tasks",
        description:
          "List workspace tasks from the database, optionally filtered by status, creator, assignee, and search text.",
        inputSchema: z.object({
          status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]).optional(),
          createdById: z.string().optional(),
          assigneeId: z.string().optional(),
          search: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(40),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]).optional(),
              createdById: z.string().optional(),
              assigneeId: z.string().optional(),
              search: z.string().optional(),
              limit: z.number().int().min(1).max(100).default(40),
            })
            .parse(payload);

          const createdById = normalizeOptionalUserId(parsed.createdById);
          const assigneeId = normalizeOptionalUserId(parsed.assigneeId);
          const search = parsed.search?.trim();
          const where: Prisma.WorkspaceTaskWhereInput = {
            ...(parsed.status ? { status: parsed.status } : {}),
            ...(createdById ? { createdById } : {}),
            ...(assigneeId ? { assigneeId } : {}),
            ...(search
              ? {
                  OR: [
                    { title: { contains: search } },
                    { description: { contains: search } },
                  ],
                }
              : {}),
          };

          const tasks = await db.workspaceTask.findMany({
            where,
            include: {
              assignee: {
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
            },
            orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
            take: parsed.limit,
          });

          return {
            tasks: tasks.map((workspaceTask) => ({
              id: workspaceTask.id,
              title: workspaceTask.title,
              description: workspaceTask.description,
              urgency: workspaceTask.urgency,
              status: workspaceTask.status,
              assigneeId: workspaceTask.assigneeId,
              assigneeName: workspaceTask.assignee?.displayName ?? null,
              createdById: workspaceTask.createdById,
              createdByName: workspaceTask.createdBy.displayName,
              createdAt: workspaceTask.createdAt.toISOString(),
              updatedAt: workspaceTask.updatedAt.toISOString(),
            })),
          };
        },
      },
      {
        name: "create_task",
        description:
          "Create a workspace task. Can target any creator/assignee by user id.",
        inputSchema: z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          urgency: z.enum(["LOW", "MEDIUM", "CRITICAL"]).default("MEDIUM"),
          createdById: z.string().optional(),
          assigneeId: z.string().optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              title: z.string().min(1),
              description: z.string().optional(),
              urgency: z.enum(["LOW", "MEDIUM", "CRITICAL"]).default("MEDIUM"),
              createdById: z.string().optional(),
              assigneeId: z.string().optional(),
            })
            .parse(payload);

          const createdById = normalizeOptionalUserId(parsed.createdById) ?? input.userId;
          const assigneeId = normalizeOptionalUserId(parsed.assigneeId);

          await db.user.findUniqueOrThrow({
            where: { id: createdById },
            select: { id: true },
          });
          if (assigneeId) {
            await db.user.findUniqueOrThrow({
              where: { id: assigneeId },
              select: { id: true },
            });
          }

          const latestOpenTask = await db.workspaceTask.findFirst({
            where: {
              status: "OPEN",
            },
            orderBy: [{ sortRank: "desc" }, { createdAt: "desc" }],
            select: { sortRank: true },
          });

          const workspaceTask = await db.workspaceTask.create({
            data: {
              title: parsed.title.trim(),
              description: (parsed.description ?? input.input).trim().slice(0, 2000),
              urgency: parsed.urgency,
              status: "OPEN",
              sortRank: (latestOpenTask?.sortRank ?? -1) + 1,
              createdById,
              assigneeId,
            },
          });

          const message = `Created task "${workspaceTask.title}" (${workspaceTask.urgency} urgency).`;
          markToolExecution(message, 0.82);

          await logTaskEvent(db, task.id, "workspace_task_created", "Workspace task created.", {
            workspaceTaskId: workspaceTask.id,
            title: workspaceTask.title,
            status: workspaceTask.status,
          });

          return {
            ok: true,
            message,
            taskId: workspaceTask.id,
            title: workspaceTask.title,
            status: workspaceTask.status,
          };
        },
      },
      {
        name: "update_task_status",
        description:
          "Update a workspace task status by id or title hint, with optional creator/assignee filters.",
        inputSchema: z.object({
          taskId: z.string().optional(),
          titleHint: z.string().optional(),
          status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]).optional(),
          createdById: z.string().optional(),
          assigneeId: z.string().optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              taskId: z.string().optional(),
              titleHint: z.string().optional(),
              status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]).optional(),
              createdById: z.string().optional(),
              assigneeId: z.string().optional(),
            })
            .parse(payload);

          const requestedStatus = parsed.status ?? inferTaskStatus(input.input);
          if (!requestedStatus) {
            return {
              ok: false,
              message:
                "I can update task status, but I could not infer the target state. Specify open, in progress, done, or cancelled.",
            };
          }

          const taskIdHint = parsed.taskId ?? extractTaskIdHint(input.input);
          const titleHint = parsed.titleHint ?? extractTaskTitleHint(input.input);
          const createdById = normalizeOptionalUserId(parsed.createdById);
          const assigneeId = normalizeOptionalUserId(parsed.assigneeId);

          const targetTask =
            (taskIdHint
              ? await db.workspaceTask.findFirst({
                  where: {
                    id: taskIdHint,
                    ...(createdById ? { createdById } : {}),
                    ...(assigneeId ? { assigneeId } : {}),
                  },
                })
              : null) ??
            (titleHint
              ? await db.workspaceTask.findFirst({
                  where: {
                    AND: [
                      ...(createdById ? [{ createdById }] : []),
                      ...(assigneeId ? [{ assigneeId }] : []),
                      {
                        OR: [
                          { title: { contains: titleHint } },
                          { description: { contains: titleHint } },
                        ],
                      },
                    ],
                  },
                  orderBy: [{ updatedAt: "desc" }],
                })
              : null);

          if (!targetTask) {
            return {
              ok: false,
              message:
                "I could not find the task to update. Include the task title in quotes or provide a task ID.",
            };
          }

          if (targetTask.status === requestedStatus) {
            const message = `Task "${targetTask.title}" is already ${targetTask.status.replace("_", " ").toLowerCase()}.`;
            markToolExecution(message, 0.76);
            return { ok: true, message };
          }

          const latestForStatus = await db.workspaceTask.findFirst({
            where: {
              id: { not: targetTask.id },
              status: requestedStatus,
            },
            orderBy: [{ sortRank: "desc" }, { createdAt: "desc" }],
            select: { sortRank: true },
          });

          const updatedTask = await db.workspaceTask.update({
            where: { id: targetTask.id },
            data: {
              status: requestedStatus,
              sortRank: (latestForStatus?.sortRank ?? -1) + 1,
            },
          });

          const message = `Moved "${updatedTask.title}" to ${updatedTask.status.replace("_", " ").toLowerCase()}.`;
          markToolExecution(message, 0.82);

          await logTaskEvent(db, task.id, "workspace_task_updated", "Workspace task status updated.", {
            workspaceTaskId: updatedTask.id,
            previousStatus: targetTask.status,
            nextStatus: updatedTask.status,
            title: updatedTask.title,
          });

          return {
            ok: true,
            message,
            taskId: updatedTask.id,
            status: updatedTask.status,
          };
        },
      },
      {
        name: "create_calendar_event",
        description:
          "Create a calendar event. Optionally set a specific owner user id and attendee user ids.",
        inputSchema: z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          startAt: z.string().optional(),
          endAt: z.string().optional(),
          allDay: z.boolean().optional(),
          ownerUserId: z.string().optional(),
          attendeeUserIds: z.array(z.string()).optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              title: z.string().optional(),
              description: z.string().optional(),
              location: z.string().optional(),
              startAt: z.string().optional(),
              endAt: z.string().optional(),
              allDay: z.boolean().optional(),
              ownerUserId: z.string().optional(),
              attendeeUserIds: z.array(z.string()).optional(),
            })
            .parse(payload);

          const startAt = parseCalendarDate(parsed.startAt) ?? defaultEventStart();
          const parsedEnd = parseCalendarDate(parsed.endAt);
          const endAt = parsedEnd && parsedEnd > startAt ? parsedEnd : defaultEventEnd(startAt);
          const title = parsed.title?.trim() || input.input.trim().slice(0, 120);

          const event = await createCalendarEvent(db, input.userId, {
            title,
            description: parsed.description?.trim() ?? "",
            location: parsed.location?.trim() ?? "",
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            allDay: parsed.allDay ?? false,
            ownerId: normalizeOptionalUserId(parsed.ownerUserId) ?? undefined,
            attendeeUserIds: parsed.attendeeUserIds,
          });

          const message = `Created calendar event "${event.title}" for ${formatCalendarEventLabel(event)}.`;
          markToolExecution(message, 0.84);

          await logTaskEvent(db, task.id, "calendar_event_created", "Calendar event created.", {
            calendarEventId: event.id,
            title: event.title,
            startAt: event.startAt,
            endAt: event.endAt,
          });

          return { ok: true, message, eventId: event.id };
        },
      },
      {
        name: "update_calendar_event",
        description:
          "Update calendar event fields by event id or title hint, optionally scoped by owner user id.",
        inputSchema: z.object({
          eventId: z.string().optional(),
          titleHint: z.string().optional(),
          ownerUserId: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          startAt: z.string().optional(),
          endAt: z.string().optional(),
          allDay: z.boolean().optional(),
          attendeeUserIds: z.array(z.string()).optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              eventId: z.string().optional(),
              titleHint: z.string().optional(),
              ownerUserId: z.string().optional(),
              title: z.string().optional(),
              description: z.string().optional(),
              location: z.string().optional(),
              startAt: z.string().optional(),
              endAt: z.string().optional(),
              allDay: z.boolean().optional(),
              attendeeUserIds: z.array(z.string()).optional(),
            })
            .parse(payload);

          const targetEvent = await resolveCalendarEventByHint(db, input.userId, {
            eventId: parsed.eventId ?? null,
            title: parsed.titleHint ?? null,
            startAt: parsed.startAt ?? null,
            ownerId: normalizeOptionalUserId(parsed.ownerUserId),
          });

          if (!targetEvent) {
            return {
              ok: false,
              message:
                "I could not find the calendar event to update. Please include the event title or ID.",
            };
          }

          const patch: {
            title?: string;
            description?: string;
            location?: string;
            startAt?: string;
            endAt?: string;
            allDay?: boolean;
            attendeeUserIds?: string[];
          } = {};

          if (parsed.title !== undefined) {
            patch.title = parsed.title;
          }
          if (parsed.description !== undefined) {
            patch.description = parsed.description;
          }
          if (parsed.location !== undefined) {
            patch.location = parsed.location;
          }
          if (parsed.startAt !== undefined) {
            const startAt = parseCalendarDate(parsed.startAt);
            if (startAt) {
              patch.startAt = startAt.toISOString();
            }
          }
          if (parsed.endAt !== undefined) {
            const endAt = parseCalendarDate(parsed.endAt);
            if (endAt) {
              patch.endAt = endAt.toISOString();
            }
          }
          if (parsed.allDay !== undefined) {
            patch.allDay = parsed.allDay;
          }
          if (parsed.attendeeUserIds !== undefined) {
            patch.attendeeUserIds = parsed.attendeeUserIds;
          }

          if (patch.startAt !== undefined && patch.endAt === undefined) {
            const inferredEnd = defaultEventEnd(new Date(patch.startAt));
            patch.endAt = inferredEnd.toISOString();
          }

          if (
            patch.title === undefined &&
            patch.description === undefined &&
            patch.location === undefined &&
            patch.startAt === undefined &&
            patch.endAt === undefined &&
            patch.allDay === undefined &&
            patch.attendeeUserIds === undefined
          ) {
            return {
              ok: false,
              message: `I found "${targetEvent.title}" but could not infer what to change. Include a new date/time or field.`,
            };
          }

          const updatedEvent = await updateCalendarEvent(db, input.userId, targetEvent.id, patch, {
            ownerId: normalizeOptionalUserId(parsed.ownerUserId),
          });
          const message = `Updated calendar event "${updatedEvent.title}" to ${formatCalendarEventLabel(updatedEvent)}.`;
          markToolExecution(message, 0.84);

          await logTaskEvent(db, task.id, "calendar_event_updated", "Calendar event updated.", {
            calendarEventId: updatedEvent.id,
            title: updatedEvent.title,
          });

          return { ok: true, message, eventId: updatedEvent.id };
        },
      },
      {
        name: "delete_calendar_event",
        description: "Delete a calendar event by id or title hint, optionally scoped by owner user id.",
        inputSchema: z.object({
          eventId: z.string().optional(),
          titleHint: z.string().optional(),
          startAt: z.string().optional(),
          ownerUserId: z.string().optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              eventId: z.string().optional(),
              titleHint: z.string().optional(),
              startAt: z.string().optional(),
              ownerUserId: z.string().optional(),
            })
            .parse(payload);

          const targetEvent = await resolveCalendarEventByHint(db, input.userId, {
            eventId: parsed.eventId ?? null,
            title: parsed.titleHint ?? null,
            startAt: parsed.startAt ?? null,
            ownerId: normalizeOptionalUserId(parsed.ownerUserId),
          });

          if (!targetEvent) {
            return {
              ok: false,
              message:
                "I could not find the calendar event to delete. Please include the event title or ID.",
            };
          }

          await deleteCalendarEvent(db, input.userId, targetEvent.id, {
            ownerId: normalizeOptionalUserId(parsed.ownerUserId),
          });

          const message = `Deleted calendar event "${targetEvent.title}" that was scheduled for ${formatCalendarEventLabel(targetEvent)}.`;
          markToolExecution(message, 0.84);

          await logTaskEvent(db, task.id, "calendar_event_deleted", "Calendar event deleted.", {
            calendarEventId: targetEvent.id,
            title: targetEvent.title,
          });

          return { ok: true, message, eventId: targetEvent.id };
        },
      },
      {
        name: "query_calendar",
        description:
          "Query and summarize calendar events in a date range, optionally scoped by owner user id.",
        inputSchema: z.object({
          ownerUserId: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(40),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              ownerUserId: z.string().optional(),
              start: z.string().optional(),
              end: z.string().optional(),
              limit: z.number().int().min(1).max(100).default(40),
            })
            .parse(payload);

          const defaultStart = new Date();
          defaultStart.setHours(0, 0, 0, 0);
          const rangeStart = parseCalendarDate(parsed.start) ?? defaultStart;
          const parsedRangeEnd = parseCalendarDate(parsed.end);
          const rangeEnd =
            parsedRangeEnd && parsedRangeEnd > rangeStart
              ? parsedRangeEnd
              : new Date(rangeStart.getTime() + 7 * 24 * 60 * 60 * 1000);

          const events = await listCalendarEvents(db, input.userId, {
            ownerId: normalizeOptionalUserId(parsed.ownerUserId) ?? undefined,
            start: rangeStart.toISOString(),
            end: rangeEnd.toISOString(),
            limit: parsed.limit,
          });

          await logTaskEvent(db, task.id, "calendar_events_queried", "Calendar events queried.", {
            eventCount: events.items.length,
          });

          const rangeLabel = `${new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
          }).format(rangeStart)} - ${new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
          }).format(rangeEnd)}`;

          if (events.items.length === 0) {
            const message = `No calendar events found for ${rangeLabel}.`;
            markToolExecution(message, 0.78);
            return { ok: true, message, count: 0, events: [] };
          }

          const summary = events.items
            .slice(0, 8)
            .map((event, index) => `${index + 1}. ${event.title} - ${formatCalendarEventLabel(event)}`)
            .join("\n");
          const moreLine =
            events.items.length > 8 ? `\n...and ${events.items.length - 8} more events.` : "";

          const message = `Here is your calendar for ${rangeLabel}:\n${summary}${moreLine}`;
          markToolExecution(message, 0.8);
          return { ok: true, message, count: events.items.length, events: events.items };
        },
      },
      {
        name: "send_message",
        description:
          "Send a message to a DM or channel. Optionally provide targetUserId/targetChannelSlug/topic.",
        inputSchema: z.object({
          body: z.string().min(1),
          targetUserId: z.string().nullable().optional(),
          targetChannelSlug: z.string().nullable().optional(),
          topic: z.string().nullable().optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              body: z.string().min(1),
              targetUserId: z.string().nullable().optional(),
              targetChannelSlug: z.string().nullable().optional(),
              topic: z.string().nullable().optional(),
            })
            .parse(payload);

          const routingIntent: IntentClassification = {
            intent: "respond",
            summary: parsed.body.slice(0, 200),
            confidence: 0.8,
            targetUserIds: parsed.targetUserId ? [parsed.targetUserId] : [],
            targetChannelSlugs: parsed.targetChannelSlug ? [parsed.targetChannelSlug] : [],
            topic: parsed.topic ?? null,
            urgency: "medium",
            calendar: null,
          };

          const route = await decideRoute(db, input.userId, routingIntent, contextPack);
          const policyAutonomy = await resolvePolicyAutonomy(db, input.userId, {
            actionType: "SEND_MESSAGE",
            channelSlug: route.targetChannelSlug,
            conversationId: route.targetConversationId,
            requestedMode: input.mode,
          });

          const action = await createAgentAction(db, task.id, "SEND_MESSAGE", {
            targetConversationId: route.targetConversationId,
            targetUserId: route.targetUserId,
            targetChannelSlug: route.targetChannelSlug,
            reasoning: route.reasoning,
            confidence: 0.8,
            payload: {
              summary: parsed.body.slice(0, 200),
              intent: "respond",
              urgency: "medium",
            },
          });

          await logTaskEvent(
            db,
            task.id,
            "route_decided",
            "Route decision complete.",
            { route, policyAutonomy },
            action.id,
          );

          if (policyAutonomy === AutonomyLevel.OFF) {
            await markActionStatus(db, action.id, "SKIPPED");
            await createBriefingItem(db, {
              userId: input.userId,
              taskId: task.id,
              title: "Agent action requires manual send",
              summary: parsed.body.slice(0, 200),
              importance: "MEDIUM",
              recommendedAction: {
                type: "manual_send",
                actionId: action.id,
              },
            });

            const message =
              "I've drafted a message but your policies require manual review. Check your briefings.";
            markToolExecution(message, 0.78);
            return { ok: false, message, policy: "OFF" };
          }

          let targetConversationId = route.targetConversationId;

          if (!targetConversationId && route.createChannelName) {
            const created = await createChannelWithConversation(
              db,
              route.createChannelName,
              route.reasoning,
            );
            targetConversationId = created.conversation.id;
            await db.agentAction.update({
              where: { id: action.id },
              data: {
                targetConversationId,
                targetChannelSlug: created.channel.slug,
              },
            });
            await logTaskEvent(
              db,
              task.id,
              "channel_created",
              "Channel and conversation created.",
              {
                channelId: created.channel.id,
                conversationId: targetConversationId,
              },
              action.id,
            );
          }

          const execution = await executeSendAction(db, {
            taskId: task.id,
            actionId: action.id,
            userId: input.userId,
            body: parsed.body,
            targetConversationId,
            targetUserId: route.createDmWithUserId ?? route.targetUserId,
          });

          await logTaskEvent(
            db,
            task.id,
            "message_sent",
            "Agent sent message successfully.",
            {
              conversationId: execution.conversationId,
              messageId: execution.messageId,
            },
            action.id,
          );

          const target = route.targetChannelSlug
            ? `#${route.targetChannelSlug}`
            : route.targetUserId ?? "the conversation";
          const message = `Done — I sent a message to ${target}:\n\n"${parsed.body}"`;
          markToolExecution(message, 0.82);

          return {
            ok: true,
            message,
            conversationId: execution.conversationId,
            messageId: execution.messageId,
          };
        },
      },
      {
        name: "log_only",
        description: "Do nothing and log that no action should be taken.",
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z.object({ reason: z.string().optional() }).parse(payload);
          const message = parsed.reason?.trim() || "No action taken.";
          markToolExecution(message, 0.7);
          await logTaskEvent(db, task.id, "no_op", "Agent chose no-op.", { reason: message });
          return { ok: true, message };
        },
      },
    ];

    const turnInput = {
      message: input.input,
      history: contextPack.chatHistory.slice(-20).map((m) => ({ role: m.role, body: m.body })),
      relevantContext: JSON.stringify(
        {
          activeUser: contextPack.activeUser,
          users: contextPack.users,
          channels: contextPack.channels,
          recentMessages: contextPack.recentMessages.slice(0, 30),
          calendarEvents: contextPack.calendarEvents.slice(0, 25),
          relevanceProfile: contextPack.relevanceProfile,
          selectedMentions: input.mentions ?? [],
        },
        null,
        2,
      ),
      systemPrompt: [
        "You are the sole execution agent for this workspace.",
        "You have full workspace database access across all users, tasks, messages, and calendar events.",
        "selectedMentions in relevantContext are explicit user-selected context attachments.",
        "You must perform requested actions only by calling tools.",
        "Use read-only tools to inspect context when needed, then action tools to execute.",
        "Do not claim actions were taken unless a tool call succeeded.",
        "After tool execution, provide a concise user-facing reply.",
      ].join("\n"),
      tools,
      maxSteps: 10,
    };

    let reply: string;
    try {
      const result = await provider.runTurn(turnInput);
      reply = result.text;
    } catch (providerError) {
      if (runtimeState.toolCalls > 0) {
        throw providerError;
      }

      const fallbackProvider = resolveFallbackProvider();
      const result = await fallbackProvider.runTurn(turnInput);
      reply = result.text;

      await logTaskEvent(
        db,
        task.id,
        "provider_fallback",
        "Provider execution failed; fallback provider used.",
        {
          error: providerError instanceof Error ? providerError.message : String(providerError),
        },
      );
    }

    const normalizedReply = reply.trim() || runtimeState.lastToolMessage || "No action taken.";

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: AgentTaskStatus.COMPLETED,
        completedAt: new Date(),
        confidence: runtimeState.confidence,
      },
    });

    await db.agentProfile.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        lastAnalysisAt: new Date(),
      },
      update: {
        lastAnalysisAt: new Date(),
      },
    });

    return { taskId: task.id, reply: normalizedReply };
  } catch (error) {
    const timeout = error instanceof Error && error.message === "time_budget_exceeded";

    if (timeout) {
      await db.agentTask.update({
        where: { id: task.id },
        data: {
          status: AgentTaskStatus.FAILED_TIMEOUT,
          completedAt: new Date(),
          errorCode: "TIME_BUDGET_EXCEEDED",
          errorMessage: "Agent run exceeded 2s budget.",
        },
      });

      await createBriefingItem(db, {
        userId: input.userId,
        taskId: task.id,
        title: "Agent action timed out",
        summary: "The request took too long; review and resend if needed.",
        importance: "MEDIUM",
        recommendedAction: {
          type: "retry_command",
          input: input.input,
        },
      });

      return { taskId: task.id, reply: "Sorry, that took too long. You can try again." };
    }

    await logTaskEvent(db, task.id, "task_failed", "Agent command failed.", {
      error: error instanceof Error ? error.message : String(error),
    });

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: AgentTaskStatus.FAILED_ERROR,
        completedAt: new Date(),
        errorCode: "AGENT_ERROR",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });

    throw error;
  }
}

export type ProactiveInput = {
  userId: string;
  source: AgentTaskSource;
  triggerRef: string;
  event: RelevanceInput;
  contextHints?: ContextHints;
};

export async function runProactiveAnalysis(db: DbClient, input: ProactiveInput): Promise<void> {
  const startedAtMs = nowMs();

  const task = await db.agentTask.create({
    data: {
      userId: input.userId,
      source: input.source,
      triggerRef: input.triggerRef,
      inputText: input.event.messageBody,
      status: AgentTaskStatus.RUNNING,
      startedAt: new Date(),
    },
  });

  await logTaskEvent(db, task.id, "proactive_started", "Proactive analysis started.", {
    source: input.source,
  });

  try {
    const contextPack = await buildContextPack(db, input.userId, input.contextHints);
    const provider = resolveAgentProvider();

    if (nowMs() - startedAtMs > TIME_BUDGET_MS) {
      throw new Error("time_budget_exceeded");
    }

    const runtimeState = {
      toolCalls: 0,
      confidence: 0.7,
      lastToolMessage: null as string | null,
    };

    function markToolExecution(message: string, confidence = runtimeState.confidence): void {
      runtimeState.toolCalls += 1;
      runtimeState.lastToolMessage = message;
      runtimeState.confidence = Math.max(runtimeState.confidence, confidence);
    }

    const tools: AgentRuntimeTool[] = [
      {
        name: "read_context",
        description: "Read proactive context (event + profile).",
        inputSchema: z.object({}),
        execute: async () => ({
          event: input.event,
          activeUser: contextPack.activeUser,
          relevanceProfile: contextPack.relevanceProfile,
          recentMessages: contextPack.recentMessages.slice(0, 20),
        }),
      },
      {
        name: "create_briefing",
        description: "Create a briefing item for the user.",
        inputSchema: z.object({
          title: z.string().optional(),
          summary: z.string().optional(),
          importance: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
          recommendedAction: z.record(z.string(), z.unknown()).optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              title: z.string().optional(),
              summary: z.string().optional(),
              importance: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
              recommendedAction: z.record(z.string(), z.unknown()).optional(),
            })
            .parse(payload);

          const item = await createBriefingItem(db, {
            userId: input.userId,
            taskId: task.id,
            title: parsed.title?.trim() || "Relevant update",
            summary: parsed.summary?.trim() || input.event.messageBody,
            importance: parsed.importance,
            recommendedAction:
              (parsed.recommendedAction as Prisma.InputJsonValue | undefined) ??
              ({ type: "review" } as Prisma.InputJsonValue),
            sourceConversationId: input.event.sourceConversationId,
            sourceMessageIds: [input.event.sourceMessageId],
          });

          const message = `Created briefing "${item.title}".`;
          markToolExecution(message, parsed.importance === "LOW" ? 0.6 : 0.78);

          await logTaskEvent(db, task.id, "briefing_created", "Proactive briefing created.", {
            briefingId: item.id,
            importance: item.importance,
          });

          return { ok: true, message, briefingId: item.id };
        },
      },
      {
        name: "create_inform_action",
        description: "Create a high-priority inform action and briefing.",
        inputSchema: z.object({
          reasoning: z.string().optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z.object({ reasoning: z.string().optional() }).parse(payload);

          const action = await createAgentAction(db, task.id, "INFORM_USER", {
            targetConversationId: null,
            reasoning:
              parsed.reasoning ?? "Agent selected proactive high-priority inform action.",
            confidence: 0.82,
            payload: {
              sourceConversationId: input.event.sourceConversationId,
              sourceMessageId: input.event.sourceMessageId,
            },
          });

          const briefing = await createBriefingItem(db, {
            userId: input.userId,
            taskId: task.id,
            title: "High-priority update",
            summary: input.event.messageBody,
            importance: "HIGH",
            recommendedAction: { type: "review_or_reply" },
            sourceConversationId: input.event.sourceConversationId,
            sourceMessageIds: [input.event.sourceMessageId],
          });

          await markActionStatus(db, action.id, "EXECUTED");

          const message = `Created high-priority briefing "${briefing.title}".`;
          markToolExecution(message, 0.82);

          await logTaskEvent(db, task.id, "inform_action_created", "Inform action created.", {
            actionId: action.id,
            briefingId: briefing.id,
          });

          return { ok: true, message, actionId: action.id, briefingId: briefing.id };
        },
      },
      {
        name: "log_only",
        description: "Do nothing except record that no proactive action is needed.",
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        execute: async (payload: unknown) => {
          const parsed = z.object({ reason: z.string().optional() }).parse(payload);
          const message = parsed.reason?.trim() || "No proactive action required.";
          markToolExecution(message, 0.65);
          await logTaskEvent(db, task.id, "proactive_log_only", "Agent chose log-only.", {
            reason: message,
          });
          return { ok: true, message };
        },
      },
    ];

    const turnInput = {
      message: input.event.messageBody,
      history: contextPack.chatHistory.slice(-10).map((m) => ({ role: m.role, body: m.body })),
      relevantContext: JSON.stringify(
        {
          event: input.event,
          activeUser: contextPack.activeUser,
          relevanceProfile: contextPack.relevanceProfile,
          recentMessages: contextPack.recentMessages.slice(0, 20),
        },
        null,
        2,
      ),
      systemPrompt: [
        "You are the sole proactive agent.",
        "Decide whether to create a briefing, create high-priority inform action, or log only.",
        "All decisions must be executed via tools.",
        "After tool execution, provide a concise status reply.",
      ].join("\n"),
      tools,
      maxSteps: 8,
    };

    let reply: string;
    try {
      const result = await provider.runTurn(turnInput);
      reply = result.text;
    } catch (providerError) {
      if (runtimeState.toolCalls > 0) {
        throw providerError;
      }

      const fallbackProvider = resolveFallbackProvider();
      const result = await fallbackProvider.runTurn(turnInput);
      reply = result.text;

      await logTaskEvent(db, task.id, "provider_fallback", "Proactive provider fallback used.", {
        error: providerError instanceof Error ? providerError.message : String(providerError),
      });
    }

    await logTaskEvent(db, task.id, "proactive_completed", "Proactive analysis completed.", {
      reply: reply.trim() || runtimeState.lastToolMessage || "No proactive action taken.",
      toolCalls: runtimeState.toolCalls,
    });

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: AgentTaskStatus.COMPLETED,
        completedAt: new Date(),
        confidence: runtimeState.confidence,
      },
    });
  } catch (error) {
    const timeout = error instanceof Error && error.message === "time_budget_exceeded";

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: timeout ? AgentTaskStatus.FAILED_TIMEOUT : AgentTaskStatus.FAILED_ERROR,
        completedAt: new Date(),
        errorCode: timeout ? "TIME_BUDGET_EXCEEDED" : "PROACTIVE_ERROR",
        errorMessage: timeout
          ? "Proactive analysis exceeded 2s budget."
          : error instanceof Error
            ? error.message
            : "Unknown error",
      },
    });

    await createBriefingItem(db, {
      userId: input.userId,
      taskId: task.id,
      title: "Proactive analysis could not complete",
      summary: "Agent encountered an issue while analyzing new information.",
      importance: "LOW",
      recommendedAction: {
        type: "manual_review",
      },
      sourceConversationId: input.event.sourceConversationId,
      sourceMessageIds: [input.event.sourceMessageId],
    });
  }
}

export async function maybeRunBootstrapAnalysis(
  db: DbClient,
  userId: string,
  staleMs = 1000 * 60 * 3,
): Promise<void> {
  const profile = await db.agentProfile.findUnique({
    where: { userId },
    select: { lastAnalysisAt: true },
  });

  const isStale =
    !profile?.lastAnalysisAt || Date.now() - profile.lastAnalysisAt.getTime() > staleMs;

  if (!isStale) {
    return;
  }

  try {
    await db.agentProfile.upsert({
      where: { userId },
      create: {
        userId,
        lastAnalysisAt: new Date(),
      },
      update: {
        lastAnalysisAt: new Date(),
      },
    });
  } catch (error) {
    if (isReadonlyDatabaseMovedError(error)) {
      console.warn(
        "Bootstrap analysis skipped because the SQLite handle is read-only. Restart the dev server after DB rebuilds.",
      );
      return;
    }
    throw error;
  }

  const latestMessage = await db.message.findFirst({
    where: {
      senderId: {
        not: userId,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      body: true,
      conversationId: true,
      senderId: true,
      conversation: {
        select: {
          type: true,
        },
      },
    },
  });

  if (!latestMessage) {
    return;
  }

  await runProactiveAnalysis(db, {
    userId,
    source: AgentTaskSource.BOOTSTRAP_REFRESH,
    triggerRef: latestMessage.id,
    event: {
      sourceConversationId: latestMessage.conversationId,
      sourceMessageId: latestMessage.id,
      sourceSenderId: latestMessage.senderId,
      messageBody: latestMessage.body,
      isDm: latestMessage.conversation.type === "DM",
    },
  });
}

export async function getTaskView(db: DbClient, taskId: string, userId: string) {
  const task = await db.agentTask.findFirst({
    where: {
      id: taskId,
      userId,
    },
    include: {
      actions: {
        orderBy: {
          createdAt: "asc",
        },
      },
      eventLogs: {
        orderBy: {
          createdAt: "asc",
        },
      },
      deliveries: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!task) {
    return null;
  }

  return {
    id: task.id,
    source: task.source,
    status: task.status,
    inputText: task.inputText,
    confidence: task.confidence,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    actions: task.actions.map((action) => ({
      id: action.id,
      type: action.type,
      status: action.status,
      targetConversationId: action.targetConversationId,
      targetUserId: action.targetUserId,
      targetChannelSlug: action.targetChannelSlug,
      reasoning: action.reasoning,
      confidence: action.confidence,
      payload: asJsonRecord(action.payloadJson),
      createdAt: action.createdAt.toISOString(),
      executedAt: action.executedAt?.toISOString() ?? null,
    })),
    events: task.eventLogs.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      message: event.message,
      createdAt: event.createdAt.toISOString(),
      actionId: event.actionId,
      meta: asJsonRecord(event.metaJson),
    })),
    deliveries: task.deliveries.map((delivery) => ({
      id: delivery.id,
      actionId: delivery.actionId,
      conversationId: delivery.conversationId,
      messageId: delivery.messageId,
      senderUserId: delivery.senderUserId,
      aiAttribution: delivery.aiAttribution,
      createdAt: delivery.createdAt.toISOString(),
    })),
  };
}
