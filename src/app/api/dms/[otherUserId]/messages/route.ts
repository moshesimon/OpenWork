import { NextRequest, NextResponse } from "next/server";
import { AgentTaskSource } from "@prisma/client";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { createDmMessage, getDmMessagesPage } from "@/server/chat-service";
import { publishRealtimeEvent } from "@/server/realtime-events";
import { runAgentTurnJob } from "@/trigger/client";

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

    publishRealtimeEvent({
      type: "workspace-update",
      reason: "dm-message-created",
      conversationId: response.message.conversationId,
      userIds: [userId, otherUserId],
    });

    try {
      await runAgentTurnJob({
        userId: otherUserId,
        trigger: {
          type: "SYSTEM_EVENT",
          payload: {
            source: AgentTaskSource.INBOUND_DM_MESSAGE,
            triggerRef: response.message.id,
            event: {
              sourceConversationId: response.message.conversationId,
              sourceMessageId: response.message.id,
              sourceSenderId: response.message.sender.id,
              messageBody: response.message.body,
              isDm: true,
            },
          },
        },
        contextHints: {
          userIds: [userId, otherUserId],
        },
      });
    } catch (analysisError) {
      console.warn("DM proactive analysis failed:", analysisError);
    }

    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
