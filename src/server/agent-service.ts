import {
  AutonomyLevel,
  BriefingStatus,
  Prisma,
  PrismaClient,
  SenderMode,
} from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import type {
  AgentPolicyInput,
  AgentProfileResponse,
  BriefingItemView,
} from "@/types/agent";
import { createChannelWithConversation, ensureDmConversation } from "@/agent/executor";

type DbClient = PrismaClient | Prisma.TransactionClient;

function jsonArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseAutonomyLevel(value: unknown, fallback: AutonomyLevel): AutonomyLevel {
  if (value === "OFF" || value === "REVIEW" || value === "AUTO") {
    return value;
  }

  return fallback;
}

function parseSenderMode(value: unknown, fallback: SenderMode): SenderMode {
  if (value === "USER_AI_TAG" || value === "AGENT_ACCOUNT") {
    return value;
  }

  return fallback;
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

export async function getAgentProfile(db: DbClient, userId: string): Promise<AgentProfileResponse> {
  await ensureUserExists(db, userId);

  const [profile, relevance, policies] = await Promise.all([
    db.agentProfile.upsert({
      where: { userId },
      create: {
        userId,
      },
      update: {},
    }),
    db.userRelevanceProfile.upsert({
      where: { userId },
      create: {
        userId,
        priorityPeopleJson: [userId],
        priorityChannelsJson: ["ch_general"],
        priorityTopicsJson: [],
        urgencyKeywordsJson: ["urgent", "asap", "blocker"],
        mutedTopicsJson: [],
      },
      update: {},
    }),
    db.agentPolicyRule.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return {
    userId,
    defaultAutonomyLevel: profile.defaultAutonomyLevel,
    senderMode: profile.senderMode,
    settings: jsonRecord(profile.settingsJson) ?? {},
    relevance: {
      priorityPeople: jsonArray(relevance.priorityPeopleJson),
      priorityChannels: jsonArray(relevance.priorityChannelsJson),
      priorityTopics: jsonArray(relevance.priorityTopicsJson),
      urgencyKeywords: jsonArray(relevance.urgencyKeywordsJson),
      mutedTopics: jsonArray(relevance.mutedTopicsJson),
    },
    policies: policies.map((policy) => ({
      id: policy.id,
      scopeType: policy.scopeType,
      scopeKey: policy.scopeKey,
      autonomyLevel: policy.autonomyLevel,
    })),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export async function updateAgentProfile(
  db: DbClient,
  userId: string,
  input: {
    defaultAutonomyLevel?: unknown;
    senderMode?: unknown;
    settings?: unknown;
    relevance?: {
      priorityPeople?: unknown;
      priorityChannels?: unknown;
      priorityTopics?: unknown;
      urgencyKeywords?: unknown;
      mutedTopics?: unknown;
    };
  },
): Promise<AgentProfileResponse> {
  await ensureUserExists(db, userId);

  const current = await db.agentProfile.upsert({
    where: { userId },
    create: {
      userId,
    },
    update: {},
  });

  const relevance = await db.userRelevanceProfile.upsert({
    where: { userId },
    create: {
      userId,
      priorityPeopleJson: [userId],
      priorityChannelsJson: ["ch_general"],
      priorityTopicsJson: [],
      urgencyKeywordsJson: ["urgent", "asap", "blocker"],
      mutedTopicsJson: [],
    },
    update: {},
  });

  const settingsInput =
    input.settings && typeof input.settings === "object" && !Array.isArray(input.settings)
      ? (input.settings as Prisma.InputJsonValue)
      : current.settingsJson && typeof current.settingsJson === "object" && !Array.isArray(current.settingsJson)
        ? (current.settingsJson as Prisma.InputJsonValue)
        : undefined;

  const priorityPeople = Array.isArray(input.relevance?.priorityPeople)
    ? input.relevance.priorityPeople.filter((entry): entry is string => typeof entry === "string")
    : jsonArray(relevance.priorityPeopleJson);

  const priorityChannels = Array.isArray(input.relevance?.priorityChannels)
    ? input.relevance.priorityChannels.filter((entry): entry is string => typeof entry === "string")
    : jsonArray(relevance.priorityChannelsJson);

  const priorityTopics = Array.isArray(input.relevance?.priorityTopics)
    ? input.relevance.priorityTopics.filter((entry): entry is string => typeof entry === "string")
    : jsonArray(relevance.priorityTopicsJson);

  const urgencyKeywords = Array.isArray(input.relevance?.urgencyKeywords)
    ? input.relevance.urgencyKeywords.filter((entry): entry is string => typeof entry === "string")
    : jsonArray(relevance.urgencyKeywordsJson);

  const mutedTopics = Array.isArray(input.relevance?.mutedTopics)
    ? input.relevance.mutedTopics.filter((entry): entry is string => typeof entry === "string")
    : jsonArray(relevance.mutedTopicsJson);

  await db.agentProfile.update({
    where: { userId },
    data: {
      defaultAutonomyLevel: parseAutonomyLevel(
        input.defaultAutonomyLevel,
        current.defaultAutonomyLevel,
      ),
      senderMode: parseSenderMode(input.senderMode, current.senderMode),
      settingsJson: settingsInput,
    },
  });

  await db.userRelevanceProfile.update({
    where: { userId },
    data: {
      priorityPeopleJson: priorityPeople,
      priorityChannelsJson: priorityChannels,
      priorityTopicsJson: priorityTopics,
      urgencyKeywordsJson: urgencyKeywords,
      mutedTopicsJson: mutedTopics,
    },
  });

  return getAgentProfile(db, userId);
}

export async function getAgentPolicies(db: DbClient, userId: string) {
  await ensureUserExists(db, userId);

  const policies = await db.agentPolicyRule.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  return {
    items: policies.map((policy) => ({
      id: policy.id,
      scopeType: policy.scopeType,
      scopeKey: policy.scopeKey,
      autonomyLevel: policy.autonomyLevel,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    })),
  };
}

export async function replaceAgentPolicies(
  db: DbClient,
  userId: string,
  input: AgentPolicyInput[],
) {
  await ensureUserExists(db, userId);

  const normalized = input
    .map((item) => ({
      scopeType: typeof item.scopeType === "string" ? item.scopeType.trim() : "",
      scopeKey: typeof item.scopeKey === "string" ? item.scopeKey.trim() : "",
      autonomyLevel: item.autonomyLevel,
    }))
    .filter((item) => item.scopeType.length > 0 && item.scopeKey.length > 0);

  if (normalized.length === 0) {
    throw new ApiError(400, "INVALID_POLICY_INPUT", "At least one valid policy rule is required.");
  }

  if ("$transaction" in db) {
    await db.$transaction(async (tx) => {
      await tx.agentPolicyRule.deleteMany({ where: { userId } });
      await tx.agentPolicyRule.createMany({
        data: normalized.map((item) => ({
          userId,
          scopeType: item.scopeType,
          scopeKey: item.scopeKey,
          autonomyLevel: parseAutonomyLevel(item.autonomyLevel, AutonomyLevel.AUTO),
        })),
      });
    });
  } else {
    await db.agentPolicyRule.deleteMany({ where: { userId } });
    await db.agentPolicyRule.createMany({
      data: normalized.map((item) => ({
        userId,
        scopeType: item.scopeType,
        scopeKey: item.scopeKey,
        autonomyLevel: parseAutonomyLevel(item.autonomyLevel, AutonomyLevel.AUTO),
      })),
    });
  }

  return getAgentPolicies(db, userId);
}

export async function getBriefings(
  db: DbClient,
  userId: string,
  status?: BriefingStatus,
  limit = 20,
): Promise<{ items: BriefingItemView[] }> {
  await ensureUserExists(db, userId);

  const rows = await db.briefingItem.findMany({
    where: {
      userId,
      ...(status ? { status } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
    take: Math.max(1, Math.min(limit, 100)),
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      importance: row.importance,
      title: row.title,
      summary: row.summary,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      sourceConversationId: row.sourceConversationId,
      sourceMessageIds: jsonArray(row.sourceMessageIdsJson),
      recommendedAction: jsonRecord(row.recommendedActionJson),
    })),
  };
}

export async function updateBriefingStatus(
  db: DbClient,
  userId: string,
  briefingId: string,
  status: BriefingStatus,
) {
  await ensureUserExists(db, userId);

  const current = await db.briefingItem.findFirst({
    where: {
      id: briefingId,
      userId,
    },
  });

  if (!current) {
    throw new ApiError(404, "BRIEFING_NOT_FOUND", "Briefing item was not found.");
  }

  const updated = await db.briefingItem.update({
    where: { id: briefingId },
    data: {
      status,
      readAt: status === BriefingStatus.UNREAD ? null : new Date(),
    },
  });

  return {
    id: updated.id,
    status: updated.status,
    readAt: updated.readAt?.toISOString() ?? null,
  };
}

export async function createChannelPrimitive(
  db: DbClient,
  userId: string,
  input: { name: string; slug?: string; reason?: string },
) {
  await ensureUserExists(db, userId);

  const name = input.name?.trim();
  if (!name) {
    throw new ApiError(400, "INVALID_CHANNEL_NAME", "Channel name is required.");
  }

  const created = await createChannelWithConversation(db, name, input.reason);

  if (input.slug && input.slug.trim().length > 0 && input.slug.trim() !== created.channel.slug) {
    const candidate = input.slug.trim().toLowerCase();
    const taken = await db.channel.findUnique({ where: { slug: candidate } });
    if (!taken) {
      await db.channel.update({
        where: { id: created.channel.id },
        data: { slug: candidate },
      });
    }
  }

  const channel = await db.channel.findUniqueOrThrow({
    where: { id: created.channel.id },
  });

  return {
    channel: {
      id: channel.id,
      slug: channel.slug,
      name: channel.name,
      createdAt: channel.createdAt.toISOString(),
    },
    conversation: {
      id: created.conversation.id,
      type: created.conversation.type,
      createdAt: created.conversation.createdAt.toISOString(),
    },
  };
}

export async function createDmPrimitive(
  db: DbClient,
  userId: string,
  input: { otherUserId: string },
) {
  await ensureUserExists(db, userId);

  const otherUserId = input.otherUserId?.trim();
  if (!otherUserId) {
    throw new ApiError(400, "INVALID_DM_TARGET", "otherUserId is required.");
  }

  const otherUser = await db.user.findUnique({ where: { id: otherUserId } });
  if (!otherUser) {
    throw new ApiError(404, "DM_TARGET_NOT_FOUND", "Requested DM user does not exist.");
  }

  if (otherUserId === userId) {
    throw new ApiError(400, "INVALID_DM_TARGET", "Cannot create DM with yourself.");
  }

  const conversationId = await ensureDmConversation(db, userId, otherUserId);

  return {
    conversationId,
    otherUser: {
      id: otherUser.id,
      displayName: otherUser.displayName,
      avatarColor: otherUser.avatarColor,
    },
  };
}
