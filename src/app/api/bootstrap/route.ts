import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { requireUserIdHeader } from "@/lib/request";
import { getBootstrapData } from "@/server/chat-service";
import { runBootstrapAnalysisJob } from "@/trigger/client";

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    try {
      await runBootstrapAnalysisJob({ userId });
    } catch (analysisError) {
      console.warn("Bootstrap proactive analysis failed:", analysisError);
    }
    const payload = await getBootstrapData(prisma, userId);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
