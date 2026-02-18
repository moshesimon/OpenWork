import { BriefingStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { updateBriefingStatus } from "@/server/agent-service";
import { runAgentCommandJob } from "@/trigger/client";

type Params = {
  id: string;
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<Params> },
) {
  try {
    const userId = requireUserIdHeader(request);
    const { id } = await context.params;
    const body = await parseJsonBody<{ input?: unknown }>(request);

    const updated = await updateBriefingStatus(prisma, userId, id, BriefingStatus.ACTED);

    let followupTaskId: string | null = null;
    if (typeof body.input === "string" && body.input.trim().length > 0) {
      const result = await runAgentCommandJob({ userId, input: body.input });
      followupTaskId = result.taskId;
    }

    return NextResponse.json({
      ...updated,
      followupTaskId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
