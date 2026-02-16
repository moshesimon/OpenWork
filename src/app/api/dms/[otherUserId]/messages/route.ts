import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { createDmMessage, getDmMessagesPage } from "@/server/chat-service";

type Params = {
  otherUserId: string;
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<Params> },
) {
  try {
    const { otherUserId } = await context.params;
    const userId = requireUserIdHeader(request);
    const response = await getDmMessagesPage(
      prisma,
      userId,
      otherUserId,
      request.nextUrl.searchParams.get("cursor"),
      request.nextUrl.searchParams.get("limit"),
    );
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<Params> },
) {
  try {
    const { otherUserId } = await context.params;
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<{ body?: unknown }>(request);
    const response = await createDmMessage(prisma, userId, otherUserId, body.body);
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
