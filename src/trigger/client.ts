import { tasks } from "@trigger.dev/sdk/v3";
import type { AgentTurnRequest, AgentTurnResult } from "@/agent/orchestrator";
import { maybeRunBootstrapAnalysis, runAgentTurn } from "@/agent/orchestrator";
import { prisma } from "@/lib/prisma";
import type { runAgentTurnTask, runBootstrapAnalysisTask } from "@/trigger/agent-tasks";

type BootstrapInput = {
  userId: string;
  staleMs?: number;
};

function isTriggerConfigured(): boolean {
  return Boolean(process.env.TRIGGER_SECRET_KEY?.trim());
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return JSON.stringify(error);
}

function isSystemEventTurnEnabled(): boolean {
  const raw = process.env.AGENT_SYSTEM_EVENT_TURNS_ENABLED;
  if (raw === undefined) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

export async function runAgentTurnJob(input: AgentTurnRequest): Promise<AgentTurnResult> {
  if (input.trigger.type === "SYSTEM_EVENT" && !isSystemEventTurnEnabled()) {
    return {
      triggerType: "SYSTEM_EVENT",
      handled: true,
    };
  }

  if (!isTriggerConfigured()) {
    return runAgentTurn(prisma, input);
  }

  const result = await tasks.triggerAndWait<typeof runAgentTurnTask>("agent-run-turn", input);
  if (result.ok) {
    return result.output;
  }

  throw new Error(`Trigger run failed: ${stringifyError(result.error)}`);
}

export async function runBootstrapAnalysisJob(input: BootstrapInput): Promise<void> {
  if (!isTriggerConfigured()) {
    await maybeRunBootstrapAnalysis(prisma, input.userId, input.staleMs);
    return;
  }

  await tasks.trigger<typeof runBootstrapAnalysisTask>("agent-run-bootstrap-analysis", input);
}
