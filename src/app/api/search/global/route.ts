import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";
import { searchWorkspaceGlobal } from "@/server/global-search";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const query = request.nextUrl.searchParams.get("q") ?? "";
    const rawLimit = request.nextUrl.searchParams.get("limit");
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;

    const payload = await searchWorkspaceGlobal(prisma, userId, {
      query,
      limit,
    });

    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
