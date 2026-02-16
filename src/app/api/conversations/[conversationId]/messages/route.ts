import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import {
  createConversationMessage,
  getConversationMessagesPage,
} from "@/server/chat-service";

type Params = {
  conversationId: string;
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<Params> },
) {
  try {
    const { conversationId } = await context.params;
    const userId = requireUserIdHeader(request);
    const response = await getConversationMessagesPage(
      prisma,
      userId,
      conversationId,
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
    const { conversationId } = await context.params;
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<{ body?: unknown }>(request);
    const response = await createConversationMessage(
      prisma,
      userId,
      conversationId,
      body.body,
    );

    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
