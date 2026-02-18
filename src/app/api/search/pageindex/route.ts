import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api-error";
import { parseJsonBody } from "@/lib/request";
import { searchPageIndex } from "@/server/pageindex-search";

export const runtime = "nodejs";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }

  return value as Record<string, unknown>;
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export async function POST(request: NextRequest) {
  try {
    const body = asRecord(await parseJsonBody<unknown>(request));
    const query = typeof body.query === "string" ? body.query : "";
    const limit = parseLimit(body.limit);

    const payload = await searchPageIndex({
      query,
      limit,
    });

    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
