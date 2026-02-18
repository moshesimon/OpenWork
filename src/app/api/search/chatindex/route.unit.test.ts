import { NextRequest } from "next/server";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchChatIndex: vi.fn(),
}));

vi.mock("@/server/chatindex-search", () => ({
  searchChatIndex: mocks.searchChatIndex,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { tag: "mock-prisma" },
}));

import { POST } from "@/app/api/search/chatindex/route";

function makeRequest(body: unknown, userId?: string): NextRequest {
  return new NextRequest("http://localhost/api/search/chatindex", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-user-id": userId } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("/api/search/chatindex route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchChatIndex.mockResolvedValue({
      query: "orion",
      total: 1,
      tookMs: 2,
      results: [],
    });
  });

  it("forwards a strict payload to searchChatIndex", async () => {
    const response = await POST(
      makeRequest({
        query: "orion",
        userId: "u_alex",
        limit: 12,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.searchChatIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchChatIndex).toHaveBeenCalledWith(
      { tag: "mock-prisma" },
      {
        query: "orion",
        userId: "u_alex",
        limit: 12,
      },
    );
  });

  it("falls back to x-user-id when body.userId is missing", async () => {
    const response = await POST(
      makeRequest(
        {
          query: "orion",
          limit: "7",
        },
        "u_brooke",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.searchChatIndex).toHaveBeenCalledWith(
      { tag: "mock-prisma" },
      {
        query: "orion",
        userId: "u_brooke",
        limit: 7,
      },
    );
  });

  it("returns 400 when body is not an object", async () => {
    const response = await POST(makeRequest(["not", "an", "object"]));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.errorCode).toBe("INVALID_BODY");
    expect(mocks.searchChatIndex).not.toHaveBeenCalled();
  });
});
