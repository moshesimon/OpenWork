import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { createDmPrimitive } from "@/server/agent-service";

export async function POST(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<{ otherUserId?: unknown }>(request);

    const payload = await createDmPrimitive(prisma, userId, {
      otherUserId: typeof body.otherUserId === "string" ? body.otherUserId : "",
    });

    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
