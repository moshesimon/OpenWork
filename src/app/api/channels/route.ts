import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { createChannelPrimitive } from "@/server/agent-service";

export async function POST(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<{ name?: unknown; slug?: unknown; reason?: unknown }>(
      request,
    );

    const payload = await createChannelPrimitive(prisma, userId, {
      name: typeof body.name === "string" ? body.name : "",
      slug: typeof body.slug === "string" ? body.slug : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });

    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
