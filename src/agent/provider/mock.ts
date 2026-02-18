import type { AgentProvider, AgentRuntimeTool, AgentTurnInput } from "@/agent/provider/types";

function keywordIncludes(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

function extractQuotedTitle(input: string): string | null {
  const quoted = input.match(/"([^"]+)"|'([^']+)'/);
  const value = quoted?.[1] ?? quoted?.[2] ?? "";
  return value.trim() ? value.trim() : null;
}

function extractDurationMinutes(input: string): number {
  const hours = input.match(/for\s+(\d+)\s*(hour|hours|hr|hrs|h)\b/i);
  if (hours) {
    return Number.parseInt(hours[1], 10) * 60;
  }

  const mins = input.match(/for\s+(\d+)\s*(minute|minutes|min|mins|m)\b/i);
  if (mins) {
    return Number.parseInt(mins[1], 10);
  }

  return 30;
}

function extractTimeParts(input: string): { hour: number; minute: number } | null {
  const explicit = input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!explicit) {
    return null;
  }

  let hour = Number.parseInt(explicit[1], 10);
  const minute = explicit[2] ? Number.parseInt(explicit[2], 10) : 0;
  const meridiem = explicit[3]?.toLowerCase();

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }

  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function calendarQueryRange(input: string): { start: string; end: string } {
  const lower = input.toLowerCase();
  const now = new Date();
  const today = startOfDay(now);

  if (lower.includes("yesterday")) {
    const start = addDays(today, -1);
    return { start: start.toISOString(), end: today.toISOString() };
  }

  if (lower.includes("last week")) {
    const start = addDays(today, -7);
    return { start: start.toISOString(), end: today.toISOString() };
  }

  if (lower.includes("tomorrow")) {
    const start = addDays(today, 1);
    const end = addDays(start, 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  if (lower.includes("today")) {
    const end = addDays(today, 1);
    return { start: today.toISOString(), end: end.toISOString() };
  }

  if (lower.includes("next week")) {
    const start = addDays(today, 7);
    const end = addDays(start, 7);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  return {
    start: today.toISOString(),
    end: addDays(today, 7).toISOString(),
  };
}

function extractStartAtIso(input: string): string | null {
  const isoMatch = input.match(/\b\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2})?)?(?:[zZ])?\b/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const now = new Date();
  let base: Date | null = null;
  const lower = input.toLowerCase();

  if (lower.includes("tomorrow")) {
    base = addDays(now, 1);
  } else if (lower.includes("today")) {
    base = now;
  } else if (lower.includes("next week")) {
    base = addDays(now, 7);
  }

  const timeParts = extractTimeParts(input);
  if (!base && !timeParts) {
    return null;
  }

  const result = new Date(base ?? now);
  result.setSeconds(0, 0);

  if (timeParts) {
    result.setHours(timeParts.hour, timeParts.minute, 0, 0);
  } else {
    result.setHours(9, 0, 0, 0);
  }

  return result.toISOString();
}

function inferTaskStatus(input: string): "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED" | null {
  const lower = input.toLowerCase();

  if (/\b(reopen|backlog|to do|todo|open)\b/.test(lower)) {
    return "OPEN";
  }

  if (/\b(in progress|in-progress|working on|start|started|doing)\b/.test(lower)) {
    return "IN_PROGRESS";
  }

  if (/\b(done|complete|completed|finish|finished|close|closed)\b/.test(lower)) {
    return "DONE";
  }

  if (/\b(cancel|cancelled|canceled|drop|abandon|wont do|won't do)\b/.test(lower)) {
    return "CANCELLED";
  }

  return null;
}

function inferCalendarTitle(input: string): string | null {
  const quoted = extractQuotedTitle(input);
  if (quoted) {
    return quoted;
  }

  const lower = input.toLowerCase();
  const createMatch = lower.match(
    /(?:schedule|add|create|book|set up|setup)\s+(?:a\s+)?(?:meeting|event|appointment|call)\s+(.+?)(?:\s+(?:at|on|for)\b|$)/,
  );
  if (createMatch?.[1]) {
    return createMatch[1].trim();
  }

  const eventMatch = lower.match(
    /(?:event|meeting|appointment)\s+(?:called|named|titled)?\s*"?([^"\n]+?)"?(?:\s+(?:to|at|on|for|from)\b|$)/,
  );

  return eventMatch?.[1]?.trim() || null;
}

