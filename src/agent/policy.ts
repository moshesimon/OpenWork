import { AutonomyLevel, Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type PolicyScope = {
  actionType?: string | null;
  channelSlug?: string | null;
  conversationId?: string | null;
};

export async function resolveAutonomyLevel(
  db: DbClient,
  userId: string,
  scope: PolicyScope,
): Promise<AutonomyLevel> {
  const rules = await db.agentPolicyRule.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  const match =
    rules.find(
      (rule) => rule.scopeType === "action" && scope.actionType && rule.scopeKey === scope.actionType,
    ) ??
    rules.find(
      (rule) =>
        rule.scopeType === "channel" && scope.channelSlug && rule.scopeKey === scope.channelSlug,
    ) ??
    rules.find(
      (rule) =>
        rule.scopeType === "conversation" &&
        scope.conversationId &&
        rule.scopeKey === scope.conversationId,
    ) ??
    rules.find((rule) => rule.scopeType === "all" && rule.scopeKey === "*");

  if (match) {
    return match.autonomyLevel;
  }

  const profile = await db.agentProfile.findUnique({
    where: { userId },
    select: { defaultAutonomyLevel: true },
  });

  return profile?.defaultAutonomyLevel ?? AutonomyLevel.AUTO;
}
