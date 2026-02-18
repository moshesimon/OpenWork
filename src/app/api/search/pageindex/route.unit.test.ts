import { NextRequest } from "next/server";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchPageIndex: vi.fn(),
}));

vi.mock("@/server/pageindex-search", () => ({
  searchPageIndex: mocks.searchPageIndex,
}));

import { POST } from "@/app/api/search/pageindex/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/search/pageindex", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("/api/search/pageindex route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchPageIndex.mockResolvedValue({
      query: "roadmap",
      total: 1,
      tookMs: 3,
      results: [],
    });
  });

  it("forwards strict payload to searchPageIndex", async () => {
    const response = await POST(
      makeRequest({
        query: "roadmap",
        limit: 10,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.searchPageIndex).toHaveBeenCalledTimes(1);
    expect(mocks.searchPageIndex).toHaveBeenCalledWith({
      query: "roadmap",
      limit: 10,
    });
  });

  it("parses limit from string values", async () => {
    const response = await POST(
      makeRequest({
        query: "roadmap",
        limit: "5",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.searchPageIndex).toHaveBeenCalledWith({
      query: "roadmap",
      limit: 5,
    });
  });

  it("returns 400 when body is not an object", async () => {
    const response = await POST(makeRequest("not-an-object"));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.errorCode).toBe("INVALID_BODY");
    expect(mocks.searchPageIndex).not.toHaveBeenCalled();
  });
});
