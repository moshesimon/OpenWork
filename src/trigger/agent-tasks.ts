import { task } from "@trigger.dev/sdk/v3";
import type { AgentTurnRequest, AgentTurnResult } from "@/agent/orchestrator";
import { maybeRunBootstrapAnalysis, runAgentTurn } from "@/agent/orchestrator";
import { prisma } from "@/lib/prisma";

type BootstrapPayload = {
  userId: string;
  staleMs?: number;
};

export const runAgentTurnTask = task({
  id: "agent-run-turn",
  run: async (payload: AgentTurnRequest): Promise<AgentTurnResult> => {
    return runAgentTurn(prisma, payload);
  },
});

export const runBootstrapAnalysisTask = task({
  id: "agent-run-bootstrap-analysis",
  run: async (payload: BootstrapPayload): Promise<{ queued: true }> => {
    await maybeRunBootstrapAnalysis(prisma, payload.userId, payload.staleMs);
    return { queued: true };
  },
});
