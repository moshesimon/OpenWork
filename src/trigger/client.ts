import { tasks } from "@trigger.dev/sdk/v3";
import type { ProactiveInput, RunCommandInput, RunCommandResult } from "@/agent/orchestrator";
import { maybeRunBootstrapAnalysis, runAgentCommand, runProactiveAnalysis } from "@/agent/orchestrator";
import { prisma } from "@/lib/prisma";
import type {
  runAgentCommandTask,
  runBootstrapAnalysisTask,
  runProactiveAnalysisTask,
} from "@/trigger/agent-tasks";

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

export async function runAgentCommandJob(input: RunCommandInput): Promise<RunCommandResult> {
  if (!isTriggerConfigured()) {
    return runAgentCommand(prisma, input);
  }

  const result = await tasks.triggerAndWait<typeof runAgentCommandTask>("agent-run-command", input);
  if (result.ok) {
    return result.output;
  }

  throw new Error(`Trigger run failed: ${stringifyError(result.error)}`);
}

export async function runProactiveAnalysisJob(input: ProactiveInput): Promise<void> {
  if (!isTriggerConfigured()) {
    await runProactiveAnalysis(prisma, input);
    return;
  }

  await tasks.trigger<typeof runProactiveAnalysisTask>("agent-run-proactive-analysis", input);
}

export async function runBootstrapAnalysisJob(input: BootstrapInput): Promise<void> {
  if (!isTriggerConfigured()) {
    await maybeRunBootstrapAnalysis(prisma, input.userId, input.staleMs);
    return;
  }

  await tasks.trigger<typeof runBootstrapAnalysisTask>("agent-run-bootstrap-analysis", input);
}
