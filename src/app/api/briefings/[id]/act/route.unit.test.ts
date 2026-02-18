import { NextRequest } from "next/server";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentTurnJob: vi.fn(),
  updateBriefingStatus: vi.fn(),
}));

vi.mock("@/trigger/client", () => ({
  runAgentTurnJob: mocks.runAgentTurnJob,
}));

vi.mock("@/server/agent-service", () => ({
  updateBriefingStatus: mocks.updateBriefingStatus,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import { POST } from "@/app/api/briefings/[id]/act/route";

function makeRequest(body: unknown, userId = "u_alex"): NextRequest {
  return new NextRequest("http://localhost/api/briefings/briefing_1/act", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
    },
    body: JSON.stringify(body),
  });
}

function makeContext(id = "briefing_1"): { params: Promise<{ id: string }> } {
  return {
    params: Promise.resolve({ id }),
  };
}

describe("briefing act route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateBriefingStatus.mockResolvedValue({
      id: "briefing_1",
      status: "ACTED",
    });
    mocks.runAgentTurnJob.mockResolvedValue({
      triggerType: "USER_MESSAGE",
      taskId: "task_followup_1",
      reply: "Done.",
    });
  });

  it("dispatches follow-up input through unified turn job", async () => {
    const response = await POST(makeRequest({ input: "Please send a follow-up" }), makeContext());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.updateBriefingStatus).toHaveBeenCalledTimes(1);
    expect(mocks.runAgentTurnJob).toHaveBeenCalledWith({
      userId: "u_alex",
      trigger: {
        type: "USER_MESSAGE",
        payload: {
          input: "Please send a follow-up",
        },
      },
    });
    expect(payload.followupTaskId).toBe("task_followup_1");
  });

  it("does not enqueue a follow-up turn when input is blank", async () => {
    const response = await POST(makeRequest({ input: "   " }), makeContext());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.updateBriefingStatus).toHaveBeenCalledTimes(1);
    expect(mocks.runAgentTurnJob).not.toHaveBeenCalled();
    expect(payload.followupTaskId).toBeNull();
  });

  it("handles system-event no-op fallback results without a follow-up task id", async () => {
    mocks.runAgentTurnJob.mockResolvedValue({
      triggerType: "SYSTEM_EVENT",
      handled: true,
    });

    const response = await POST(makeRequest({ input: "Try again" }), makeContext());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.runAgentTurnJob).toHaveBeenCalledTimes(1);
    expect(payload.followupTaskId).toBeNull();
  });
});
