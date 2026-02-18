import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import { getAgentPolicies, replaceAgentPolicies } from "@/server/agent-service";
import type { AgentPolicyInput } from "@/types/agent";

export async function GET(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const payload = await getAgentPolicies(prisma, userId);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const userId = requireUserIdHeader(request);
    const body = await parseJsonBody<{ rules?: AgentPolicyInput[] }>(request);
    const payload = await replaceAgentPolicies(prisma, userId, body.rules ?? []);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
