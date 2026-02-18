import { NextRequest, NextResponse } from "next/server";
import { AgentTaskSource } from "@prisma/client";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import {
  createConversationMessage,
  getConversationMessagesPage,
} from "@/server/chat-service";
import { publishRealtimeEvent } from "@/server/realtime-events";
import { runProactiveAnalysisJob } from "@/trigger/client";

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

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        type: true,
        dmUserAId: true,
        dmUserBId: true,
      },
    });

    const targets =
      conversation?.type === "DM"
        ? [conversation.dmUserAId, conversation.dmUserBId].filter(
            (id): id is string => Boolean(id && id !== userId),
          )
        : (
            await prisma.user.findMany({
              where: {
                id: {
                  not: userId,
                },
              },
              select: { id: true },
            })
          ).map((user) => user.id);

    publishRealtimeEvent({
      type: "workspace-update",
      reason:
        conversation?.type === "DM"
          ? "dm-message-created"
          : "channel-message-created",
      conversationId: response.message.conversationId,
      userIds:
        conversation?.type === "DM"
          ? [conversation.dmUserAId, conversation.dmUserBId].filter(
              (id): id is string => Boolean(id),
            )
          : undefined,
    });

    try {
      await Promise.all(
        targets.map((targetUserId) =>
          runProactiveAnalysisJob({
            userId: targetUserId,
            source:
              conversation?.type === "DM"
                ? AgentTaskSource.INBOUND_DM_MESSAGE
                : AgentTaskSource.INBOUND_CHANNEL_MESSAGE,
            triggerRef: response.message.id,
            event: {
              sourceConversationId: response.message.conversationId,
              sourceMessageId: response.message.id,
              sourceSenderId: response.message.sender.id,
              messageBody: response.message.body,
              isDm: conversation?.type === "DM",
            },
          }),
        ),
      );
    } catch (analysisError) {
      console.warn("Conversation proactive analysis failed:", analysisError);
    }

    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
