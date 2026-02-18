import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import type { AgentProvider, AgentTurnInput } from "@/agent/provider/types";

type ProviderFlavor = "openai" | "anthropic";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_SYSTEM_PROMPT =
  "You are an agent. Decide what to do, call tools when needed, and then respond to the user.";

function normalizeBaseUrl(value: string | undefined, suffix: string): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed.endsWith(suffix)) {
    return trimmed;
  }

  return trimmed.slice(0, -suffix.length);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function resolveLanguageModel(flavor: ProviderFlavor): LanguageModel {
  if (flavor === "openai") {
    const provider = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: normalizeBaseUrl(process.env.OPENAI_API_URL, "/chat/completions"),
    });

    return provider(process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
  }

  const headers: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_VERSION) {
    headers["anthropic-version"] = process.env.ANTHROPIC_API_VERSION;
  }

  const provider = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: normalizeBaseUrl(process.env.ANTHROPIC_API_URL, "/messages"),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  return provider(process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5");
}

function getMaxOutputTokens(flavor: ProviderFlavor): number | undefined {
  if (flavor === "openai") {
    return parsePositiveInt(process.env.OPENAI_MAX_TOKENS) ?? parsePositiveInt(process.env.AI_MAX_TOKENS);
  }

  return (
    parsePositiveInt(process.env.ANTHROPIC_MAX_TOKENS) ??
    parsePositiveInt(process.env.AI_MAX_TOKENS)
  );
}

function buildToolSet(input: AgentTurnInput): ToolSet | undefined {
  if (!input.tools || input.tools.length === 0) {
    return undefined;
  }

  const tools: ToolSet = {};

  for (const tool of input.tools) {
    tools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args) => tool.execute(args),
    };
  }

  return tools;
}

export function createAiSdkProvider(flavor: ProviderFlavor): AgentProvider {
  return {
    name: flavor,

    async runTurn(input: AgentTurnInput) {
      const model = resolveLanguageModel(flavor);
      const maxOutputTokens = getMaxOutputTokens(flavor);
      const tools = buildToolSet(input);
      const instructions = [input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, "Relevant context:", input.relevantContext]
        .filter((part) => part && part.trim().length > 0)
        .join("\n\n");

      const messages = [
        ...input.history.map((message) => ({
          role: message.role,
          content: message.body,
        })),
        { role: "user" as const, content: input.message },
      ];

      const agent = new ToolLoopAgent({
        model,
        instructions,
        tools,
        stopWhen: stepCountIs(input.maxSteps ?? DEFAULT_MAX_STEPS),
        temperature: 0.2,
        maxOutputTokens,
      });
      const result = await agent.generate({ messages });

      const text = result.text?.trim();
      return { text: text || "Done." };
    },
  };
}
