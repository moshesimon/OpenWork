import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-error";

export function requireUserIdHeader(request: NextRequest): string {
  const userId = request.headers.get("x-user-id")?.trim();

  if (!userId) {
    throw new ApiError(400, "MISSING_USER_HEADER", "x-user-id header is required.");
  }

  return userId;
}

export async function parseJsonBody<T>(request: NextRequest): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}
