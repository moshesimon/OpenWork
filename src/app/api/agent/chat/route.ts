import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const limit = Math.min(
      Number(request.nextUrl.searchParams.get("limit") ?? "100"),
      200,
    );

    const rows = await prisma.agentChatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        role: true,
        body: true,
        taskId: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        body: r.body,
        taskId: r.taskId,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
