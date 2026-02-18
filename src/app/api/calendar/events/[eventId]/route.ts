import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { deleteCalendarEvent, updateCalendarEvent } from "@/server/calendar-service";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const userId = requireUserIdHeader(request);
    const url = new URL(request.url);
    const ownerId = url.searchParams.get("ownerId") ?? undefined;
    const { eventId } = await params;
    const body = await parseJsonBody<{
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      allDay?: boolean;
      attendeeUserIds?: string[];
    }>(request);

    const event = await updateCalendarEvent(prisma, userId, eventId, body, { ownerId });
    return NextResponse.json(event);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const userId = requireUserIdHeader(request);
    const url = new URL(request.url);
    const ownerId = url.searchParams.get("ownerId") ?? undefined;
    const { eventId } = await params;

    const deleted = await deleteCalendarEvent(prisma, userId, eventId, { ownerId });
    return NextResponse.json(deleted);
  } catch (error) {
    return errorResponse(error);
  }
}
