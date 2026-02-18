import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { createCalendarEvent, listCalendarEvents } from "@/server/calendar-service";

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const url = new URL(request.url);
    const start = url.searchParams.get("start") ?? undefined;
    const end = url.searchParams.get("end") ?? undefined;
    const search = url.searchParams.get("search") ?? undefined;
    const ownerId = url.searchParams.get("ownerId") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

    const payload = await listCalendarEvents(prisma, userId, {
      start,
      end,
      search,
      limit,
      ownerId,
    });

    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<{
      title: string;
      description?: string;
      location?: string;
      startAt: string;
      endAt: string;
      allDay?: boolean;
      ownerId?: string;
      attendeeUserIds?: string[];
    }>(request);

    const event = await createCalendarEvent(prisma, userId, body);
    return NextResponse.json(event);
  } catch (error) {
    return errorResponse(error);
  }
}
