import { AgentActionStatus, Prisma, PrismaClient } from "@prisma/client";
import { createConversationMessage, getDmMessagesPage } from "@/server/chat-service";
import { markActionStatus } from "@/agent/logging";

export type ExecutionInput = {
  taskId: string;
  actionId: string;
  userId: string;
  body: string;
  targetConversationId?: string | null;
  targetUserId?: string | null;
};

type DbClient = PrismaClient | Prisma.TransactionClient;


function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
}

export async function createChannelWithConversation(
  db: DbClient,
  name: string,
  reason?: string,
) {
  const baseSlug = toSlug(name) || "new-channel";
  let slug = baseSlug;
  let counter = 1;

  while (await db.channel.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }

  const channel = await db.channel.create({
    data: {
      id: `ch_${slug}`,
      name,
      slug,
    },
  });

  const conversation = await db.conversation.create({
    data: {
      type: "CHANNEL",
      channelId: channel.id,
    },
    include: {
      channel: true,
    },
  });

  return {
    channel,
    conversation,
    reason: reason ?? null,
  };
}

export async function ensureDmConversation(
  db: DbClient,
  userId: string,
  otherUserId: string,
): Promise<string> {
  const page = await getDmMessagesPage(db, userId, otherUserId, null, "1");
  return page.conversationId;
}

export async function executeSendAction(
  db: DbClient,
  input: ExecutionInput,
): Promise<{
  conversationId: string;
  messageId: string;
  finalBody: string;
}> {
  let conversationId = input.targetConversationId ?? null;

  if (!conversationId && input.targetUserId) {
    conversationId = await ensureDmConversation(db, input.userId, input.targetUserId);
  }

  if (!conversationId) {
    await markActionStatus(db, input.actionId, AgentActionStatus.FAILED);
    throw new Error("No target conversation resolved for send action.");
  }

  const payload = await createConversationMessage(db, input.userId, conversationId, input.body);

  await db.outboundDelivery.create({
    data: {
      taskId: input.taskId,
      actionId: input.actionId,
      conversationId,
      messageId: payload.message.id,
      senderUserId: input.userId,
      aiAttribution: "user_ai_tag",
    },
  });

  await markActionStatus(db, input.actionId, AgentActionStatus.EXECUTED);

  return {
    conversationId,
    messageId: payload.message.id,
    finalBody: input.body,
  };
}

export async function createBriefingItem(
  db: DbClient,
  data: {
    userId: string;
    taskId?: string | null;
    title: string;
    summary: string;
    importance: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    recommendedAction?: Prisma.InputJsonValue;
    sourceConversationId?: string | null;
    sourceMessageIds?: string[];
  },
) {
  return db.briefingItem.create({
    data: {
      userId: data.userId,
      taskId: data.taskId ?? null,
      title: data.title,
      summary: data.summary,
      importance: data.importance,
      recommendedActionJson: data.recommendedAction,
      sourceConversationId: data.sourceConversationId ?? null,
      sourceMessageIdsJson: data.sourceMessageIds ?? [],
    },
  });
}
