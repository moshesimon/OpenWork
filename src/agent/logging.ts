import { AgentActionStatus, AgentActionType, Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function logTaskEvent(
  db: DbClient,
  taskId: string,
  eventType: string,
  message: string,
  meta?: Prisma.InputJsonValue,
  actionId?: string,
): Promise<void> {
  await db.agentEventLog.create({
    data: {
      taskId,
      actionId,
      eventType,
      message,
      metaJson: meta,
    },
  });
}

export async function createAgentAction(
  db: DbClient,
  taskId: string,
  type: AgentActionType,
  input: {
    targetConversationId?: string | null;
    targetUserId?: string | null;
    targetChannelSlug?: string | null;
    payload?: Prisma.InputJsonValue;
    reasoning?: string | null;
    confidence?: number | null;
  },
) {
  return db.agentAction.create({
    data: {
      taskId,
      type,
      status: AgentActionStatus.PLANNED,
      targetConversationId: input.targetConversationId ?? null,
      targetUserId: input.targetUserId ?? null,
      targetChannelSlug: input.targetChannelSlug ?? null,
      payloadJson: input.payload,
      reasoning: input.reasoning ?? null,
      confidence: input.confidence ?? null,
    },
  });
}

export async function markActionStatus(
  db: DbClient,
  actionId: string,
  status: AgentActionStatus,
): Promise<void> {
  await db.agentAction.update({
    where: { id: actionId },
    data: {
      status,
      executedAt: status === AgentActionStatus.EXECUTED ? new Date() : undefined,
    },
  });
}
