import { createHash } from "node:crypto";
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
  AgentContextPack,
  AgentRuntimeTool,
  AgentTurnInput,
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
import { searchWorkspaceGlobal } from "@/server/global-search";

type DbClient = PrismaClient | Prisma.TransactionClient;

const TIME_BUDGET_MS = 2000;
const SYSTEM_EVENT_TASK_SOURCES: AgentTaskSource[] = [
  AgentTaskSource.INBOUND_CHANNEL_MESSAGE,
  AgentTaskSource.INBOUND_DM_MESSAGE,
  AgentTaskSource.BOOTSTRAP_REFRESH,
];
const SYSTEM_EVENT_DEDUPED_STATUSES: AgentTaskStatus[] = [
  AgentTaskStatus.PENDING,
  AgentTaskStatus.RUNNING,
  AgentTaskStatus.COMPLETED,
];

function nowMs(): number {
  return Date.now();
}

type RuntimeState = {
  toolCalls: number;
  confidence: number;
  lastToolMessage: string | null;
};

type RuntimeExecutionState = {
  runtimeState: RuntimeState;
  markToolExecution: (message: string, confidence?: number) => void;
};

type RuntimeBuildContext = RuntimeExecutionState & {
  contextPack: AgentContextPack;
};

type RuntimeResult = RuntimeBuildContext & {
  reply: string;
};

type RuntimeConfig = {
  db: DbClient;
  userId: string;
  contextHints?: ContextHints;
  startedAtMs: number;
  initialConfidence: number;
  taskId: string;
  providerFallbackEventType: string;
  providerFallbackMessage: string;
  buildTurnInput: (context: RuntimeBuildContext) => AgentTurnInput;
};

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

function jsonStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeDedupText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hashIdempotencyValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildSystemEventIdempotencyKey(input: {
  source: AgentTaskSource;
  triggerRef?: string;
  event: RelevanceInput;
}): string {
  const sourceEventId = normalizeNonEmptyString(input.event.sourceMessageId);
  if (sourceEventId) {
    return `message:${sourceEventId}`;
  }

  const incomingTriggerRef = normalizeNonEmptyString(input.triggerRef);
  if (incomingTriggerRef) {
    return `trigger:${incomingTriggerRef}`;
  }

  const sourceConversationId =
    normalizeNonEmptyString(input.event.sourceConversationId) ?? "unknown-conversation";
  const sourceSenderId = normalizeNonEmptyString(input.event.sourceSenderId) ?? "unknown-sender";
  const bodyHash = hashIdempotencyValue(normalizeDedupText(input.event.messageBody));

  return `fallback:${sourceConversationId}:${sourceSenderId}:${bodyHash}`;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isTimeBudgetExceededError(error: unknown): boolean {
  return error instanceof Error && error.message === "time_budget_exceeded";
}

function assertWithinTimeBudget(startedAtMs: number): void {
  if (nowMs() - startedAtMs > TIME_BUDGET_MS) {
    throw new Error("time_budget_exceeded");
  }
}

function createRuntimeState(initialConfidence: number): RuntimeExecutionState {
  const runtimeState: RuntimeState = {
    toolCalls: 0,
    confidence: initialConfidence,
    lastToolMessage: null,
  };

  function markToolExecution(message: string, confidence = runtimeState.confidence): void {
    runtimeState.toolCalls += 1;
    runtimeState.lastToolMessage = message;
    runtimeState.confidence = Math.max(runtimeState.confidence, confidence);
  }

  return {
    runtimeState,
    markToolExecution,
  };
}

async function runRuntimeTurn(config: RuntimeConfig): Promise<RuntimeResult> {
  const contextPack = await buildContextPack(config.db, config.userId, config.contextHints);
  assertWithinTimeBudget(config.startedAtMs);

  const runtime = createRuntimeState(config.initialConfidence);
  const runtimeContext: RuntimeBuildContext = {
    ...runtime,
    contextPack,
  };

  const turnInput = config.buildTurnInput(runtimeContext);
  const provider = resolveAgentProvider();

  let reply: string;
  try {
    const result = await provider.runTurn(turnInput);
    reply = result.text;
  } catch (providerError) {
    if (runtime.runtimeState.toolCalls > 0) {
      throw providerError;
    }

    const fallbackProvider = resolveFallbackProvider();
    const result = await fallbackProvider.runTurn(turnInput);
    reply = result.text;

    await logTaskEvent(
      config.db,
      config.taskId,
      config.providerFallbackEventType,
      config.providerFallbackMessage,
      {
        error: stringifyUnknownError(providerError),
      },
    );
  }

  return {
    ...runtimeContext,
    reply,
  };
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

async function findDuplicateBriefingForEvent(
  db: DbClient,
  userId: string,
  event: RelevanceInput,
): Promise<{ id: string; reason: "source_message" | "summary_match" } | null> {
  const lookbackStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const candidates = await db.briefingItem.findMany({
    where: {
      userId,
      sourceConversationId: event.sourceConversationId,
      createdAt: {
        gte: lookbackStart,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 30,
    select: {
      id: true,
      summary: true,
      sourceMessageIdsJson: true,
    },
  });

  const normalizedBody = normalizeDedupText(event.messageBody);
  for (const candidate of candidates) {
    const sourceMessageIds = jsonStringArray(candidate.sourceMessageIdsJson);
    if (sourceMessageIds.includes(event.sourceMessageId)) {
      return { id: candidate.id, reason: "source_message" };
    }

    if (
      normalizedBody.length >= 24 &&
      normalizeDedupText(candidate.summary) === normalizedBody
    ) {
      return { id: candidate.id, reason: "summary_match" };
    }
  }

  return null;
}

type SystemEventActionDedupKind =
  | "SEND_MESSAGE"
  | "WRITE_AI_CHAT_MESSAGE"
  | "CREATE_BRIEFING"
  | "INFORM_USER";

type SystemEventActionDedupClaim =
  | {
      claimed: true;
      dedupRecordId: string;
    }
  | {
      claimed: false;
      dedupRecordId: string | null;
      existingTaskId: string | null;
      existingOutputId: string | null;
    };

type SystemTurnIdempotencyClaim =
  | {
      claimed: true;
      idempotencyRecordId: string;
    }
  | {
      claimed: false;
      idempotencyRecordId: string | null;
      existingTaskId: string | null;
    };

async function claimSystemTurnIdempotency(
  db: DbClient,
  userId: string,
  source: AgentTaskSource,
  triggerRef: string,
): Promise<SystemTurnIdempotencyClaim> {
  try {
    const created = await db.agentSystemTurnIdempotency.create({
      data: {
        userId,
        source,
        triggerRef,
      },
      select: {
        id: true,
      },
    });

    return {
      claimed: true,
      idempotencyRecordId: created.id,
    };
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const existing = await db.agentSystemTurnIdempotency.findUnique({
      where: {
        user_trigger: {
          userId,
          triggerRef,
        },
      },
      select: {
        id: true,
        taskId: true,
      },
    });

    return {
      claimed: false,
      idempotencyRecordId: existing?.id ?? null,
      existingTaskId: existing?.taskId ?? null,
    };
  }
}

async function claimSystemEventActionDedup(
  db: DbClient,
  userId: string,
  event: RelevanceInput,
  kind: SystemEventActionDedupKind,
  taskId: string,
): Promise<SystemEventActionDedupClaim> {
  const sourceEventId = normalizeNonEmptyString(event.sourceMessageId) ?? `message:${hashIdempotencyValue(normalizeDedupText(event.messageBody))}`;

  try {
    const created = await db.agentProactiveOutputDedup.create({
      data: {
        userId,
        sourceConversationId: event.sourceConversationId,
        sourceEventId,
        actionKind: kind,
        taskId,
      },
      select: {
        id: true,
      },
    });

    return {
      claimed: true,
      dedupRecordId: created.id,
    };
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const existing = await db.agentProactiveOutputDedup.findUnique({
      where: {
        user_source_event_action: {
          userId,
          sourceConversationId: event.sourceConversationId,
          sourceEventId,
          actionKind: kind,
        },
      },
      select: {
        id: true,
        taskId: true,
        outputId: true,
      },
    });

    return {
      claimed: false,
      dedupRecordId: existing?.id ?? null,
      existingTaskId: existing?.taskId ?? null,
      existingOutputId: existing?.outputId ?? null,
    };
  }
}

async function setSystemEventActionDedupOutput(
  db: DbClient,
  dedupRecordId: string,
  outputId: string,
): Promise<void> {
  await db.agentProactiveOutputDedup.update({
    where: { id: dedupRecordId },
    data: {
      outputId,
    },
  });
}

async function upsertProfileLastAnalysisAt(db: DbClient, userId: string): Promise<void> {
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
}

const TURN_ACTION_EVENT_MAP: Record<string, string> = {
  workspace_task_created: "CREATE_WORKSPACE_TASK",
  workspace_task_updated: "UPDATE_WORKSPACE_TASK",
  calendar_event_created: "CREATE_CALENDAR_EVENT",
  calendar_event_updated: "UPDATE_CALENDAR_EVENT",
  calendar_event_deleted: "DELETE_CALENDAR_EVENT",
  message_sent: "SEND_MESSAGE",
  ai_chat_message_written: "WRITE_AI_CHAT_MESSAGE",
  briefing_created: "CREATE_BRIEFING",
  no_op: "LOG_ONLY",
  log_only: "LOG_ONLY",
  inform_action_created: "INFORM_USER",
};

async function collectTaskActionMix(db: DbClient, taskId: string): Promise<Record<string, number>> {
  const events = await db.agentEventLog.findMany({
    where: { taskId },
    select: { eventType: true },
  });

  const actionMix: Record<string, number> = {};
  for (const event of events) {
    const actionKind = TURN_ACTION_EVENT_MAP[event.eventType];
    if (!actionKind) {
      continue;
    }

    actionMix[actionKind] = (actionMix[actionKind] ?? 0) + 1;
  }

  return actionMix;
}

export type AgentTurnUserMessageTrigger = {
  type: "USER_MESSAGE";
  payload: {
    input: string;
    mode?: AutonomyLevel;
    mentions?: AgentMention[];
  };
};

export type AgentTurnSystemEventTrigger = {
  type: "SYSTEM_EVENT";
  payload: {
    source: AgentTaskSource;
    triggerRef: string;
    event: RelevanceInput;
  };
};

export type AgentTurnRequest = {
  userId: string;
  trigger: AgentTurnUserMessageTrigger | AgentTurnSystemEventTrigger;
  contextHints?: ContextHints;
  idempotencyKey?: string;
};

export type AgentTurnResult =
  | {
      triggerType: "USER_MESSAGE";
      taskId: string;
      reply: string;
    }
  | {
      triggerType: "SYSTEM_EVENT";
      handled: true;
    };

type UserMessageTurnInput = {
  userId: string;
  input: string;
  mode?: AutonomyLevel;
  contextHints?: ContextHints;
  mentions?: AgentMention[];
};

type UserMessageTurnResult = {
  taskId: string;
  reply: string;
};

async function runUserMessageTurn(
  db: DbClient,
  input: UserMessageTurnInput,
): Promise<UserMessageTurnResult> {
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

  await logTaskEvent(db, task.id, "turn_started", "Unified agent turn started.", {
    triggerType: "USER_MESSAGE",
    mode: input.mode ?? "AUTO",
  });

  try {
    const runtime = await runRuntimeTurn({
      db,
      userId: input.userId,
      contextHints: input.contextHints,
      startedAtMs,
      initialConfidence: 0.72,
      taskId: task.id,
      providerFallbackEventType: "provider_fallback",
      providerFallbackMessage: "Provider execution failed; fallback provider used.",
      buildTurnInput: ({ contextPack, markToolExecution }) => {
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
        name: "search_workspace",
        description:
          "Run a global search across channels, DMs, messages, files, tasks, calendar events, and users.",
        inputSchema: z.object({
          query: z.string().min(2),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        execute: async (payload: unknown) => {
          const parsed = z
            .object({
              query: z.string().min(2),
              limit: z.number().int().min(1).max(50).default(20),
            })
            .parse(payload);

          const search = await searchWorkspaceGlobal(db, input.userId, {
            query: parsed.query,
            limit: parsed.limit,
          });

          const summary =
            search.results.length === 0
              ? `No results found for "${search.query}".`
              : [
                  `Found ${search.total} result(s) for "${search.query}".`,
                  ...search.results
                    .slice(0, 8)
                    .map((result, index) => `${index + 1}. [${result.kind}] ${result.title}`),
                ].join("\n");

          markToolExecution(summary, search.results.length > 0 ? 0.8 : 0.74);

          return {
            ok: true,
            query: search.query,
            total: search.total,
            providers: search.providers,
            results: search.results,
            message: summary,
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
          "Create a single shared calendar event for a meeting or appointment. ALL participants (organizer and invitees) must be included in attendeeUserIds — do NOT call this tool multiple times for the same meeting. ownerUserId is the organizer; attendeeUserIds lists everyone attending including the organizer.",
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

    const mentions = input.mentions ?? [];
    const mentionContextLines: string[] = [];
    for (const mention of mentions) {
      if (mention.kind === "channel") {
        mentionContextLines.push(`[Context attached: channel #${mention.channelName} (conversationId: ${mention.conversationId}) — recentMessages contains messages from this channel]`);
      } else if (mention.kind === "dm") {
        mentionContextLines.push(`[Context attached: DM with ${mention.displayName} — recentMessages contains messages from this conversation]`);
      } else if (mention.kind === "task") {
        mentionContextLines.push(`[Context attached: task "${mention.title}" (id: ${mention.taskId}, status: ${mention.status})]`);
      } else if (mention.kind === "event") {
        mentionContextLines.push(`[Context attached: calendar event "${mention.title}" (id: ${mention.eventId})]`);
      } else if (mention.kind === "file") {
        mentionContextLines.push(`[Context attached: file ${mention.name}]`);
      }
    }
    const effectiveMessage = mentionContextLines.length > 0
      ? `${mentionContextLines.join("\n")}\n\n${input.input}`
      : input.input;

        const turnInput: AgentTurnInput = {
      message: effectiveMessage,
      history: contextPack.chatHistory.slice(-20).map((m) => ({ role: m.role, body: m.body })),
      relevantContext: JSON.stringify(
        {
          activeUser: contextPack.activeUser,
          users: contextPack.users,
          channels: contextPack.channels,
          recentMessages: contextPack.recentMessages.slice(0, 30),
          calendarEvents: contextPack.calendarEvents.slice(0, 25),
          recentBriefings: contextPack.recentBriefings.slice(0, 20),
          relevanceProfile: contextPack.relevanceProfile,
        },
        null,
        2,
      ),
      systemPrompt: [
        "You are the sole execution agent for this workspace.",
        "You have full workspace database access across all users, tasks, messages, and calendar events.",
        "When the user's message contains [Context attached: ...] annotations, use the recentMessages in context to fulfill requests about those items.",
        "You must perform requested actions only by calling tools.",
        "Use read-only tools to inspect context when needed, then action tools to execute.",
        "Do not claim actions were taken unless a tool call succeeded.",
        "After tool execution, provide a concise user-facing reply.",
        "When scheduling a meeting between multiple people, call create_calendar_event ONCE with all participants in attendeeUserIds. Never create separate events per person.",
      ].join("\n"),
      tools,
      maxSteps: 10,
        };

        return turnInput;
      },
    });

    const normalizedReply = runtime.reply.trim() || runtime.runtimeState.lastToolMessage || "No action taken.";

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: AgentTaskStatus.COMPLETED,
        completedAt: new Date(),
        confidence: runtime.runtimeState.confidence,
      },
    });

    const actionMix = await collectTaskActionMix(db, task.id);
    await logTaskEvent(db, task.id, "turn_completed", "Unified agent turn completed.", {
      triggerType: "USER_MESSAGE",
      reply: normalizedReply,
      toolCalls: runtime.runtimeState.toolCalls,
      actionMix,
    });

    await upsertProfileLastAnalysisAt(db, input.userId);

    return { taskId: task.id, reply: normalizedReply };
  } catch (error) {
    const timeout = isTimeBudgetExceededError(error);

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

    await logTaskEvent(db, task.id, "task_failed", "Unified user-message turn failed.", {
      error: stringifyUnknownError(error),
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

type SystemEventTurnInput = {
  userId: string;
  source: AgentTaskSource;
  triggerRef: string;
  event: RelevanceInput;
  contextHints?: ContextHints;
};

export async function runAgentTurn(db: DbClient, input: AgentTurnRequest): Promise<AgentTurnResult> {
  if (input.trigger.type === "USER_MESSAGE") {
    const result = await runUserMessageTurn(db, {
      userId: input.userId,
      input: input.trigger.payload.input,
      mode: input.trigger.payload.mode,
      contextHints: input.contextHints,
      mentions: input.trigger.payload.mentions,
    });

    return {
      triggerType: "USER_MESSAGE",
      taskId: result.taskId,
      reply: result.reply,
    };
  }

  const triggerRef =
    normalizeNonEmptyString(input.idempotencyKey) ??
    buildSystemEventIdempotencyKey({
      source: input.trigger.payload.source,
      triggerRef: input.trigger.payload.triggerRef,
      event: input.trigger.payload.event,
    });

  await runSystemEventTurn(db, {
    userId: input.userId,
    source: input.trigger.payload.source,
    triggerRef,
    event: input.trigger.payload.event,
    contextHints: input.contextHints,
  });

  return {
    triggerType: "SYSTEM_EVENT",
    handled: true,
  };
}

async function runSystemEventTurn(db: DbClient, input: SystemEventTurnInput): Promise<void> {
  const startedAtMs = nowMs();
  const triggerRef =
    normalizeNonEmptyString(input.triggerRef) ??
    buildSystemEventIdempotencyKey({
      source: input.source,
      triggerRef: input.triggerRef,
      event: input.event,
    });

  const existingTask = await db.agentTask.findFirst({
    where: {
      userId: input.userId,
      triggerRef,
      source: {
        in: SYSTEM_EVENT_TASK_SOURCES,
      },
      status: {
        in: SYSTEM_EVENT_DEDUPED_STATUSES,
      },
    },
    select: {
      id: true,
    },
  });

  if (existingTask) {
    return;
  }

  const task = await db.$transaction(async (tx) => {
    const idempotencyClaim = await claimSystemTurnIdempotency(
      tx,
      input.userId,
      input.source,
      triggerRef,
    );

    if (!idempotencyClaim.claimed) {
      return null;
    }

    const createdTask = await tx.agentTask.create({
      data: {
        userId: input.userId,
        source: input.source,
        triggerRef,
        inputText: input.event.messageBody,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    await tx.agentSystemTurnIdempotency.update({
      where: { id: idempotencyClaim.idempotencyRecordId },
      data: {
        taskId: createdTask.id,
      },
    });

    return createdTask;
  });

  if (!task) {
    return;
  }

  await upsertProfileLastAnalysisAt(db, input.userId);

  await logTaskEvent(db, task.id, "turn_started", "Unified agent turn started.", {
    triggerType: "SYSTEM_EVENT",
    source: input.source,
    triggerRef,
    sourceConversationId: input.event.sourceConversationId,
    sourceMessageId: input.event.sourceMessageId,
    sourceSenderId: input.event.sourceSenderId,
  });

  try {
    const runtime = await runRuntimeTurn({
      db,
      userId: input.userId,
      contextHints: input.contextHints,
      startedAtMs,
      initialConfidence: 0.7,
      taskId: task.id,
      providerFallbackEventType: "provider_fallback",
      providerFallbackMessage: "System-event provider fallback used.",
      buildTurnInput: ({ contextPack, markToolExecution }) => {
        const tools: AgentRuntimeTool[] = [
          {
            name: "read_context",
            description: "Read system-event context (event + profile).",
            inputSchema: z.object({}),
            execute: async () => ({
              event: input.event,
              activeUser: contextPack.activeUser,
              relevanceProfile: contextPack.relevanceProfile,
              recentMessages: contextPack.recentMessages.slice(0, 20),
              recentBriefings: contextPack.recentBriefings.slice(0, 20),
            }),
          },
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
            name: "search_workspace",
            description:
              "Run a global search across channels, DMs, messages, files, tasks, calendar events, and users.",
            inputSchema: z.object({
              query: z.string().min(2),
              limit: z.number().int().min(1).max(50).default(20),
            }),
            execute: async (payload: unknown) => {
              const parsed = z
                .object({
                  query: z.string().min(2),
                  limit: z.number().int().min(1).max(50).default(20),
                })
                .parse(payload);

              const search = await searchWorkspaceGlobal(db, input.userId, {
                query: parsed.query,
                limit: parsed.limit,
              });

              const summary =
                search.results.length === 0
                  ? `No results found for "${search.query}".`
                  : [
                      `Found ${search.total} result(s) for "${search.query}".`,
                      ...search.results
                        .slice(0, 8)
                        .map((result, index) => `${index + 1}. [${result.kind}] ${result.title}`),
                    ].join("\n");

              markToolExecution(summary, search.results.length > 0 ? 0.8 : 0.74);

              return {
                ok: true,
                query: search.query,
                total: search.total,
                providers: search.providers,
                results: search.results,
                message: summary,
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
                  description: (parsed.description ?? input.event.messageBody).trim().slice(0, 2000),
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

              const requestedStatus = parsed.status ?? inferTaskStatus(input.event.messageBody);
              if (!requestedStatus) {
                return {
                  ok: false,
                  message:
                    "I can update task status, but I could not infer the target state. Specify open, in progress, done, or cancelled.",
                };
              }

              const taskIdHint = parsed.taskId ?? extractTaskIdHint(input.event.messageBody);
              const titleHint = parsed.titleHint ?? extractTaskTitleHint(input.event.messageBody);
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

              await logTaskEvent(
                db,
                task.id,
                "workspace_task_updated",
                "Workspace task status updated.",
                {
                  workspaceTaskId: updatedTask.id,
                  previousStatus: targetTask.status,
                  nextStatus: updatedTask.status,
                  title: updatedTask.title,
                },
              );

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
              "Create a single shared calendar event for a meeting or appointment. ALL participants (organizer and invitees) must be included in attendeeUserIds — do NOT call this tool multiple times for the same meeting. ownerUserId is the organizer; attendeeUserIds lists everyone attending including the organizer.",
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
              const title = parsed.title?.trim() || input.event.messageBody.trim().slice(0, 120);

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
                .map(
                  (event, index) =>
                    `${index + 1}. ${event.title} - ${formatCalendarEventLabel(event)}`,
                )
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

              const duplicateSend = await findDuplicateProactiveOutputForEvent(
                db,
                input.userId,
                input.event,
                "SEND_MESSAGE",
              );
              if (duplicateSend) {
                const message = `Skipped duplicate message send for source message ${input.event.sourceMessageId}.`;
                markToolExecution(message, 0.7);
                await logTaskEvent(
                  db,
                  task.id,
                  "message_deduped",
                  "Skipped duplicate proactive message send.",
                  {
                    sourceConversationId: input.event.sourceConversationId,
                    sourceMessageId: input.event.sourceMessageId,
                    existingTaskId: duplicateSend.taskId,
                    existingMessageId: duplicateSend.outputId,
                    duplicateEventLogId: duplicateSend.eventLogId,
                  },
                );
                return {
                  ok: true,
                  deduped: true,
                  message,
                  existingTaskId: duplicateSend.taskId,
                  messageId: duplicateSend.outputId,
                };
              }

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
                  sourceConversationId: input.event.sourceConversationId,
                  sourceMessageId: input.event.sourceMessageId,
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
                const duplicateBriefing = await findDuplicateBriefingForEvent(db, input.userId, input.event);
                if (!duplicateBriefing) {
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
                    sourceConversationId: input.event.sourceConversationId,
                    sourceMessageIds: [input.event.sourceMessageId],
                  });
                }

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

              const sendResult = await db.$transaction(async (tx) => {
                const dedupClaim = await claimSystemEventActionDedup(
                  tx,
                  input.userId,
                  input.event,
                  "SEND_MESSAGE",
                  task.id,
                );

                if (!dedupClaim.claimed) {
                  return {
                    deduped: true as const,
                    existingTaskId: dedupClaim.existingTaskId,
                    messageId: dedupClaim.existingOutputId,
                    dedupRecordId: dedupClaim.dedupRecordId,
                  };
                }

                const execution = await executeSendAction(tx, {
                  taskId: task.id,
                  actionId: action.id,
                  userId: input.userId,
                  body: parsed.body,
                  targetConversationId,
                  targetUserId: route.createDmWithUserId ?? route.targetUserId,
                });

                await setSystemEventActionDedupOutput(
                  tx,
                  dedupClaim.dedupRecordId,
                  execution.messageId,
                );

                await logTaskEvent(
                  tx,
                  task.id,
                  "message_sent",
                  "Agent sent message successfully.",
                  {
                    conversationId: execution.conversationId,
                    messageId: execution.messageId,
                    dedupRecordId: dedupClaim.dedupRecordId,
                    actionKind: "SEND_MESSAGE",
                    sourceConversationId: input.event.sourceConversationId,
                    sourceMessageId: input.event.sourceMessageId,
                    sourceSenderId: input.event.sourceSenderId,
                  },
                  action.id,
                );

                return {
                  deduped: false as const,
                  execution,
                };
              });

              if (sendResult.deduped) {
                await markActionStatus(db, action.id, "SKIPPED");
                const message = `Skipped duplicate message send for source message ${input.event.sourceMessageId}.`;
                markToolExecution(message, 0.7);
                await logTaskEvent(
                  db,
                  task.id,
                  "message_deduped",
                  "Skipped duplicate system-event message send.",
                  {
                    sourceConversationId: input.event.sourceConversationId,
                    sourceMessageId: input.event.sourceMessageId,
                    existingTaskId: sendResult.existingTaskId,
                    existingMessageId: sendResult.messageId,
                    dedupRecordId: sendResult.dedupRecordId,
                  },
                  action.id,
                );
                return {
                  ok: true,
                  deduped: true,
                  message,
                  existingTaskId: sendResult.existingTaskId,
                  messageId: sendResult.messageId,
                };
              }

              const target = route.targetChannelSlug
                ? `#${route.targetChannelSlug}`
                : route.targetUserId ?? "the conversation";
              const message = `Done — I sent a message to ${target}:\n\n"${parsed.body}"`;
              markToolExecution(message, 0.82);

              return {
                ok: true,
                message,
                conversationId: sendResult.execution.conversationId,
                messageId: sendResult.execution.messageId,
              };
            },
          },
          {
            name: "write_ai_chat_message",
            description: "Write an assistant chat note to the user's AI chat history.",
            inputSchema: z.object({
              body: z.string().min(1),
            }),
            execute: async (payload: unknown) => {
              const parsed = z
                .object({
                  body: z.string().min(1),
                })
                .parse(payload);
              const body = parsed.body.trim();
              if (!body) {
                return {
                  ok: false,
                  message: "Chat note body cannot be empty.",
                };
              }

              const chatResult = await db.$transaction(async (tx) => {
                const dedupClaim = await claimSystemEventActionDedup(
                  tx,
                  input.userId,
                  input.event,
                  "WRITE_AI_CHAT_MESSAGE",
                  task.id,
                );

                if (!dedupClaim.claimed) {
                  return {
                    deduped: true as const,
                    chatMessageId: dedupClaim.existingOutputId,
                    existingTaskId: dedupClaim.existingTaskId,
                    dedupRecordId: dedupClaim.dedupRecordId,
                  };
                }

                const chatMessage = await tx.agentChatMessage.create({
                  data: {
                    userId: input.userId,
                    role: "assistant",
                    body,
                    taskId: task.id,
                  },
                });

                await setSystemEventActionDedupOutput(
                  tx,
                  dedupClaim.dedupRecordId,
                  chatMessage.id,
                );

                await logTaskEvent(
                  tx,
                  task.id,
                  "ai_chat_message_written",
                  "Assistant chat message written from system event.",
                  {
                    chatMessageId: chatMessage.id,
                    preview: body.slice(0, 200),
                    dedupRecordId: dedupClaim.dedupRecordId,
                    actionKind: "WRITE_AI_CHAT_MESSAGE",
                    sourceConversationId: input.event.sourceConversationId,
                    sourceMessageId: input.event.sourceMessageId,
                    sourceSenderId: input.event.sourceSenderId,
                  },
                );

                return {
                  deduped: false as const,
                  chatMessageId: chatMessage.id,
                };
              });

              if (chatResult.deduped) {
                const message = `Skipped duplicate chat note for source message ${input.event.sourceMessageId}.`;
                markToolExecution(message, 0.7);
                await logTaskEvent(
                  db,
                  task.id,
                  "ai_chat_deduped",
                  "Skipped duplicate system-event AI chat note.",
                  {
                    sourceConversationId: input.event.sourceConversationId,
                    sourceMessageId: input.event.sourceMessageId,
                    existingTaskId: chatResult.existingTaskId,
                    existingChatMessageId: chatResult.chatMessageId,
                    dedupRecordId: chatResult.dedupRecordId,
                  },
                );
                return {
                  ok: true,
                  deduped: true,
                  message,
                  chatMessageId: chatResult.chatMessageId,
                  existingTaskId: chatResult.existingTaskId,
                };
              }

              const message = "Added an assistant chat note.";
              markToolExecution(message, 0.76);

              return { ok: true, message, chatMessageId: chatResult.chatMessageId };
            },
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

              const duplicate = await findDuplicateBriefingForEvent(db, input.userId, input.event);
              if (duplicate) {
                const message = `Skipped duplicate briefing (already covered by ${duplicate.id}).`;
                markToolExecution(message, 0.7);
                await logTaskEvent(
                  db,
                  task.id,
                  "briefing_deduped",
                  "Skipped duplicate system-event briefing.",
                  {
                    briefingId: duplicate.id,
                    dedupeReason: duplicate.reason,
                  },
                );
                return { ok: true, deduped: true, message, briefingId: duplicate.id };
              }

              const briefingResult = await db.$transaction(async (tx) => {
                const dedupClaim = await claimSystemEventActionDedup(
                  tx,
                  input.userId,
                  input.event,
                  "CREATE_BRIEFING",
                  task.id,
                );

                if (!dedupClaim.claimed) {
                  return {
                    deduped: true as const,
                    briefingId: dedupClaim.existingOutputId,
                    existingTaskId: dedupClaim.existingTaskId,
                    dedupRecordId: dedupClaim.dedupRecordId,
                  };
                }

                const item = await createBriefingItem(tx, {
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

                await setSystemEventActionDedupOutput(tx, dedupClaim.dedupRecordId, item.id);

                await logTaskEvent(tx, task.id, "briefing_created", "System-event briefing created.", {
                  briefingId: item.id,
                  importance: item.importance,
                  sourceConversationId: input.event.sourceConversationId,
                  sourceMessageId: input.event.sourceMessageId,
                  actionKind: "CREATE_BRIEFING",
                  dedupRecordId: dedupClaim.dedupRecordId,
                });

                return {
                  deduped: false as const,
                  item,
                };
              });

              if (briefingResult.deduped) {
                const message = `Skipped duplicate briefing for source message ${input.event.sourceMessageId}.`;
                markToolExecution(message, 0.7);
                await logTaskEvent(
                  db,
                  task.id,
                  "briefing_deduped",
                  "Skipped duplicate system-event briefing by action key.",
                  {
                    briefingId: briefingResult.briefingId,
                    dedupeReason: "action_kind",
                    dedupRecordId: briefingResult.dedupRecordId,
                    existingTaskId: briefingResult.existingTaskId,
                  },
                );
                return {
                  ok: true,
                  deduped: true,
                  message,
                  briefingId: briefingResult.briefingId,
                  existingTaskId: briefingResult.existingTaskId,
                };
              }

              const message = `Created briefing "${briefingResult.item.title}".`;
              markToolExecution(message, parsed.importance === "LOW" ? 0.6 : 0.78);

              return { ok: true, message, briefingId: briefingResult.item.id };
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

              const duplicate = await findDuplicateBriefingForEvent(db, input.userId, input.event);
              if (duplicate) {
                const message = `Skipped inform action because this update is already covered (${duplicate.id}).`;
                markToolExecution(message, 0.72);
                await logTaskEvent(
                  db,
                  task.id,
                  "inform_action_deduped",
                  "Skipped duplicate system-event inform action.",
                  {
                    briefingId: duplicate.id,
                    dedupeReason: duplicate.reason,
                  },
                );
                return { ok: true, deduped: true, message, briefingId: duplicate.id };
              }

              const informResult = await db.$transaction(async (tx) => {
                const dedupClaim = await claimSystemEventActionDedup(
                  tx,
                  input.userId,
                  input.event,
                  "INFORM_USER",
                  task.id,
                );

                if (!dedupClaim.claimed) {
                  return {
                    deduped: true as const,
                    briefingId: dedupClaim.existingOutputId,
                    existingTaskId: dedupClaim.existingTaskId,
                    dedupRecordId: dedupClaim.dedupRecordId,
                  };
                }

                const action = await createAgentAction(tx, task.id, "INFORM_USER", {
                  targetConversationId: null,
                  reasoning:
                    parsed.reasoning ?? "Agent selected system-event high-priority inform action.",
                  confidence: 0.82,
                  payload: {
                    sourceConversationId: input.event.sourceConversationId,
                    sourceMessageId: input.event.sourceMessageId,
                  },
                });

                const briefing = await createBriefingItem(tx, {
                  userId: input.userId,
                  taskId: task.id,
                  title: "High-priority update",
                  summary: input.event.messageBody,
                  importance: "HIGH",
                  recommendedAction: { type: "review_or_reply" },
                  sourceConversationId: input.event.sourceConversationId,
                  sourceMessageIds: [input.event.sourceMessageId],
                });

                await markActionStatus(tx, action.id, "EXECUTED");
                await setSystemEventActionDedupOutput(tx, dedupClaim.dedupRecordId, briefing.id);

                await logTaskEvent(tx, task.id, "inform_action_created", "Inform action created.", {
                  actionId: action.id,
                  briefingId: briefing.id,
                  sourceConversationId: input.event.sourceConversationId,
                  sourceMessageId: input.event.sourceMessageId,
                  actionKind: "INFORM_USER",
                  dedupRecordId: dedupClaim.dedupRecordId,
                });

                return {
                  deduped: false as const,
                  actionId: action.id,
                  briefing,
                };
              });

              if (informResult.deduped) {
                const message = `Skipped inform action for source message ${input.event.sourceMessageId} because it was already handled.`;
                markToolExecution(message, 0.72);
                await logTaskEvent(
                  db,
                  task.id,
                  "inform_action_deduped",
                  "Skipped duplicate system-event inform action by action key.",
                  {
                    briefingId: informResult.briefingId,
                    dedupeReason: "action_kind",
                    dedupRecordId: informResult.dedupRecordId,
                    existingTaskId: informResult.existingTaskId,
                  },
                );
                return {
                  ok: true,
                  deduped: true,
                  message,
                  briefingId: informResult.briefingId,
                  existingTaskId: informResult.existingTaskId,
                };
              }

              const message = `Created high-priority briefing "${informResult.briefing.title}".`;
              markToolExecution(message, 0.82);

              return {
                ok: true,
                message,
                actionId: informResult.actionId,
                briefingId: informResult.briefing.id,
              };
            },
          },
          {
            name: "log_only",
            description: "Do nothing except record that no system-event action is needed.",
            inputSchema: z.object({
              reason: z.string().optional(),
            }),
            execute: async (payload: unknown) => {
              const parsed = z.object({ reason: z.string().optional() }).parse(payload);
              const message = parsed.reason?.trim() || "No system-event action required.";
              markToolExecution(message, 0.65);
              await logTaskEvent(db, task.id, "log_only", "Agent chose log-only.", {
                reason: message,
              });
              return { ok: true, message };
            },
          },
        ];

        const turnInput: AgentTurnInput = {
      message: input.event.messageBody,
      history: contextPack.chatHistory.slice(-10).map((m) => ({ role: m.role, body: m.body })),
      relevantContext: JSON.stringify(
        {
          event: input.event,
          activeUser: contextPack.activeUser,
          relevanceProfile: contextPack.relevanceProfile,
          recentMessages: contextPack.recentMessages.slice(0, 20),
          recentBriefings: contextPack.recentBriefings.slice(0, 20),
        },
        null,
        2,
      ),
      systemPrompt: [
        "You are the sole unified agent for system events.",
        "Decide whether to write an AI chat note, send a direct message, create/update task/calendar items, create a briefing, or log only.",
        "Prioritize dedupe-aware behavior for this source event. If the same sourceMessageId was already handled with a briefing/message/chat note, choose log_only.",
        "Use create_briefing when user attention is needed later, write_ai_chat_message for lightweight FYI notes, and send_message only when an immediate reply is warranted.",
        "All decisions must be executed via tools.",
        "After tool execution, provide a concise status reply.",
      ].join("\n"),
      tools,
      maxSteps: 8,
        };

        return turnInput;
      },
    });

    const normalizedReply =
      runtime.reply.trim() || runtime.runtimeState.lastToolMessage || "No system-event action taken.";
    const actionMix = await collectTaskActionMix(db, task.id);

    await logTaskEvent(db, task.id, "turn_completed", "Unified agent turn completed.", {
      triggerType: "SYSTEM_EVENT",
      reply: normalizedReply,
      toolCalls: runtime.runtimeState.toolCalls,
      actionMix,
    });

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: AgentTaskStatus.COMPLETED,
        completedAt: new Date(),
        confidence: runtime.runtimeState.confidence,
      },
    });
  } catch (error) {
    const timeout = isTimeBudgetExceededError(error);

    await db.agentTask.update({
      where: { id: task.id },
      data: {
        status: timeout ? AgentTaskStatus.FAILED_TIMEOUT : AgentTaskStatus.FAILED_ERROR,
        completedAt: new Date(),
        errorCode: timeout ? "TIME_BUDGET_EXCEEDED" : "SYSTEM_EVENT_TURN_ERROR",
        errorMessage: timeout
          ? "System-event turn exceeded 2s budget."
          : error instanceof Error
            ? error.message
            : "Unknown error",
      },
    });

    await createBriefingItem(db, {
      userId: input.userId,
      taskId: task.id,
      title: "System-event turn could not complete",
      summary: "Agent encountered an issue while processing a system event.",
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

  await runAgentTurn(db, {
    userId,
    trigger: {
      type: "SYSTEM_EVENT",
      payload: {
        source: AgentTaskSource.BOOTSTRAP_REFRESH,
        triggerRef: latestMessage.id,
        event: {
          sourceConversationId: latestMessage.conversationId,
          sourceMessageId: latestMessage.id,
          sourceSenderId: latestMessage.senderId,
          messageBody: latestMessage.body,
          isDm: latestMessage.conversation.type === "DM",
        },
      },
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
