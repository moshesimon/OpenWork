import { BriefingStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";
import { updateBriefingStatus } from "@/server/agent-service";

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
    const payload = await updateBriefingStatus(prisma, userId, id, BriefingStatus.ACKED);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
