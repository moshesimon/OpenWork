import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { getAgentProfile, updateAgentProfile } from "@/server/agent-service";
import { publishRealtimeEvent } from "@/server/realtime-events";

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const payload = await getAgentProfile(prisma, userId);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<{
      defaultAutonomyLevel?: unknown;
      senderMode?: unknown;
      settings?: unknown;
      relevance?: {
        priorityPeople?: unknown;
        priorityChannels?: unknown;
        priorityTopics?: unknown;
        urgencyKeywords?: unknown;
        mutedTopics?: unknown;
      };
    }>(request);

    const payload = await updateAgentProfile(prisma, userId, body);
    publishRealtimeEvent({
      type: "profile-update",
      reason: "profile-updated",
      userIds: [userId],
    });
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
