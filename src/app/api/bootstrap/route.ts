import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";
import { getBootstrapData } from "@/server/chat-service";

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const payload = await getBootstrapData(prisma, userId);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
