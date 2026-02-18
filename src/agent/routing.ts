import { Prisma, PrismaClient } from "@prisma/client";
import type { AgentContextPack, IntentClassification } from "@/agent/provider/types";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type RouteDecision = {
  targetConversationId: string | null;
  targetUserId: string | null;
  targetChannelSlug: string | null;
  createDmWithUserId: string | null;
  createChannelName: string | null;
  reasoning: string;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
}

export async function decideRoute(
  db: DbClient,
  userId: string,
  intent: IntentClassification,
  context: AgentContextPack,
): Promise<RouteDecision> {
  const targetUserId = intent.targetUserIds[0] ?? null;
  const targetChannelSlug = intent.targetChannelSlugs[0] ?? null;

  if (targetUserId) {
    const existingDm = await db.conversation.findFirst({
      where: {
        type: "DM",
        OR: [
          { dmUserAId: userId, dmUserBId: targetUserId },
          { dmUserAId: targetUserId, dmUserBId: userId },
        ],
      },
      select: { id: true },
    });

    if (existingDm) {
      return {
        targetConversationId: existingDm.id,
        targetUserId,
        targetChannelSlug: null,
        createDmWithUserId: null,
        createChannelName: null,
        reasoning: "Matched existing DM conversation.",
      };
    }

    return {
      targetConversationId: null,
      targetUserId,
      targetChannelSlug: null,
      createDmWithUserId: targetUserId,
      createChannelName: null,
      reasoning: "No DM existed, planning DM creation.",
    };
  }

  if (targetChannelSlug) {
    const existingChannel = context.channels.find(
      (channel) => channel.slug.toLowerCase() === targetChannelSlug.toLowerCase(),
    );

    if (existingChannel) {
      return {
        targetConversationId: existingChannel.conversationId,
        targetUserId: null,
        targetChannelSlug: existingChannel.slug,
        createDmWithUserId: null,
        createChannelName: null,
        reasoning: "Matched existing channel from intent.",
      };
    }
  }

  const topic = intent.topic?.trim();
  if (topic) {
    const candidateSlug = slugify(topic);
    const existingByTopic = context.channels.find(
      (channel) =>
        channel.slug.toLowerCase().includes(candidateSlug) ||
        candidateSlug.includes(channel.slug.toLowerCase()),
    );

    if (existingByTopic) {
      return {
        targetConversationId: existingByTopic.conversationId,
        targetUserId: null,
        targetChannelSlug: existingByTopic.slug,
        createDmWithUserId: null,
        createChannelName: null,
        reasoning: "Mapped topic to an existing channel.",
      };
    }

    return {
      targetConversationId: null,
      targetUserId: null,
      targetChannelSlug: null,
      createDmWithUserId: null,
      createChannelName: topic,
      reasoning: "No suitable channel found, planning channel creation.",
    };
  }

  const fallbackChannel = context.channels.find((channel) => channel.slug === "general");

  return {
    targetConversationId: fallbackChannel?.conversationId ?? null,
    targetUserId: null,
    targetChannelSlug: fallbackChannel?.slug ?? null,
    createDmWithUserId: null,
    createChannelName: fallbackChannel ? null : "general",
    reasoning: "Fell back to #general routing.",
  };
}
