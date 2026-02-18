import { AutonomyLevel, Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

type Input = {
  actionType: string;
  channelSlug?: string | null;
  conversationId?: string | null;
  requestedMode?: AutonomyLevel;
};

export async function resolvePolicyAutonomy(
  db: DbClient,
  userId: string,
  input: Input,
): Promise<AutonomyLevel> {
  if (input.requestedMode) {
    return input.requestedMode;
  }

  const rules = await db.agentPolicyRule.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  const actionRule = rules.find(
    (rule) => rule.scopeType === "action" && rule.scopeKey === input.actionType,
  );
  if (actionRule) {
    return actionRule.autonomyLevel;
  }

  if (input.channelSlug) {
    const channelRule = rules.find(
      (rule) => rule.scopeType === "channel" && rule.scopeKey === input.channelSlug,
    );
    if (channelRule) {
      return channelRule.autonomyLevel;
    }
  }

  if (input.conversationId) {
    const conversationRule = rules.find(
      (rule) => rule.scopeType === "conversation" && rule.scopeKey === input.conversationId,
    );
    if (conversationRule) {
      return conversationRule.autonomyLevel;
    }
  }

  const wildcard = rules.find((rule) => rule.scopeType === "all" && rule.scopeKey === "*");
  if (wildcard) {
    return wildcard.autonomyLevel;
  }

  const profile = await db.agentProfile.findUnique({
    where: { userId },
    select: { defaultAutonomyLevel: true },
  });

  return profile?.defaultAutonomyLevel ?? AutonomyLevel.AUTO;
}