function extractUserLookupHint(input: string): string | null {
  const explicitId = input.match(/\b(u_[a-z0-9_]+)\b/i);
  if (explicitId?.[1]) {
    return explicitId[1].toLowerCase();
  }

  const possessiveMatch = input.match(
    /\b([a-z][a-z]+(?:\s+[a-z][a-z]+)?)'s\s+(?:calendar|schedule|tasks?|todos?)\b/i,
  );
  if (possessiveMatch?.[1]) {
    return possessiveMatch[1].trim();
  }

  const targetMatch = input.match(/\b(?:for|assign(?:ed)?\s+to)\s+([a-z][a-z]+(?:\s+[a-z][a-z]+)?)\b/i);
  if (targetMatch?.[1]) {
    const candidate = targetMatch[1].trim().split(/\s+/)[0] ?? "";
    if (!["my", "me", "today", "tomorrow"].includes(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return null;
}

async function resolveUserIdHint(input: AgentTurnInput, message: string): Promise<string | null> {
  const hint = extractUserLookupHint(message);
  if (!hint) {
    return null;
  }

  return resolveUserIdFromHint(input, hint);
}

async function resolveUserIdFromHint(input: AgentTurnInput, hint: string): Promise<string | null> {
  if (hint.startsWith("u_")) {
    return hint;
  }

  const usersOutput = await runTool(input, "list_users", {
    query: hint,
    limit: 8,
  });

  const users = Array.isArray(usersOutput?.users) ? usersOutput.users : [];
  if (users.length === 0) {
    return null;
  }

  const normalizedHint = hint.toLowerCase();
  const normalizedHintFirst = normalizedHint.split(/\s+/)[0];
  let fallbackId: string | null = null;

  for (const user of users) {
    if (!user || typeof user !== "object") {
      continue;
    }

    const id = typeof user.id === "string" ? user.id : null;
    const displayName = typeof user.displayName === "string" ? user.displayName : null;
    if (!id) {
      continue;
    }

    fallbackId ??= id;

    if (id.toLowerCase() === normalizedHint) {
      return id;
    }

    if (displayName) {
      const normalizedDisplayName = displayName.toLowerCase();
      const displayFirst = normalizedDisplayName.split(/\s+/)[0];
      if (normalizedDisplayName === normalizedHint || displayFirst === normalizedHintFirst) {
        return id;
      }
    }
  }

  return fallbackId;
}

function extractWithUserHints(message: string): string[] {
  const withMatch = message.match(
    /\bwith\s+(.+?)(?=\s+(?:at|on|for|tomorrow|today|next|this|in)\b|$|[,.!?])/i,
  );
  if (!withMatch?.[1]) {
    return [];
  }

  return withMatch[1]
    .split(/\s*(?:,|and)\s*/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => {
      const lower = segment.toLowerCase();
      return !["me", "myself", "my", "you", "yourself"].includes(lower);
    });
}

async function resolveMeetingAttendeeUserIds(
  input: AgentTurnInput,
  message: string,
  exclude: string[],
): Promise<string[]> {
  const resolved = new Set<string>();
  const excluded = new Set(exclude);
  const hints = extractWithUserHints(message);

  for (const hint of hints) {
    const resolvedId = await resolveUserIdFromHint(input, hint);
    if (resolvedId && !excluded.has(resolvedId)) {
      resolved.add(resolvedId);
    }
  }

  return Array.from(resolved);
}

function pickTool(input: AgentTurnInput, name: string): AgentRuntimeTool | null {
  return input.tools?.find((tool) => tool.name === name) ?? null;
}

async function runTool(
  input: AgentTurnInput,
  name: string,
  toolInput: unknown,
): Promise<Record<string, unknown> | null> {
  const tool = pickTool(input, name);
  if (!tool) {
    return null;
  }

  const output = await tool.execute(toolInput);
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }

  return { value: output };
}

function readMessage(output: Record<string, unknown> | null, fallback: string): string {
  const message = output?.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message;
  }

  return fallback;
}

async function runMockCommand(input: AgentTurnInput): Promise<string> {
  const message = input.message.trim();
  const lower = message.toLowerCase();
  const resolvedUserId = await resolveUserIdHint(input, message);
  const attendeeUserIds = await resolveMeetingAttendeeUserIds(input, message, [
    ...(resolvedUserId ? [resolvedUserId] : []),
  ]);

  if (
    lower.includes("add a task") ||
    lower.includes("create a task") ||
    lower.includes("create task") ||
    lower.includes("add task") ||
    lower.includes("remind me to") ||
    lower.includes("todo:") ||
    lower.startsWith("task:")
  ) {
    const title = extractQuotedTitle(message) ?? (message.replace(/^.*?:/, "").trim() || "New task");
    const output = await runTool(input, "create_task", {
      title,
      description: message,
      urgency: keywordIncludes(lower, ["urgent", "asap", "blocker"]) ? "CRITICAL" : "MEDIUM",
      ...(resolvedUserId ? { assigneeId: resolvedUserId } : {}),
    });
    return readMessage(output, `Created task "${title}".`);
  }

  if (
    (keywordIncludes(lower, [
      "mark",
      "move",
      "set",
      "change",
      "update",
      "complete",
      "finish",
      "reopen",
      "cancel",
    ]) &&
      keywordIncludes(lower, ["task", "todo"])) ||
    /\btask\b.*\b(done|complete|completed|in progress|open|cancelled|canceled)\b/i.test(lower)
  ) {
    const status = inferTaskStatus(message) ?? "IN_PROGRESS";
    const titleHint = extractQuotedTitle(message) ?? null;
    const output = await runTool(input, "update_task_status", {
      titleHint,
      status,
    });
    return readMessage(output, titleHint ? `Updated "${titleHint}" to ${status}.` : `Updated task to ${status}.`);
  }

  if (
    keywordIncludes(lower, [
      "show tasks",
      "list tasks",
      "task list",
      "my tasks",
      "open tasks",
      "what tasks",
    ])
  ) {
    const output = await runTool(input, "list_tasks", {
      ...(resolvedUserId ? { assigneeId: resolvedUserId } : {}),
      limit: 40,
    });

    const tasks = Array.isArray(output?.tasks) ? output.tasks : [];
    if (tasks.length === 0) {
      return "No tasks found.";
    }

    const summary = tasks
      .slice(0, 8)
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          return `${index + 1}. Task`;
        }
        const title = typeof entry.title === "string" ? entry.title : "Task";
        const status = typeof entry.status === "string" ? entry.status : "OPEN";
        return `${index + 1}. ${title} (${status.toLowerCase().replace("_", " ")})`;
      })
      .join("\n");
    const moreLine = tasks.length > 8 ? `\n...and ${tasks.length - 8} more tasks.` : "";
    return `Here are the tasks:\n${summary}${moreLine}`;
  }

  if (
    (keywordIncludes(lower, ["cancel", "delete", "remove"]) &&
      keywordIncludes(lower, ["calendar", "event", "meeting", "appointment"])) ||
    lower.includes("cancel my meeting")
  ) {
    const titleHint = inferCalendarTitle(message);
    const output = await runTool(input, "delete_calendar_event", {
      titleHint,
      ...(resolvedUserId ? { ownerUserId: resolvedUserId } : {}),
    });
    return readMessage(output, titleHint ? `Deleted calendar event "${titleHint}".` : "Deleted calendar event.");
  }

  if (
    lower.includes("reschedule") ||
    lower.includes("move the meeting") ||
    lower.includes("move event") ||
    (keywordIncludes(lower, ["update", "change"]) &&
      keywordIncludes(lower, ["calendar", "event", "meeting", "appointment"]))
  ) {
    const titleHint = inferCalendarTitle(message);
    const startAt = extractStartAtIso(message);
    const output = await runTool(input, "update_calendar_event", {
      titleHint,
      startAt,
      ...(resolvedUserId ? { ownerUserId: resolvedUserId } : {}),
    });
    return readMessage(
      output,
      titleHint ? `Updated calendar event "${titleHint}".` : "Updated calendar event.",
    );
  }

  if (
    keywordIncludes(lower, [
      "what's on my calendar",
      "whats on my calendar",
      "show my calendar",
      "my schedule",
      "calendar today",
      "calendar tomorrow",
      "availability",
      "free this",
    ]) ||
    ((lower.includes("calendar") || lower.includes("schedule")) &&
      keywordIncludes(lower, ["what", "show", "check", "see"]))
  ) {
    const range = calendarQueryRange(message);
    const output = await runTool(input, "query_calendar", {
      start: range.start,
      end: range.end,
      limit: 40,
      ...(resolvedUserId ? { ownerUserId: resolvedUserId } : {}),
    });
    return readMessage(output, "Here is your calendar.");
  }

  if (
    keywordIncludes(lower, [
      "schedule a meeting",
      "schedule meeting",
      "create event",
      "add event",
      "calendar event",
      "book meeting",
      "book a meeting",
      "set up a meeting",
      "setup a meeting",
      "new appointment",
    ])
  ) {
    const title = inferCalendarTitle(message) ?? "Meeting";
    const startAt = extractStartAtIso(message) ?? new Date().toISOString();
    const endAt = new Date(new Date(startAt).getTime() + extractDurationMinutes(message) * 60 * 1000).toISOString();
    const output = await runTool(input, "create_calendar_event", {
      title,
      startAt,
      endAt,
      description: "",
      location: "",
      allDay: false,
      ...(resolvedUserId ? { ownerUserId: resolvedUserId } : {}),
      ...(attendeeUserIds.length > 0 ? { attendeeUserIds } : {}),
    });
    return readMessage(output, `Created calendar event "${title}".`);
  }

  const sendOutput = await runTool(input, "send_message", {
    body: `Update: ${message}`,
    targetUserId: null,
    targetChannelSlug: "general",
    topic: "general",
  });

  if (sendOutput) {
    return readMessage(sendOutput, "Sent message.");
  }

  return "No action taken.";
}

