import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import type { Prisma, PrismaClient } from "@prisma/client";

const TASK_SCHEMA_HINT =
  "Task schema is out of sync. Run `npm run db:push` (or `npm run setup`) and restart `npm run dev`.";

type WorkspaceTaskSchemaState = {
  tableExists: boolean;
  hasSortRank: boolean;
};

type WorkspaceTaskColumnRow = {
  name: string | null;
};

type TaskWithSortRank = Prisma.WorkspaceTaskGetPayload<{
  include: {
    assignee: { select: { id: true; displayName: true } };
    createdBy: { select: { id: true; displayName: true } };
  };
}>;

type TaskWithoutSortRank = Prisma.WorkspaceTaskGetPayload<{
  select: {
    id: true;
    title: true;
    description: true;
    urgency: true;
    status: true;
    deadline: true;
    assigneeId: true;
    createdById: true;
    createdAt: true;
    updatedAt: true;
    assignee: { select: { id: true; displayName: true } };
    createdBy: { select: { id: true; displayName: true } };
  };
}>;

type TaskRow = TaskWithSortRank | TaskWithoutSortRank;

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

function toTaskItem(task: TaskRow) {
  const sortRank = "sortRank" in task && typeof task.sortRank === "number" ? task.sortRank : 0;

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    urgency: task.urgency,
    status: task.status,
    sortRank,
    deadline: task.deadline?.toISOString() ?? null,
    assigneeId: task.assigneeId,
    assigneeName: task.assignee?.displayName ?? null,
    createdById: task.createdById,
    createdByName: task.createdBy.displayName,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const url = new URL(request.url);
    const search = url.searchParams.get("search")?.trim() ?? "";
    const urgency = url.searchParams.get("urgency") ?? "";
    const status = url.searchParams.get("status") ?? "";

    const where: Prisma.WorkspaceTaskWhereInput = {
      AND: [
        { OR: [{ createdById: userId }, { assigneeId: userId }] },
        ...(search
          ? [
              {
                OR: [
                  { title: { contains: search } },
                  { description: { contains: search } },
                ],
              },
            ]
          : []),
        ...(urgency ? [{ urgency: urgency as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" }] : []),
        ...(status ? [{ status: status as "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED" }] : []),
      ],
    };

    const schemaState = await readWorkspaceTaskSchemaState(prisma);
    if (!schemaState.tableExists) {
      return NextResponse.json({ items: [] });
    }

    const tasks: TaskRow[] = schemaState.hasSortRank
      ? await prisma.workspaceTask.findMany({
          where,
          include: {
            assignee: { select: { id: true, displayName: true } },
            createdBy: { select: { id: true, displayName: true } },
          },
          orderBy: [{ sortRank: "asc" }, { createdAt: "desc" }],
          take: 100,
        })
      : await prisma.workspaceTask.findMany({
          where,
          select: {
            id: true,
            title: true,
            description: true,
            urgency: true,
            status: true,
            deadline: true,
            assigneeId: true,
            createdById: true,
            createdAt: true,
            updatedAt: true,
            assignee: { select: { id: true, displayName: true } },
            createdBy: { select: { id: true, displayName: true } },
          },
          orderBy: [{ createdAt: "desc" }],
          take: 100,
        });

    return NextResponse.json({
      items: tasks.map(toTaskItem),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const schemaState = await readWorkspaceTaskSchemaState(prisma);
    if (!schemaState.tableExists || !schemaState.hasSortRank) {
      return taskSchemaOutdatedResponse();
    }

    const body = await parseJsonBody<{
      title: string;
      description?: string;
      urgency?: string;
      status?: string;
      deadline?: string;
      assigneeId?: string;
    }>(request);

    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      return NextResponse.json(
        { errorCode: "INVALID_TITLE", message: "title is required." },
        { status: 400 },
      );
    }

    const targetStatus = (["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"].includes(body.status ?? "")
      ? body.status
      : "OPEN") as "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";

    const latestForStatus = await prisma.workspaceTask.findFirst({
      where: {
        status: targetStatus,
        OR: [{ createdById: userId }, { assigneeId: userId }],
      },
      orderBy: [{ sortRank: "desc" }, { createdAt: "desc" }],
      select: { sortRank: true },
    });

    const task = await prisma.workspaceTask.create({
      data: {
        title: body.title.trim(),
        description: body.description?.trim() ?? "",
        urgency: (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(body.urgency ?? "")
          ? body.urgency
          : "MEDIUM") as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
        status: targetStatus,
        sortRank: (latestForStatus?.sortRank ?? -1) + 1,
        deadline: body.deadline ? new Date(body.deadline) : null,
        assigneeId: body.assigneeId || null,
        createdById: userId,
      },
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
