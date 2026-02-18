import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";
import { getTaskView } from "@/agent/orchestrator";

type Params = {
  taskId: string;
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<Params> },
) {
  try {
    const userId = requireUserIdHeader(request);
    const { taskId } = await context.params;

    const task = await getTaskView(prisma, taskId, userId);

    if (!task) {
      return NextResponse.json(
        {
          errorCode: "TASK_NOT_FOUND",
          message: "Task was not found.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json(task);
  } catch (error) {
    return errorResponse(error);
  }
}