async function runMockProactive(input: AgentTurnInput): Promise<string> {
  const lower = input.message.toLowerCase();
  const important = keywordIncludes(lower, ["urgent", "asap", "blocker", "today", "@"]);
  const contextOutput = await runTool(input, "read_context", {});
  const event =
    contextOutput && typeof contextOutput.event === "object" && !Array.isArray(contextOutput.event)
      ? (contextOutput.event as Record<string, unknown>)
      : null;
  const sourceSenderId =
    event && typeof event.sourceSenderId === "string" ? event.sourceSenderId : null;

  if (
    keywordIncludes(lower, ["fyi", "for your notes", "chat note", "note to self", "note to me", "heads up"])
  ) {
    const output = await runTool(input, "write_ai_chat_message", {
      body: `FYI: ${input.message}`,
    });

    if (output) {
      return readMessage(output, "Added assistant chat note.");
    }
  }

  if (important) {
    const output = await runTool(input, "create_briefing", {
      title: "Relevant update",
      summary: input.message,
      importance: "HIGH",
      recommendedAction: {
        type: "review_or_reply",
      },
    });

    if (output) {
      return readMessage(output, "Created briefing.");
    }
  }

  if (sourceSenderId && keywordIncludes(lower, ["reply", "respond"])) {
    const output = await runTool(input, "send_message", {
      body: "Thanks for the update. I saw this and will follow up shortly.",
      targetUserId: sourceSenderId,
      targetChannelSlug: null,
      topic: null,
    });

    if (output) {
      return readMessage(output, "Sent proactive reply.");
    }
  }

  const logOnly = await runTool(input, "log_only", { reason: "Low relevance signal." });
  if (logOnly) {
    return readMessage(logOnly, "Logged without action.");
  }

  return "No proactive action taken.";
}

export const mockProvider: AgentProvider = {
  name: "mock",

  async runTurn(input) {
    if (pickTool(input, "read_context") || pickTool(input, "create_briefing")) {
      return { text: await runMockProactive(input) };
    }

    if (pickTool(input, "create_task") || pickTool(input, "send_message")) {
      return { text: await runMockCommand(input) };
    }

    return { text: "No action taken." };
  },
};
