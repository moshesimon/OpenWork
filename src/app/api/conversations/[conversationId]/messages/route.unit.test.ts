import { NextRequest } from "next/server";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConversationMessagesPage: vi.fn(),
  createConversationMessage: vi.fn(),
  publishRealtimeEvent: vi.fn(),
  runAgentTurnJob: vi.fn(),
  findConversation: vi.fn(),
  findUsers: vi.fn(),
}));

vi.mock("@/server/chat-service", () => ({
  getConversationMessagesPage: mocks.getConversationMessagesPage,
  createConversationMessage: mocks.createConversationMessage,
}));

vi.mock("@/server/realtime-events", () => ({
  publishRealtimeEvent: mocks.publishRealtimeEvent,
}));

vi.mock("@/trigger/client", () => ({
  runAgentTurnJob: mocks.runAgentTurnJob,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tag: "mock-prisma",
    conversation: {
      findUnique: mocks.findConversation,
    },
    user: {
      findMany: mocks.findUsers,
    },
  },
}));

import { GET, POST } from "@/app/api/conversations/[conversationId]/messages/route";

function makeRequest(
  method: "GET" | "POST",
  body?: unknown,
  userId = "u_alex",
  search = "",
): NextRequest {
  return new NextRequest(`http://localhost/api/conversations/conv_123/messages${search}`, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "x-user-id": userId,
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
}

describe("/api/conversations/[conversationId]/messages route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getConversationMessagesPage.mockResolvedValue({
      messages: [],
      nextCursor: null,
    });

    mocks.createConversationMessage.mockResolvedValue({
      message: {
        id: "msg_ch_123",
        conversationId: "conv_123",
        body: "Status update",
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

  it("loads conversation messages for the requested conversation", async () => {
    const response = await GET(
      makeRequest("GET", undefined, "u_alex", "?cursor=next&limit=9"),
      {
        params: Promise.resolve({ conversationId: "conv_123" }),
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.getConversationMessagesPage).toHaveBeenCalledTimes(1);
    expect(mocks.getConversationMessagesPage).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "mock-prisma" }),
      "u_alex",
      "conv_123",
      "next",
      "9",
    );
  });

  it("dispatches channel inbound events through unified SYSTEM_EVENT triggers", async () => {
    mocks.findConversation.mockResolvedValue({
      type: "CHANNEL",
      dmUserAId: null,
      dmUserBId: null,
    });
    mocks.findUsers.mockResolvedValue([{ id: "u_brooke" }, { id: "u_casey" }]);

    const response = await POST(
      makeRequest("POST", { body: "Status update" }, "u_alex"),
      {
        params: Promise.resolve({ conversationId: "conv_123" }),
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.publishRealtimeEvent).toHaveBeenCalledWith({
      type: "workspace-update",
      reason: "channel-message-created",
      conversationId: "conv_123",
      userIds: undefined,
    });
    expect(mocks.runAgentTurnJob).toHaveBeenCalledTimes(2);
    expect(mocks.runAgentTurnJob).toHaveBeenNthCalledWith(1, {
      userId: "u_brooke",
      trigger: {
        type: "SYSTEM_EVENT",
        payload: {
          source: "INBOUND_CHANNEL_MESSAGE",
          triggerRef: "msg_ch_123",
          event: {
            sourceConversationId: "conv_123",
            sourceMessageId: "msg_ch_123",
            sourceSenderId: "u_alex",
            messageBody: "Status update",
            isDm: false,
          },
        },
      },
    });
    expect(mocks.runAgentTurnJob).toHaveBeenNthCalledWith(2, {
      userId: "u_casey",
      trigger: {
        type: "SYSTEM_EVENT",
        payload: {
          source: "INBOUND_CHANNEL_MESSAGE",
          triggerRef: "msg_ch_123",
          event: {
            sourceConversationId: "conv_123",
            sourceMessageId: "msg_ch_123",
            sourceSenderId: "u_alex",
            messageBody: "Status update",
            isDm: false,
          },
        },
      },
    });
  });

  it("uses DM task source when the conversation is a DM", async () => {
    mocks.findConversation.mockResolvedValue({
      type: "DM",
      dmUserAId: "u_alex",
      dmUserBId: "u_brooke",
    });

    const response = await POST(
      makeRequest("POST", { body: "Direct ping" }, "u_alex"),
      {
        params: Promise.resolve({ conversationId: "conv_dm_77" }),
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.findUsers).not.toHaveBeenCalled();
    expect(mocks.publishRealtimeEvent).toHaveBeenCalledWith({
      type: "workspace-update",
      reason: "dm-message-created",
      conversationId: "conv_123",
      userIds: ["u_alex", "u_brooke"],
    });
    expect(mocks.runAgentTurnJob).toHaveBeenCalledTimes(1);
    expect(mocks.runAgentTurnJob).toHaveBeenCalledWith({
      userId: "u_brooke",
      trigger: {
        type: "SYSTEM_EVENT",
        payload: {
          source: "INBOUND_DM_MESSAGE",
          triggerRef: "msg_ch_123",
          event: {
            sourceConversationId: "conv_123",
            sourceMessageId: "msg_ch_123",
            sourceSenderId: "u_alex",
            messageBody: "Status update",
            isDm: true,
          },
        },
      },
    });
  });
});
