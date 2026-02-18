import { NextRequest } from "next/server";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentTurnJob: vi.fn(),
  transaction: vi.fn(),
  createChatMessage: vi.fn(),
  findAgentTask: vi.fn(),
}));

vi.mock("@/trigger/client", () => ({
  runAgentTurnJob: mocks.runAgentTurnJob,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    agentChatMessage: {
      create: mocks.createChatMessage,
    },
    agentTask: {
      findUnique: mocks.findAgentTask,
    },
  },
}));

import { POST } from "@/app/api/agent/commands/route";

function makeRequest(body: unknown, userId = "u_alex"): NextRequest {
  return new NextRequest("http://localhost/api/agent/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
    },
    body: JSON.stringify(body),
  });
}

describe("agent command route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    let messageCounter = 0;
    mocks.createChatMessage.mockImplementation(
      async (args: { data: { role: "user" | "assistant"; body: string; taskId?: string } }) => {
        messageCounter += 1;
        return {
          id: `chat_${messageCounter}`,
          role: args.data.role,
          body: args.data.body,
          taskId: args.data.taskId ?? null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
      },
    );
    mocks.transaction.mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations));
    mocks.findAgentTask.mockResolvedValue({ status: "COMPLETED" });
    mocks.runAgentTurnJob.mockResolvedValue({
      triggerType: "USER_MESSAGE",
      taskId: "task_123",
      reply: "Command executed.",
    });
  });

  it("sanitizes mentions and merges derived context hints before dispatching unified turn job", async () => {
    const request = makeRequest({
      input: "  Please summarize the attached context.  ",
      mode: "AUTO",
      contextHints: {
        userIds: ["u_manual", "u_owner"],
        channelIds: ["ch_manual"],
        conversationIds: ["conv_manual"],
        taskIds: ["task_manual"],
        eventIds: ["evt_manual"],
        filePaths: ["manual/path.md"],
      },
      mentions: [
        {
          kind: "event",
          eventId: "ev_9",
          title: "Roadmap review",
          startAt: "2026-02-01T10:00:00.000Z",
          endAt: "2026-02-01T11:00:00.000Z",
          allDay: false,
          ownerId: "u_owner",
          attendeeUserIds: ["u_guest", "u_guest", "u_guest2"],
        },
        {
          kind: "task",
          taskId: "task_7",
          title: "Finalize release notes",
          description: "Need final approval",
          urgency: "HIGH",
          status: "OPEN",
          assigneeId: "u_assignee",
          createdById: "u_creator",
          updatedAt: "2026-02-01T09:00:00.000Z",
        },
        {
          kind: "dm",
          userId: "u_diego",
          displayName: "Diego Moss",
          conversationId: "conv_dm_123",
        },
        {
          kind: "channel",
          channelId: "ch_design",
          channelSlug: "design",
          channelName: "design",
          conversationId: "conv_ch_design",
        },
        {
          kind: "file",
          path: "docs/q1-plan.md",
          name: "q1-plan.md",
        },
        {
          kind: "event",
          eventId: "",
        },
        {
          kind: "unknown",
          foo: "bar",
        },
      ],
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.taskId).toBe("task_123");
    expect(payload.status).toBe("COMPLETED");
    expect(payload.reply).toBe("Command executed.");

    expect(mocks.runAgentTurnJob).toHaveBeenCalledTimes(1);
    expect(mocks.runAgentTurnJob).toHaveBeenCalledWith({
      userId: "u_alex",
      trigger: {
        type: "USER_MESSAGE",
        payload: {
          input: "Please summarize the attached context.",
          mode: "AUTO",
          mentions: [
            {
              kind: "event",
              eventId: "ev_9",
              title: "Roadmap review",
              startAt: "2026-02-01T10:00:00.000Z",
              endAt: "2026-02-01T11:00:00.000Z",
              allDay: false,
              ownerId: "u_owner",
              attendeeUserIds: ["u_guest", "u_guest2"],
            },
            {
              kind: "task",
              taskId: "task_7",
              title: "Finalize release notes",
              description: "Need final approval",
              urgency: "HIGH",
              status: "OPEN",
              assigneeId: "u_assignee",
              createdById: "u_creator",
              updatedAt: "2026-02-01T09:00:00.000Z",
            },
            {
              kind: "dm",
              userId: "u_diego",
              displayName: "Diego Moss",
              conversationId: "conv_dm_123",
            },
            {
              kind: "channel",
              channelId: "ch_design",
              channelSlug: "design",
              channelName: "design",
              conversationId: "conv_ch_design",
            },
            {
              kind: "file",
              path: "docs/q1-plan.md",
              name: "q1-plan.md",
            },
          ],
        },
      },
      contextHints: {
        userIds: [
          "u_manual",
          "u_owner",
          "u_guest",
          "u_guest2",
          "u_creator",
          "u_assignee",
          "u_diego",
        ],
        channelIds: ["ch_manual", "ch_design"],
        conversationIds: ["conv_manual", "conv_dm_123", "conv_ch_design"],
        taskIds: ["task_manual", "task_7"],
        eventIds: ["evt_manual", "ev_9"],
        filePaths: ["manual/path.md", "docs/q1-plan.md"],
      },
    });
    expect(mocks.createChatMessage).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("drops invalid mentions and omits context hints when none are left", async () => {
    const response = await POST(
      makeRequest({
        input: "Ping the team.",
        mentions: [
          {
            kind: "task",
            taskId: "task_1",
          },
          {
            kind: "file",
            path: "",
            name: "",
          },
          {
            kind: "not_supported",
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runAgentTurnJob).toHaveBeenCalledTimes(1);

    const callInput = mocks.runAgentTurnJob.mock.calls[0][0] as {
      trigger: {
        payload: {
          mentions: unknown[];
        };
      };
      contextHints?: unknown;
    };
    expect(callInput.trigger.payload.mentions).toEqual([]);
    expect(callInput.contextHints).toBeUndefined();
  });

  it("returns 400 for empty command input", async () => {
    const response = await POST(
      makeRequest({
        input: "   ",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.errorCode).toBe("INVALID_COMMAND_INPUT");
    expect(mocks.runAgentTurnJob).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
