import { anthropicProvider } from "@/agent/provider/anthropic";
import { mockProvider } from "@/agent/provider/mock";
import { openAIProvider } from "@/agent/provider/openai";
import type { AgentProvider } from "@/agent/provider/types";

export function resolveAgentProvider(): AgentProvider {
  const provider = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();

  if (provider === "anthropic" || provider === "claude") {
    return anthropicProvider;
  }

  if (provider === "openai") {
    return openAIProvider;
  }

  return mockProvider;
}

export function resolveFallbackProvider(): AgentProvider {
  return mockProvider;
}
