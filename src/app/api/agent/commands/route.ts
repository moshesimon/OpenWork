import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { runAgentCommandJob } from "@/trigger/client";
import type {
  AgentCommandContextHints,
  AgentCommandRequest,
  AgentMention,
} from "@/types/agent";

type TaskMention = Extract<AgentMention, { kind: "task" }>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }

  return output;
}

function sanitizeMentions(value: unknown): AgentMention[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const mentions: AgentMention[] = [];

  for (const rawMention of value) {
    if (!rawMention || typeof rawMention !== "object") {
      continue;
    }

    const mention = rawMention as Record<string, unknown>;
    const kind = asNonEmptyString(mention.kind);
    if (!kind) {
      continue;
    }

    if (kind === "event") {
      const eventId = asNonEmptyString(mention.eventId);
      const title = asNonEmptyString(mention.title);
      const startAt = asNonEmptyString(mention.startAt);
      const endAt = asNonEmptyString(mention.endAt);
      const ownerId = asNonEmptyString(mention.ownerId);
      const attendeeUserIds = Array.isArray(mention.attendeeUserIds)
        ? uniqueNonEmpty(
            mention.attendeeUserIds.map((entry) =>
              typeof entry === "string" ? entry.trim() : null,
            ),
          )
        : [];

      if (!eventId || !title || !startAt || !endAt || !ownerId) {
        continue;
      }

      mentions.push({
        kind: "event",
        eventId,
        title,
        startAt,
        endAt,
        allDay: Boolean(mention.allDay),
        ownerId,
        attendeeUserIds,
      });
      continue;
    }

    if (kind === "task") {
      const taskId = asNonEmptyString(mention.taskId);
      const title = asNonEmptyString(mention.title);
      const description = typeof mention.description === "string" ? mention.description : "";
      const urgency = asNonEmptyString(mention.urgency);
      const status = asNonEmptyString(mention.status);
      const createdById = asNonEmptyString(mention.createdById);
      const updatedAt = asNonEmptyString(mention.updatedAt);
      const assigneeId = asNonEmptyString(mention.assigneeId);

      if (
        !taskId ||
        !title ||
        !urgency ||
        !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(urgency) ||
        !status ||
        !["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"].includes(status) ||
        !createdById ||
        !updatedAt
      ) {
        continue;
      }

      const normalizedUrgency = urgency as TaskMention["urgency"];
      const normalizedStatus = status as TaskMention["status"];

      mentions.push({
        kind: "task",
        taskId,
        title,
        description,
        urgency: normalizedUrgency,
        status: normalizedStatus,
        assigneeId,
        createdById,
        updatedAt,
      });
      continue;
    }

    if (kind === "dm") {
      const userId = asNonEmptyString(mention.userId);
      const displayName = asNonEmptyString(mention.displayName);
      const conversationId = asNonEmptyString(mention.conversationId);
      if (!userId || !displayName) {
        continue;
      }

      mentions.push({
        kind: "dm",
        userId,
        displayName,
        conversationId,
      });
      continue;
    }

    if (kind === "channel") {
      const channelId = asNonEmptyString(mention.channelId);
      const channelSlug = asNonEmptyString(mention.channelSlug);
      const channelName = asNonEmptyString(mention.channelName);
      const conversationId = asNonEmptyString(mention.conversationId);
      if (!channelId || !channelSlug || !channelName || !conversationId) {
        continue;
      }

      mentions.push({
        kind: "channel",
        channelId,
        channelSlug,
        channelName,
        conversationId,
      });
      continue;
    }

    if (kind === "file") {
      const filePath = asNonEmptyString(mention.path);
      const name = asNonEmptyString(mention.name);
      if (!filePath || !name) {
        continue;
      }

      mentions.push({
        kind: "file",
        path: filePath,
        name,
      });
    }
  }

  return mentions;
}

