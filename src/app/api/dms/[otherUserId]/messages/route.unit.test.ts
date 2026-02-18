import { NextRequest } from "next/server";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDmMessagesPage: vi.fn(),
  createDmMessage: vi.fn(),
  publishRealtimeEvent: vi.fn(),
  runAgentTurnJob: vi.fn(),
}));

vi.mock("@/server/chat-service", () => ({
  getDmMessagesPage: mocks.getDmMessagesPage,
  createDmMessage: mocks.createDmMessage,
}));

vi.mock("@/server/realtime-events", () => ({
  publishRealtimeEvent: mocks.publishRealtimeEvent,
}));

vi.mock("@/trigger/client", () => ({
  runAgentTurnJob: mocks.runAgentTurnJob,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { tag: "mock-prisma" },
}));

import { GET, POST } from "@/app/api/dms/[otherUserId]/messages/route";

function makeRequest(
  method: "GET" | "POST",
  body?: unknown,
  userId = "u_alex",
  search = "",
): NextRequest {
  return new NextRequest(`http://localhost/api/dms/u_brooke/messages${search}`, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "x-user-id": userId,
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
}

describe("/api/dms/[otherUserId]/messages route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getDmMessagesPage.mockResolvedValue({
      messages: [],
      nextCursor: null,
    });

    mocks.createDmMessage.mockResolvedValue({
      message: {
        id: "msg_dm_123",
        conversationId: "conv_dm_123",
        body: "Ping from Alex",
        sender: {
          id: "u_alex",
        },
      },
    });

    mocks.runAgentTurnJob.mockResolvedValue({
      triggerType: "SYSTEM_EVENT",
      handled: true,
    });
  });

  it("loads DM messages for the requested user pair", async () => {
    const response = await GET(makeRequest("GET", undefined, "u_alex", "?cursor=c1&limit=15"), {
      params: Promise.resolve({ otherUserId: "u_brooke" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getDmMessagesPage).toHaveBeenCalledTimes(1);
    expect(mocks.getDmMessagesPage).toHaveBeenCalledWith(
      { tag: "mock-prisma" },
      "u_alex",
      "u_brooke",
      "c1",
      "15",
    );
  });

  it("dispatches inbound DM events through the unified SYSTEM_EVENT trigger", async () => {
    const response = await POST(
      makeRequest("POST", { body: "Ping from Alex" }, "u_alex"),
      {
        params: Promise.resolve({ otherUserId: "u_brooke" }),
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.createDmMessage).toHaveBeenCalledTimes(1);
    expect(mocks.publishRealtimeEvent).toHaveBeenCalledTimes(1);
    expect(mocks.publishRealtimeEvent).toHaveBeenCalledWith({
      type: "workspace-update",
      reason: "dm-message-created",
      conversationId: "conv_dm_123",
      userIds: ["u_alex", "u_brooke"],
    });

    expect(mocks.runAgentTurnJob).toHaveBeenCalledTimes(1);
    expect(mocks.runAgentTurnJob).toHaveBeenCalledWith({
      userId: "u_brooke",
      trigger: {
        type: "SYSTEM_EVENT",
        payload: {
          source: "INBOUND_DM_MESSAGE",
          triggerRef: "msg_dm_123",
          event: {
            sourceConversationId: "conv_dm_123",
            sourceMessageId: "msg_dm_123",
            sourceSenderId: "u_alex",
            messageBody: "Ping from Alex",
            isDm: true,
          },
        },
      },
      contextHints: {
        userIds: ["u_alex", "u_brooke"],
      },
    });
  });
});
