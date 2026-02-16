import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";
import { markConversationRead } from "@/server/chat-service";

type Params = {
  conversationId: string;
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<Params> },
) {
  try {
    const { conversationId } = await context.params;
    const userId = requireUserIdHeader(request);
    const response = await markConversationRead(prisma, userId, conversationId);
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
