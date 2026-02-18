import { task } from "@trigger.dev/sdk/v3";
import type { ProactiveInput, RunCommandInput, RunCommandResult } from "@/agent/orchestrator";
import { maybeRunBootstrapAnalysis, runAgentCommand, runProactiveAnalysis } from "@/agent/orchestrator";
import { prisma } from "@/lib/prisma";

type BootstrapPayload = {
  userId: string;
  staleMs?: number;
};

export const runAgentCommandTask = task({
  id: "agent-run-command",
  run: async (payload: RunCommandInput): Promise<RunCommandResult> => {
    return runAgentCommand(prisma, payload);
  },
});

export const runProactiveAnalysisTask = task({
  id: "agent-run-proactive-analysis",
  run: async (payload: ProactiveInput): Promise<{ queued: true }> => {
    await runProactiveAnalysis(prisma, payload);
    return { queued: true };
  },
});

export const runBootstrapAnalysisTask = task({
  id: "agent-run-bootstrap-analysis",
  run: async (payload: BootstrapPayload): Promise<{ queued: true }> => {
    await maybeRunBootstrapAnalysis(prisma, payload.userId, payload.staleMs);
    return { queued: true };
  },
});