function deriveContextHintsFromMentions(mentions: AgentMention[]): AgentCommandContextHints {
  const userIds: string[] = [];
  const channelIds: string[] = [];
  const conversationIds: string[] = [];
  const taskIds: string[] = [];
  const eventIds: string[] = [];
  const filePaths: string[] = [];

  for (const mention of mentions) {
    if (mention.kind === "event") {
      eventIds.push(mention.eventId);
      userIds.push(mention.ownerId, ...mention.attendeeUserIds);
      continue;
    }

    if (mention.kind === "task") {
      taskIds.push(mention.taskId);
      userIds.push(mention.createdById);
      if (mention.assigneeId) {
        userIds.push(mention.assigneeId);
      }
      continue;
    }

    if (mention.kind === "dm") {
      userIds.push(mention.userId);
      if (mention.conversationId) {
        conversationIds.push(mention.conversationId);
      }
      continue;
    }

    if (mention.kind === "channel") {
      channelIds.push(mention.channelId);
      conversationIds.push(mention.conversationId);
      continue;
    }

    filePaths.push(mention.path);
  }

  return {
    userIds: uniqueNonEmpty(userIds),
    channelIds: uniqueNonEmpty(channelIds),
    conversationIds: uniqueNonEmpty(conversationIds),
    taskIds: uniqueNonEmpty(taskIds),
    eventIds: uniqueNonEmpty(eventIds),
    filePaths: uniqueNonEmpty(filePaths),
  };
}

function mergeContextHints(
  incoming: AgentCommandRequest["contextHints"],
  derived: AgentCommandContextHints,
): AgentCommandContextHints | undefined {
  const userIds = uniqueNonEmpty([...(incoming?.userIds ?? []), ...(derived.userIds ?? [])]);
  const channelIds = uniqueNonEmpty([
    ...(incoming?.channelIds ?? []),
    ...(derived.channelIds ?? []),
  ]);
  const conversationIds = uniqueNonEmpty([
    ...(incoming?.conversationIds ?? []),
    ...(derived.conversationIds ?? []),
  ]);
  const taskIds = uniqueNonEmpty([...(incoming?.taskIds ?? []), ...(derived.taskIds ?? [])]);
  const eventIds = uniqueNonEmpty([...(incoming?.eventIds ?? []), ...(derived.eventIds ?? [])]);
  const filePaths = uniqueNonEmpty([...(incoming?.filePaths ?? []), ...(derived.filePaths ?? [])]);

  if (
    userIds.length === 0 &&
    channelIds.length === 0 &&
    conversationIds.length === 0 &&
    taskIds.length === 0 &&
    eventIds.length === 0 &&
    filePaths.length === 0
  ) {
    return undefined;
  }

  return {
    ...(userIds.length > 0 ? { userIds } : {}),
    ...(channelIds.length > 0 ? { channelIds } : {}),
    ...(conversationIds.length > 0 ? { conversationIds } : {}),
    ...(taskIds.length > 0 ? { taskIds } : {}),
    ...(eventIds.length > 0 ? { eventIds } : {}),
    ...(filePaths.length > 0 ? { filePaths } : {}),
  };
}

export async function POST(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<AgentCommandRequest>(request);
    const input = typeof body.input === "string" ? body.input.trim() : "";
    const mentions = sanitizeMentions(body.mentions);
    const contextHints = mergeContextHints(body.contextHints, deriveContextHintsFromMentions(mentions));

    if (!input) {
      return NextResponse.json(
        {
          errorCode: "INVALID_COMMAND_INPUT",
          message: "input is required.",
        },
        { status: 400 },
      );
    }

    const userMsg = await prisma.agentChatMessage.create({
      data: { userId, role: "user", body: input },
    });

    let reply: string;
    let taskId: string;

    try {
      const result = await runAgentCommandJob({
        userId,
        input,
        mode: body.mode,
        contextHints,
        mentions,
      });
      taskId = result.taskId;
      reply = result.reply;
    } catch (err) {
      taskId = "";
      reply = `Something went wrong: ${err instanceof Error ? err.message : "Unknown error"}`;
    }

    const assistantMsg = await prisma.agentChatMessage.create({
      data: { userId, role: "assistant", body: reply, taskId: taskId || undefined },
    });

    return NextResponse.json({
      taskId,
      status: taskId ? (await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true } }))?.status ?? "COMPLETED" : "FAILED_ERROR",
      reply,
      messages: [
        { id: userMsg.id, role: userMsg.role, body: userMsg.body, taskId: null, createdAt: userMsg.createdAt.toISOString() },
        { id: assistantMsg.id, role: assistantMsg.role, body: assistantMsg.body, taskId: assistantMsg.taskId, createdAt: assistantMsg.createdAt.toISOString() },
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
