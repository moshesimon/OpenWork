import { BriefingStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";
import { getBriefings } from "@/server/agent-service";

function parseStatus(value: string | null): BriefingStatus | undefined {
  if (value === "UNREAD" || value === "ACKED" || value === "DISMISSED" || value === "ACTED") {
    return value;
  }

  return undefined;
}

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const status = parseStatus(request.nextUrl.searchParams.get("status"));
    const limitRaw = request.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;

    const payload = await getBriefings(
      prisma,
      userId,
      status,
      Number.isFinite(limit) && limit > 0 ? limit : 20,
    );

    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
