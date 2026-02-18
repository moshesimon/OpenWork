import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import type { PrismaClient } from "@prisma/client";

const TASK_SCHEMA_HINT =
  "Task schema is out of sync. Run `npm run db:push` (or `npm run setup`) and restart `npm run dev`.";

type WorkspaceTaskColumnRow = {
  name: string | null;
};

type WorkspaceTaskSchemaState = {
  tableExists: boolean;
  hasSortRank: boolean;
};

async function readWorkspaceTaskSchemaState(db: PrismaClient): Promise<WorkspaceTaskSchemaState> {
  const columns = await db.$queryRaw<WorkspaceTaskColumnRow[]>`PRAGMA table_info("WorkspaceTask")`;
  if (columns.length === 0) {
    return { tableExists: false, hasSortRank: false };
  }

  const hasSortRank = columns.some(
    (column) => typeof column.name === "string" && column.name.toLowerCase() === "sortrank",
  );

  return {
    tableExists: true,
    hasSortRank,
  };
}

function taskSchemaOutdatedResponse() {
  return NextResponse.json(
    {
      errorCode: "TASK_SCHEMA_OUTDATED",
      message: TASK_SCHEMA_HINT,
    },
    { status: 503 },
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const userId = requireUserIdHeader(request);
    const schemaState = await readWorkspaceTaskSchemaState(prisma);
    if (!schemaState.tableExists || !schemaState.hasSortRank) {
      return taskSchemaOutdatedResponse();
    }

    const { taskId } = await params;
    const body = await parseJsonBody<{
      title?: string;
      description?: string;
      urgency?: string;
      status?: string;
      sortRank?: number;
      deadline?: string | null;
      assigneeId?: string | null;
    }>(request);

    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title.trim();
    if (body.description !== undefined) data.description = body.description.trim();
    if (body.urgency && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(body.urgency)) {
      data.urgency = body.urgency;
    }
    if (body.status && ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"].includes(body.status)) {
      data.status = body.status;
    }
    if (body.sortRank !== undefined && Number.isFinite(body.sortRank)) {
      data.sortRank = body.sortRank;
    }
    if (body.deadline !== undefined) {
      data.deadline = body.deadline ? new Date(body.deadline) : null;
    }
    if (body.assigneeId !== undefined) {
      data.assigneeId = body.assigneeId || null;
    }

    const existing = await prisma.workspaceTask.findFirst({
      where: { id: taskId, OR: [{ createdById: userId }, { assigneeId: userId }] },
    });
    if (!existing) {
      return NextResponse.json(
        { errorCode: "NOT_FOUND", message: "Task not found or access denied." },
        { status: 404 },
      );
    }

    const targetStatus =
      (typeof data.status === "string" ? data.status : existing.status) as
        | "OPEN"
        | "IN_PROGRESS"
        | "DONE"
        | "CANCELLED";

    if (data.sortRank === undefined && targetStatus !== existing.status) {
      const latestForStatus = await prisma.workspaceTask.findFirst({
        where: {
          id: { not: taskId },
          status: targetStatus,
          OR: [{ createdById: userId }, { assigneeId: userId }],
        },
        orderBy: [{ sortRank: "desc" }, { createdAt: "desc" }],
        select: { sortRank: true },
      });

      data.sortRank = (latestForStatus?.sortRank ?? -1) + 1;
    }

    const task = await prisma.workspaceTask.update({
      where: { id: taskId },
      data,
      include: {
        assignee: { select: { id: true, displayName: true } },
        createdBy: { select: { id: true, displayName: true } },
      },
    });

    return NextResponse.json({
      id: task.id,
      title: task.title,
      description: task.description,
      urgency: task.urgency,
      status: task.status,
      sortRank: task.sortRank,
      deadline: task.deadline?.toISOString() ?? null,
      assigneeId: task.assigneeId,
      assigneeName: task.assignee?.displayName ?? null,
      createdById: task.createdById,
      createdByName: task.createdBy.displayName,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
