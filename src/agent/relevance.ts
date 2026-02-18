import type { AgentContextPack, RelevanceInput, RelevanceScore } from "@/agent/provider/types";

export type FinalRelevance = {
  ruleScore: number;
  llmScore: number;
  finalScore: number;
  confidence: number;
  rationale: string;
  explicitMention: boolean;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function includesAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

export function scoreRuleRelevance(input: RelevanceInput, context: AgentContextPack): number {
  const body = input.messageBody.toLowerCase();
  const nameToken = context.activeUser.displayName.toLowerCase().split(" ")[0];

  let score = 0.1;

  if (input.isDm) {
    score += 0.3;
  }

  if (body.includes(nameToken) || body.includes(context.activeUser.id.toLowerCase())) {
    score += 0.25;
  }

  if (context.relevanceProfile.priorityPeople.includes(input.sourceSenderId)) {
    score += 0.15;
  }

  if (includesAny(body, context.relevanceProfile.priorityTopics)) {
    score += 0.15;
  }

  if (includesAny(body, context.relevanceProfile.urgencyKeywords)) {
    score += 0.2;
  }

  if (includesAny(body, context.relevanceProfile.mutedTopics)) {
    score -= 0.25;
  }

  return clamp01(score);
}

export function blendRelevance(
  input: RelevanceInput,
  context: AgentContextPack,
  llm: RelevanceScore,
): FinalRelevance {
  const ruleScore = scoreRuleRelevance(input, context);
  const llmScore = clamp01(llm.llmScore);
  const finalScore = clamp01(0.6 * ruleScore + 0.4 * llmScore);

  const explicitMention = input.messageBody
    .toLowerCase()
    .includes(context.activeUser.displayName.toLowerCase().split(" ")[0]);

  return {
    ruleScore,
    llmScore,
    finalScore,
    confidence: clamp01(llm.confidence),
    explicitMention,
    rationale: llm.rationale,
  };
}

export function decideProactiveMode(score: FinalRelevance):
  | "AUTO"
  | "SUGGEST"
  | "LOG_ONLY"
  | "NOTIFY_ONLY" {
  if (score.confidence < 0.6) {
    return "NOTIFY_ONLY";
  }

  if (score.finalScore >= 0.8) {
    return "AUTO";
  }

  if (score.finalScore >= 0.55) {
    return "SUGGEST";
  }

  if (score.explicitMention) {
    return "NOTIFY_ONLY";
  }

  return "LOG_ONLY";
}
