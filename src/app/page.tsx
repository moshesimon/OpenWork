"use client";

import {
  DragEvent,
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { WorkspaceUniverEditor } from "@/components/workspace-univer-editor";
import type {
  AgentCommandContextHints,
  AgentCommandResponse,
  AgentMention,
  AgentMentionKind,
  CalendarEventView,
  CalendarEventsResponse,
  BriefingItemView,
  BriefingsResponse,
  ChatMessageView,
  GlobalSearchHighlightRange,
  GlobalSearchResponse,
  GlobalSearchResult,
  TasksResponse,
  WorkspaceDocumentReadResponse,
  WorkspaceDocumentSaveResponse,
  WorkspaceFileEntry,
  WorkspaceFilesResponse,
  WorkspaceTextEditOperation,
  WorkspaceTaskView,
} from "@/types/agent";
import { applyWorkspaceTextEditOperation } from "@/lib/workspace-edit";
import type {
  BootstrapResponse,
  DmMessagePageResponse,
  MessagePageResponse,
  MessagePreview,
  MessageView,
  PostDmMessageResponse,
  PostMessageResponse,
} from "@/types/chat";

type Thread =
  | {
      kind: "channel";
      conversationId: string;
      label: string;
    }
  | {
      kind: "dm";
      otherUserId: string;
      conversationId: string | null;
      label: string;
    };

type WorkspaceView = "thread" | "tasks" | "calendar" | "docs" | "email";
type SidebarSection = "channels" | "dms" | "files";
type FileBadgeTone = "generic" | "pdf" | "word" | "excel" | "slides" | "text" | "image" | "archive";
type WorkspaceDocumentMode = "text" | "univer" | "pdf" | "preview";

type AiTimelineItem =
  | ({ kind: "chat"; mentions?: AgentMention[] } & ChatMessageView)
  | {
      kind: "briefing";
      id: string;
      body: string;
      createdAt: string;
    };

type ThreadTimelineItem =
  | {
      kind: "divider";
      id: string;
      label: string;
    }
  | {
      kind: "message";
      id: string;
      message: MessageView;
      compact: boolean;
    };

type MentionKindDefinition = {
  kind: AgentMentionKind;
  label: string;
  description: string;
};

type MentionTrigger = {
  start: number;
  end: number;
  kindToken: string;
  query: string;
  resolvedKind: AgentMentionKind | null;
};

type MentionSuggestion =
  | {
      key: string;
      type: "kind";
      kind: AgentMentionKind;
      label: string;
      description: string;
    }
  | {
      key: string;
      type: "entity";
      kind: AgentMentionKind;
      label: string;
      description: string;
      mention: AgentMention;
    };

const DEFAULT_USER_ID = "u_alex";
const USER_STORAGE_KEY = "agent-first-active-user";
const AUTO_SYNC_INTERVAL_MS = 15_000;
const COMPACT_MESSAGE_WINDOW_MS = 5 * 60 * 1000;
const MAX_MENTION_SUGGESTIONS = 12;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const COMMON_CALENDAR_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Jerusalem",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];
const MENTION_KINDS: MentionKindDefinition[] = [
  { kind: "event", label: "@event", description: "Calendar events" },
  { kind: "task", label: "@task", description: "Workspace tasks" },
  { kind: "dm", label: "@dm", description: "Direct messages" },
  { kind: "channel", label: "@channel", description: "Channels" },
  { kind: "file", label: "@file", description: "Company files" },
];

type EmailFolder = "inbox" | "sent" | "drafts" | "spam";
type FakeEmail = {
  id: string;
  from: string;
  fromEmail: string;
  to: string;
  subject: string;
  preview: string;
  body: string;
  date: string;
  read: boolean;
  starred: boolean;
  folder: EmailFolder;
};

const FAKE_EMAILS: FakeEmail[] = [
  {
    id: "e1",
    from: "Sarah Chen",
    fromEmail: "sarah.chen@acme.co",
    to: "me@acme.co",
    subject: "Q3 Product Roadmap — final review",
    preview: "Hi team, I've updated the roadmap doc with the feedback from last week's all-hands.",
    body: "Hi team,\n\nI've updated the roadmap doc with the feedback from last week's all-hands. The key changes are:\n\n• Moved the analytics dashboard to Q4\n• Added two new API integrations in August\n• Pushed the mobile redesign to next quarter\n\nPlease review and leave comments before EOD Friday.\n\nThanks,\nSarah",
    date: "2026-02-18T09:14:00Z",
    read: false,
    starred: true,
    folder: "inbox",
  },
  {
    id: "e2",
    from: "James O'Brien",
    fromEmail: "james@acme.co",
    to: "me@acme.co",
    subject: "Re: Design system token updates",
    preview: "Looks great! One small thing — the spacing tokens don't match the Figma file exactly.",
    body: "Looks great! One small thing — the spacing tokens don't match the Figma file exactly.\n\nSpecifically, space-4 should be 16px not 14px. Could you double-check with Maya?\n\nOtherwise this is solid work. Let's ship it.\n\n— James",
    date: "2026-02-18T08:52:00Z",
    read: false,
    starred: false,
    folder: "inbox",
  },
  {
    id: "e3",
    from: "GitHub",
    fromEmail: "noreply@github.com",
    to: "me@acme.co",
    subject: "[openwork/app] PR #214 merged: Add agent streaming support",
    preview: "Pull request #214 was merged by @moshesimon into main.",
    body: "Pull request #214 was merged by @moshesimon into main.\n\nAdd agent streaming support\n\nThis PR adds real-time streaming to the AI agent responses using the Vercel AI SDK.\n\n• 23 files changed, +1,482 −340\n\nView the pull request on GitHub.",
    date: "2026-02-17T22:31:00Z",
    read: true,
    starred: false,
    folder: "inbox",
  },
  {
    id: "e4",
    from: "Lena Müller",
    fromEmail: "lena.muller@acme.co",
    to: "me@acme.co",
    subject: "Meeting tomorrow: Sprint retrospective",
    preview: "Just a reminder that we have the sprint retro tomorrow at 10am PST. Agenda attached.",
    body: "Just a reminder that we have the sprint retro tomorrow at 10am PST.\n\nAgenda:\n1. What went well (10 min)\n2. What could be improved (15 min)\n3. Action items (10 min)\n\nZoom link: https://zoom.us/j/example\n\nSee you then!\nLena",
    date: "2026-02-17T16:05:00Z",
    read: false,
    starred: true,
    folder: "inbox",
  },
  {
    id: "e5",
    from: "Stripe",
    fromEmail: "receipts@stripe.com",
    to: "me@acme.co",
    subject: "Your receipt from Stripe — $249.00",
    preview: "You were charged $249.00 on February 17, 2026 for OpenWork Pro.",
    body: "Receipt from Stripe\n\nDate: February 17, 2026\nDescription: OpenWork Pro — Monthly\nAmount: $249.00\n\nThank you for your business.",
    date: "2026-02-17T13:44:00Z",
    read: true,
    starred: false,
    folder: "inbox",
  },
  {
    id: "e6",
    from: "Tom Harris",
    fromEmail: "tom.harris@acme.co",
    to: "me@acme.co",
    subject: "Weekly engineering digest",
    preview: "Here's a summary of what the engineering team shipped this week.",
    body: "Weekly Engineering Digest — Week of Feb 10\n\nShipped this week:\n• Agent orchestration v2\n• Calendar sync improvements\n• Global search (beta)\n• Bug fixes: 14 closed\n\nIn progress:\n• Email integration\n• Mobile app v1.2\n\nBlockers:\n• Waiting on design for onboarding flow\n\nHave a great weekend!\nTom",
    date: "2026-02-14T17:30:00Z",
    read: true,
    starred: false,
    folder: "inbox",
  },
  {
    id: "e7",
    from: "Figma",
    fromEmail: "no-reply@figma.com",
    to: "me@acme.co",
    subject: "Maya shared 'OpenWork Design System v3' with you",
    preview: "Maya Rivera invited you to view a file in Figma.",
    body: "Maya Rivera invited you to view a file in Figma.\n\nFile: OpenWork Design System v3\n\nClick the button below to open the file in Figma.",
    date: "2026-02-13T11:20:00Z",
    read: true,
    starred: false,
    folder: "inbox",
  },
  {
    id: "e8",
    from: "HR Team",
    fromEmail: "hr@acme.co",
    to: "me@acme.co",
    subject: "Action required: Complete your 2026 benefits enrollment",
    preview: "Benefits enrollment closes on March 1st. Please complete your selections.",
    body: "Hi,\n\nThis is a reminder to complete your 2026 benefits enrollment. The window closes on March 1st, 2026.\n\nTo enroll:\n1. Log into the HR portal\n2. Navigate to Benefits > 2026 Enrollment\n3. Make your selections and confirm\n\nIf you have questions, contact hr@acme.co.\n\nBest,\nHR Team",
    date: "2026-02-12T09:00:00Z",
    read: false,
    starred: false,
    folder: "inbox",
  },
  {
    id: "e9",
    from: "me",
    fromEmail: "me@acme.co",
    to: "sarah.chen@acme.co",
    subject: "Re: Q3 Product Roadmap — final review",
    preview: "Thanks Sarah, I'll leave my comments by end of day Thursday.",
    body: "Thanks Sarah, I'll leave my comments by end of day Thursday.\n\nQuick note: I think we should reconsider the API integrations timeline — the third-party dependency might not be ready by August.\n\nI'll add a comment in the doc.\n\n— Me",
    date: "2026-02-18T09:45:00Z",
    read: true,
    starred: false,
    folder: "sent",
  },
  {
    id: "e10",
    from: "me",
    fromEmail: "me@acme.co",
    to: "engineering@acme.co",
    subject: "RFC: Unified search architecture",
    preview: "I've drafted an RFC for the new unified search system. Would love feedback.",
    body: "Hi all,\n\nI've put together an RFC for the new unified search architecture. It covers:\n\n1. Indexing strategy (chat, files, calendar, email)\n2. Query language\n3. Vector similarity search for semantic queries\n4. Relevance scoring\n\nDraft is in Notion. Please leave comments by next Wednesday.\n\nThanks!",
    date: "2026-02-15T14:20:00Z",
    read: true,
    starred: true,
    folder: "sent",
  },
  {
    id: "e11",
    from: "me",
    fromEmail: "me@acme.co",
    to: "lena.muller@acme.co",
    subject: "Quick question about sprint retro format",
    preview: "Hey Lena, are we doing the usual Start/Stop/Continue format or something different?",
    body: "Hey Lena,\n\nAre we doing the usual Start/Stop/Continue format for the retro, or are you trying something different this time?\n\nAlso — do you want me to facilitate the action items section?\n\nThanks!",
    date: "2026-02-17T10:12:00Z",
    read: true,
    starred: false,
    folder: "sent",
  },
  {
    id: "e12",
    from: "me",
    fromEmail: "me@acme.co",
    to: "investors@acme.co",
    subject: "[DRAFT] February investor update",
    preview: "MRR grew 18% MoM. DAU up 34%. Key hires: 2 engineers, 1 designer.",
    body: "[DRAFT — DO NOT SEND]\n\nHi investors,\n\nHere's the February update:\n\n📈 Metrics:\n• MRR: $84K (+18% MoM)\n• DAU: 2,300 (+34% MoM)\n• Churn: 1.2%\n\n🏆 Highlights:\n• Launched AI agent v2\n• Added email integration (beta)\n• Key hires: 2 engineers, 1 designer\n\n🔭 Next month:\n• Mobile app launch\n• Enterprise tier\n\nBest,",
    date: "2026-02-18T07:30:00Z",
    read: true,
    starred: true,
    folder: "drafts",
  },
  {
    id: "e13",
    from: "me",
    fromEmail: "me@acme.co",
    to: "press@techcrunch.com",
    subject: "[DRAFT] OpenWork funding announcement pitch",
    preview: "We'd love to share our story with TechCrunch. OpenWork is an AI-first work platform…",
    body: "[DRAFT]\n\nHi,\n\nI'm reaching out because we're announcing our Series A and would love TechCrunch's coverage.\n\nOpenWork is an AI-first work platform that helps teams move faster by putting AI at the center of every workflow — from messaging to tasks to files.\n\nWe've grown from 0 to 2,300 DAU in 6 months, all word-of-mouth. Would love to chat.\n\nBest,",
    date: "2026-02-16T16:00:00Z",
    read: true,
    starred: false,
    folder: "drafts",
  },
  {
    id: "e14",
    from: "LinkedIn",
    fromEmail: "messages-noreply@linkedin.com",
    to: "me@acme.co",
    subject: "You have 5 new connection requests",
    preview: "Alex Turner, Priya Nair, and 3 others want to connect with you on LinkedIn.",
    body: "You have 5 new connection requests on LinkedIn.\n\nRespond to stay connected with your professional network.",
    date: "2026-02-17T08:00:00Z",
    read: true,
    starred: false,
    folder: "spam",
  },
  {
    id: "e15",
    from: "Sales Outreach",
    fromEmail: "outreach@salestools.io",
    to: "me@acme.co",
    subject: "10x your pipeline with AI SDRs",
    preview: "Hi there, I noticed you're building a productivity platform. Our AI SDR tool…",
    body: "Hi there,\n\nI noticed you're building a productivity platform. Our AI SDR tool can help you 10x your outbound pipeline in 30 days.\n\nWould you be open to a quick 15-minute call?\n\nBest,\nSales Bot",
    date: "2026-02-16T09:15:00Z",
    read: false,
    starred: false,
    folder: "spam",
  },
];

const TASK_COLUMNS: Array<{
  status: WorkspaceTaskView["status"];
  label: string;
  subtitle: string;
}> = [
  { status: "OPEN", label: "My Tasks", subtitle: "Incoming" },
  { status: "IN_PROGRESS", label: "In Progress", subtitle: "Doing now" },
  { status: "DONE", label: "Done", subtitle: "Completed" },
  { status: "CANCELLED", label: "Cancelled", subtitle: "Dropped" },
];

function statusToLabel(status: WorkspaceTaskView["status"]): string {
  return status.replace("_", " ").toLowerCase();
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function startOfCalendarGrid(value: Date): Date {
  const firstOfMonth = startOfMonth(value);
  return addDays(firstOfMonth, -firstOfMonth.getDay());
}

function toDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromDateKey(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const parsed = new Date(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10) - 1,
    Number.parseInt(match[3], 10),
  );

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function buildCalendarGridDays(visibleMonth: Date): Date[] {
  const start = startOfCalendarGrid(visibleMonth);
  return Array.from({ length: 42 }, (_, offset) => addDays(start, offset));
}

function resolveLocalTimeZone(): string {
  try {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timeZone === "string" && timeZone.trim()) {
      return timeZone;
    }
  } catch {
    // Fall back to UTC when the runtime cannot resolve a local time zone.
  }

  return "UTC";
}

function eventOccursOnDate(event: CalendarEventView, date: Date): boolean {
  const eventStart = new Date(event.startAt);
  const eventEnd = new Date(event.endAt);
  const dayStart = startOfDay(date);
  const dayEnd = addDays(dayStart, 1);

  return eventStart < dayEnd && eventEnd > dayStart;
}

function formatCalendarTimeRange(event: CalendarEventView, timeZone: string): string {
  if (event.allDay) {
    return "All day";
  }

  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });

  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Request failed.";
}

async function apiRequest<T>(path: string, userId: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.headers ?? {}),
      "x-user-id": userId,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string"
        ? payload.message
        : `Request failed (${response.status}).`,
    );
  }

  return payload as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMessageDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function toMessageDayKey(value: string): string {
  const parsed = new Date(value);
  return `${parsed.getFullYear()}-${parsed.getMonth()}-${parsed.getDate()}`;
}

function initialsFromName(value: string): string {
  const parts = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "?";
  }

  return parts
    .map((segment) => segment[0]?.toUpperCase() ?? "")
    .join("");
}

function summarizePreview(preview: MessagePreview | null): string {
  if (!preview) {
    return "No messages yet";
  }

  return `${preview.senderDisplayName}: ${preview.body}`;
}

function parseMentionTrigger(input: string, cursorIndex: number): MentionTrigger | null {
  const cursor = Math.max(0, Math.min(cursorIndex, input.length));
  const prefix = input.slice(0, cursor);
  const match = prefix.match(/(^|\s)@([a-z]*)(?:\s+([^\n@]*))?$/i);
  if (!match) {
    return null;
  }

  const leading = match[1] ?? "";
  const kindToken = (match[2] ?? "").trim().toLowerCase();
  const query = (match[3] ?? "").trim().toLowerCase();
  const start = cursor - match[0].length + leading.length;
  const resolvedKind =
    MENTION_KINDS.find((entry) => entry.kind === kindToken)?.kind ?? null;

  return {
    start,
    end: cursor,
    kindToken,
    query,
    resolvedKind,
  };
}

function mentionKey(mention: AgentMention): string {
  if (mention.kind === "event") {
    return `event:${mention.eventId}`;
  }

  if (mention.kind === "task") {
    return `task:${mention.taskId}`;
  }

  if (mention.kind === "dm") {
    return `dm:${mention.userId}`;
  }

  if (mention.kind === "channel") {
    return `channel:${mention.channelId}`;
  }

  return `file:${mention.path}`;
}

function mentionLabel(mention: AgentMention): string {
  if (mention.kind === "event") {
    return mention.title;
  }

  if (mention.kind === "task") {
    return mention.title;
  }

  if (mention.kind === "dm") {
    return mention.displayName;
  }

  if (mention.kind === "channel") {
    return `#${mention.channelName}`;
  }

  return mention.path;
}


function mentionKindLabel(kind: AgentMentionKind): string {
  return MENTION_KINDS.find((entry) => entry.kind === kind)?.label ?? `@${kind}`;
}

function searchKindLabel(kind: GlobalSearchResult["kind"]): string {
  if (kind === "message") {
    return "Message";
  }

  if (kind === "file") {
    return "File";
  }

  if (kind === "task") {
    return "Task";
  }

  if (kind === "event") {
    return "Event";
  }

  if (kind === "channel") {
    return "Channel";
  }

  if (kind === "dm") {
    return "DM";
  }

  return "User";
}

function renderHighlightedText(
  text: string,
  ranges: GlobalSearchHighlightRange[] | undefined,
): ReactNode {
  if (!ranges || ranges.length === 0) {
    return text;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      nodes.push(text.slice(cursor, range.start));
    }
    if (range.end > range.start) {
      nodes.push(
        <mark key={range.start} className="ow-search-highlight">
          {text.slice(range.start, range.end)}
        </mark>,
      );
    }
    cursor = range.end;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function buildMentionContextHints(mentions: AgentMention[]): AgentCommandContextHints | undefined {
  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  const conversationIds = new Set<string>();
  const taskIds = new Set<string>();
  const eventIds = new Set<string>();
  const filePaths = new Set<string>();

  for (const mention of mentions) {
    if (mention.kind === "event") {
      eventIds.add(mention.eventId);
      userIds.add(mention.ownerId);
      for (const attendee of mention.attendeeUserIds) {
        userIds.add(attendee);
      }
      continue;
    }

    if (mention.kind === "task") {
      taskIds.add(mention.taskId);
      userIds.add(mention.createdById);
      if (mention.assigneeId) {
        userIds.add(mention.assigneeId);
      }
      continue;
    }

    if (mention.kind === "dm") {
      userIds.add(mention.userId);
      if (mention.conversationId) {
        conversationIds.add(mention.conversationId);
      }
      continue;
    }

    if (mention.kind === "channel") {
      channelIds.add(mention.channelId);
      conversationIds.add(mention.conversationId);
      continue;
    }

    filePaths.add(mention.path);
  }

  const hints: AgentCommandContextHints = {};
  if (userIds.size > 0) {
    hints.userIds = Array.from(userIds);
  }
  if (channelIds.size > 0) {
    hints.channelIds = Array.from(channelIds);
  }
  if (conversationIds.size > 0) {
    hints.conversationIds = Array.from(conversationIds);
  }
  if (taskIds.size > 0) {
    hints.taskIds = Array.from(taskIds);
  }
  if (eventIds.size > 0) {
    hints.eventIds = Array.from(eventIds);
  }
  if (filePaths.size > 0) {
    hints.filePaths = Array.from(filePaths);
  }

  return Object.keys(hints).length > 0 ? hints : undefined;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SseMessage = {
  event: string;
  data: string;
};

async function readSseStream(
  response: Response,
  onMessage: (message: SseMessage) => void | Promise<void>,
): Promise<void> {
  const body = response.body;
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        if (!block.startsWith(":")) {
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim() || "message";
              continue;
            }

            if (line.startsWith("data:")) {
              data += `${line.slice(5).trim()}\n`;
            }
          }

          await onMessage({
            event,
            data: data.trim(),
          });
        }

        separatorIndex = buffer.indexOf("\n\n");
      }
    }

    if (done) {
      break;
    }
  }
}

function fileBadgeFromName(name: string): { label: string; tone: FileBadgeTone } {
  const extension = name.split(".").pop()?.trim().toLowerCase();
  if (!extension) {
    return { label: "FILE", tone: "generic" };
  }

  if (extension === "pdf") {
    return { label: "PDF", tone: "pdf" };
  }

  if (["doc", "docx", "rtf", "odt"].includes(extension)) {
    return { label: "DOC", tone: "word" };
  }

  if (["xls", "xlsx", "csv", "tsv", "ods"].includes(extension)) {
    return { label: "XLS", tone: "excel" };
  }

  if (["ppt", "pptx", "key"].includes(extension)) {
    return { label: "PPT", tone: "slides" };
  }

  if (["txt", "md", "pages"].includes(extension)) {
    return { label: "TXT", tone: "text" };
  }

  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) {
    return { label: "IMG", tone: "image" };
  }

  if (["zip", "rar", "7z", "gz", "tar", "tgz"].includes(extension)) {
    return { label: "ZIP", tone: "archive" };
  }

  return {
    label: extension.length <= 4 ? extension.toUpperCase() : "FILE",
    tone: "generic",
  };
}

function normalizeDocumentExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function resolveWorkspaceDocumentMode(document: WorkspaceDocumentReadResponse): WorkspaceDocumentMode {
  if (document.editable) {
    return "text";
  }

  const extension = normalizeDocumentExtension(document.extension);
  if (extension === ".pdf") {
    return "pdf";
  }

  if (
    extension === ".xlsx" ||
    extension === ".xls" ||
    extension === ".xlsm" ||
    extension === ".docx" ||
    extension === ".doc" ||
    extension === ".ppt" ||
    extension === ".pptx" ||
    extension === ".pps" ||
    extension === ".ppsx"
  ) {
    return "univer";
  }

  return "preview";
}

function buildWorkspaceFileRawUrl(relativePath: string, userId: string): string {
  const params = new URLSearchParams({
    path: relativePath,
    userId,
  });
  return `/api/workspace/file/raw?${params.toString()}`;
}

function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`ow-side-caret-icon ${expanded ? "is-expanded" : ""}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export default function Home() {
  const [activeUserId, setActiveUserId] = useState(DEFAULT_USER_ID);
  const [activeView, setActiveView] = useState<WorkspaceView>("thread");
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [briefings, setBriefings] = useState<BriefingItemView[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessageView[]>([]);
  const [messageMentions, setMessageMentions] = useState<Map<string, AgentMention[]>>(new Map());

  const [commandInput, setCommandInput] = useState("");
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandMentions, setCommandMentions] = useState<AgentMention[]>([]);
  const [mentionNavIndex, setMentionNavIndex] = useState(0);
  const [commandRunning, setCommandRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [globalSearchInput, setGlobalSearchInput] = useState("");
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult[]>([]);
  const [globalSearchProviders, setGlobalSearchProviders] = useState<{ chat: string; files: string }>({
    chat: "native",
    files: "native",
  });
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null);

  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [manualMessages, setManualMessages] = useState<MessageView[]>([]);
  const [manualBody, setManualBody] = useState("");
  const [loadingManual, setLoadingManual] = useState(false);

  const [tasks, setTasks] = useState<WorkspaceTaskView[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEventView[]>([]);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskFilterUrgency, setTaskFilterUrgency] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskUrgency, setNewTaskUrgency] = useState<WorkspaceTaskView["urgency"]>("MEDIUM");
  const [creatingTask, setCreatingTask] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string>(() =>
    toDateKey(new Date()),
  );
  const [calendarTimeZone, setCalendarTimeZone] = useState<string>(() => resolveLocalTimeZone());
  const [workspaceRootLabel, setWorkspaceRootLabel] = useState("workspace");
  const [workspaceFilesByDirectory, setWorkspaceFilesByDirectory] = useState<
    Record<string, WorkspaceFileEntry[]>
  >({});
  const [workspaceDirectoryLoading, setWorkspaceDirectoryLoading] = useState<
    Record<string, boolean>
  >({});
  const [workspaceMentionFiles, setWorkspaceMentionFiles] = useState<WorkspaceFileEntry[] | null>(
    null,
  );
  const [workspaceMentionFilesLoading, setWorkspaceMentionFilesLoading] = useState(false);
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null);
  const [workspaceFileSelection, setWorkspaceFileSelection] = useState<string | null>(null);
  const [workspaceSelectedFilePath, setWorkspaceSelectedFilePath] = useState<string | null>(null);
  const [workspaceDocument, setWorkspaceDocument] = useState<WorkspaceDocumentReadResponse | null>(
    null,
  );
  const [workspaceDocumentContent, setWorkspaceDocumentContent] = useState("");
  const [workspaceDocumentLoading, setWorkspaceDocumentLoading] = useState(false);
  const [workspaceDocumentSaving, setWorkspaceDocumentSaving] = useState(false);
  const [workspaceDocumentError, setWorkspaceDocumentError] = useState<string | null>(null);
  const [workspaceAiInstruction, setWorkspaceAiInstruction] = useState("");
  const [workspaceAiApplying, setWorkspaceAiApplying] = useState(false);
  const [workspaceAiStatus, setWorkspaceAiStatus] = useState<string | null>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => new Set([""]),
  );
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [emailFolder, setEmailFolder] = useState<EmailFolder>("inbox");
  const [emailSearchInput, setEmailSearchInput] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const [openSidebarSections, setOpenSidebarSections] = useState<Set<SidebarSection>>(
    () => new Set(["channels", "files"]),
  );
  const loadedDirectoriesRef = useRef<Set<string>>(new Set());
  const refreshEpochRef = useRef(0);
  const selectedThreadRef = useRef<Thread | null>(null);
  const activeViewRef = useRef<WorkspaceView>("thread");
  const calendarMonthRef = useRef<Date>(new Date());

  // Keep refs in sync with state so refreshAll doesn't need them as deps
  selectedThreadRef.current = selectedThread;
  activeViewRef.current = activeView;
  calendarMonthRef.current = calendarMonth;
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLTextAreaElement>(null);
  const workspaceDocumentContentRef = useRef("");
  const globalSearchRequestRef = useRef(0);

  const activeUser = useMemo(() => {
    if (!bootstrap) {
      return null;
    }

    return bootstrap.users.find((user) => user.id === activeUserId) ?? bootstrap.activeUser;
  }, [bootstrap, activeUserId]);
  const localTimeZone = useMemo(() => resolveLocalTimeZone(), []);
  const calendarTimeZoneOptions = useMemo(
    () =>
      Array.from(new Set([localTimeZone, ...COMMON_CALENDAR_TIMEZONES])).map((value) => ({
        value,
        label: value === localTimeZone ? `${value} (Local)` : value,
      })),
    [localTimeZone],
  );

  const loadBootstrap = useCallback(async (userId: string) => {
    const payload = await apiRequest<BootstrapResponse>("/api/bootstrap", userId);
    setBootstrap(payload);
  }, []);

  const loadBriefings = useCallback(async (userId: string) => {
    const payload = await apiRequest<BriefingsResponse>(
      "/api/briefings?status=UNREAD&limit=20",
      userId,
    );
    setBriefings(payload.items);
  }, []);

  const loadChat = useCallback(async (userId: string) => {
    const payload = await apiRequest<{ messages: ChatMessageView[] }>(
      "/api/agent/chat?limit=100",
      userId,
    );
    setChatMessages(payload.messages);
  }, []);

  const clearChat = useCallback(async () => {
    setChatMessages([]);
    setMessageMentions(new Map());
    setBriefings([]);
    await apiRequest<{ ok: boolean }>("/api/agent/chat", activeUserId, { method: "DELETE" });
  }, [activeUserId]);

  const resetGlobalSearch = useCallback(() => {
    globalSearchRequestRef.current += 1;
    setGlobalSearchQuery("");
    setGlobalSearchResults([]);
    setGlobalSearchProviders({
      chat: "native",
      files: "native",
    });
    setGlobalSearchError(null);
    setGlobalSearchLoading(false);
  }, []);

  const clearGlobalSearch = useCallback(() => {
    setGlobalSearchInput("");
    resetGlobalSearch();
  }, [resetGlobalSearch]);

  const submitGlobalSearch = useCallback(
    async (query: string) => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        resetGlobalSearch();
        return;
      }

      const requestId = ++globalSearchRequestRef.current;
      setGlobalSearchLoading(true);
      setGlobalSearchError(null);
      try {
        const params = new URLSearchParams({
          q: normalizedQuery,
          limit: "60",
        });
        const payload = await apiRequest<GlobalSearchResponse>(
          `/api/search/global?${params.toString()}`,
          activeUserId,
        );

        if (requestId !== globalSearchRequestRef.current) {
          return;
        }

        setGlobalSearchQuery(payload.query);
        setGlobalSearchResults(payload.results);
        setGlobalSearchProviders(payload.providers);
      } catch (searchError) {
        if (requestId !== globalSearchRequestRef.current) {
          return;
        }

        setGlobalSearchQuery(normalizedQuery);
        setGlobalSearchResults([]);
        setGlobalSearchProviders({
          chat: "native",
          files: "native",
        });
        setGlobalSearchError(toErrorMessage(searchError));
      } finally {
        if (requestId === globalSearchRequestRef.current) {
          setGlobalSearchLoading(false);
        }
      }
    },
    [activeUserId, resetGlobalSearch],
  );

  const debouncedSidebarSearch = useCallback(
    (query: string) => {
      if (typeof window === "undefined") {
        return () => undefined;
      }

      const timeoutId = window.setTimeout(() => {
        void submitGlobalSearch(query);
      }, 120);

      return () => {
        window.clearTimeout(timeoutId);
      };
    },
    [submitGlobalSearch],
  );

  useEffect(() => {
    const query = globalSearchInput.trim();
    if (!query) {
      resetGlobalSearch();
      return;
    }

    return debouncedSidebarSearch(query);
  }, [debouncedSidebarSearch, globalSearchInput, resetGlobalSearch]);

  const loadTasks = useCallback(
    async (userId: string) => {
      const payload = await apiRequest<TasksResponse>("/api/tasks", userId);
      setTasks(payload.items);
    },
    [],
  );

  const loadCalendar = useCallback(
    async (
      userId: string,
      visibleMonth = calendarMonth,
      options?: {
        silent?: boolean;
      },
    ) => {
      const gridStart = startOfCalendarGrid(visibleMonth);
      const gridEnd = addDays(gridStart, 42);
      const params = new URLSearchParams({
        start: gridStart.toISOString(),
        end: gridEnd.toISOString(),
        limit: "300",
      });
      const showLoadingState = !options?.silent;

      if (showLoadingState) {
        setLoadingCalendar(true);
      }
      try {
        const payload = await apiRequest<CalendarEventsResponse>(
          `/api/calendar/events?${params.toString()}`,
          userId,
        );
        setCalendarEvents(payload.items);
      } finally {
        if (showLoadingState) {
          setLoadingCalendar(false);
        }
      }
    },
    [calendarMonth],
  );

  const loadWorkspaceDirectory = useCallback(
    async (
      directory: string,
      options?: {
        force?: boolean;
        userId?: string;
      },
    ) => {
      if (loadedDirectoriesRef.current.has(directory) && !options?.force) {
        return;
      }

      setWorkspaceDirectoryLoading((previous) => ({
        ...previous,
        [directory]: true,
      }));
      setWorkspaceFilesError(null);

      try {
        const params = new URLSearchParams();
        if (directory) {
          params.set("path", directory);
        }

        const payload = await apiRequest<WorkspaceFilesResponse>(
          `/api/workspace/files${params.size > 0 ? `?${params.toString()}` : ""}`,
          options?.userId ?? activeUserId,
        );

        setWorkspaceRootLabel(payload.rootLabel);
        setWorkspaceFilesByDirectory((previous) => ({
          ...previous,
          [payload.directory]: payload.items,
        }));
        loadedDirectoriesRef.current.add(payload.directory);
      } catch (directoryError) {
        setWorkspaceFilesError(toErrorMessage(directoryError));
      } finally {
        setWorkspaceDirectoryLoading((previous) => {
          const next = { ...previous };
          delete next[directory];
          return next;
        });
      }
    },
    [activeUserId],
  );

  const indexWorkspaceFilesForMentions = useCallback(
    async (userId = activeUserId) => {
      if (workspaceMentionFilesLoading || workspaceMentionFiles !== null) {
        return;
      }

      setWorkspaceMentionFilesLoading(true);

      try {
        const queue: string[] = [""];
        const visited = new Set<string>();
        const files: WorkspaceFileEntry[] = [];

        while (queue.length > 0) {
          const directory = queue.shift();
          if (directory === undefined || visited.has(directory)) {
            continue;
          }

          visited.add(directory);
          if (visited.size > 250) {
            break;
          }

          const params = new URLSearchParams();
          if (directory) {
            params.set("path", directory);
          }

          const payload = await apiRequest<WorkspaceFilesResponse>(
            `/api/workspace/files${params.size > 0 ? `?${params.toString()}` : ""}`,
            userId,
          );

          for (const item of payload.items) {
            if (item.kind === "directory") {
              queue.push(item.path);
              continue;
            }

            files.push(item);
            if (files.length >= 2_000) {
              break;
            }
          }

          if (files.length >= 2_000) {
            break;
          }
        }

        files.sort((left, right) =>
          left.path.localeCompare(right.path, undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        );
        setWorkspaceMentionFiles(files);
      } catch {
        setWorkspaceMentionFiles([]);
      } finally {
        setWorkspaceMentionFilesLoading(false);
      }
    },
    [activeUserId, workspaceMentionFiles, workspaceMentionFilesLoading],
  );

  const loadWorkspaceDocument = useCallback(
    async (
      filePath: string,
      options?: {
        userId?: string;
      },
    ) => {
      setWorkspaceDocumentLoading(true);
      setWorkspaceDocumentError(null);
      setWorkspaceAiStatus(null);

      try {
        const params = new URLSearchParams({ path: filePath });
        const payload = await apiRequest<WorkspaceDocumentReadResponse>(
          `/api/workspace/file?${params.toString()}`,
          options?.userId ?? activeUserId,
        );

        setWorkspaceDocument(payload);
        const content = payload.content ?? "";
        setWorkspaceDocumentContent(content);
        workspaceDocumentContentRef.current = content;
      } catch (documentError) {
        setWorkspaceDocument(null);
        setWorkspaceDocumentContent("");
        workspaceDocumentContentRef.current = "";
        setWorkspaceDocumentError(toErrorMessage(documentError));
      } finally {
        setWorkspaceDocumentLoading(false);
      }
    },
    [activeUserId],
  );

  const saveWorkspaceDocument = useCallback(async () => {
    if (!workspaceDocument || !workspaceDocument.editable || workspaceDocumentSaving) {
      return;
    }

    setWorkspaceDocumentSaving(true);
    setWorkspaceDocumentError(null);
    setWorkspaceAiStatus(null);

    try {
      const payload = await apiRequest<WorkspaceDocumentSaveResponse>(
        "/api/workspace/file",
        activeUserId,
        {
          method: "PUT",
          body: JSON.stringify({
            path: workspaceDocument.path,
            content: workspaceDocumentContent,
            baseVersion: workspaceDocument.version,
          }),
        },
      );

      setWorkspaceDocument((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          content: workspaceDocumentContent,
          sizeBytes: payload.sizeBytes,
          updatedAt: payload.updatedAt,
          version: payload.version,
        };
      });
      setWorkspaceAiStatus("Saved document.");
    } catch (saveError) {
      setWorkspaceDocumentError(toErrorMessage(saveError));
    } finally {
      setWorkspaceDocumentSaving(false);
    }
  }, [activeUserId, workspaceDocument, workspaceDocumentContent, workspaceDocumentSaving]);

  const handleUniverDocumentSaved = useCallback((payload: WorkspaceDocumentSaveResponse) => {
    setWorkspaceDocument((previous) => {
      if (!previous) {
        return previous;
      }

      return {
        ...previous,
        sizeBytes: payload.sizeBytes,
        updatedAt: payload.updatedAt,
        version: payload.version,
      };
    });
    setWorkspaceAiStatus("Saved document.");
  }, []);

  const applyAiWorkspaceEdits = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!workspaceDocument || !workspaceDocument.editable || workspaceAiApplying) {
        return;
      }

      const instruction = workspaceAiInstruction.trim();
      if (!instruction) {
        return;
      }

      setWorkspaceAiApplying(true);
      setWorkspaceDocumentError(null);
      setWorkspaceAiStatus("Running AI edit...");

      try {
        const response = await fetch("/api/workspace/file/ai-edits", {
          method: "POST",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-user-id": activeUserId,
          },
          body: JSON.stringify({
            path: workspaceDocument.path,
            instruction,
            content: workspaceDocumentContentRef.current,
            baseVersion: workspaceDocument.version,
            autoSave: true,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(payload?.message ?? `AI edit request failed (${response.status}).`);
        }

        await readSseStream(response, async (message) => {
          if (!message.data) {
            return;
          }

          const payload = JSON.parse(message.data) as Record<string, unknown>;

          if (message.event === "operation") {
            const operation = payload.operation as WorkspaceTextEditOperation;
            setWorkspaceDocumentContent((previous) => {
              const next = applyWorkspaceTextEditOperation(previous, operation);
              workspaceDocumentContentRef.current = next;
              return next;
            });

            const index =
              typeof payload.index === "number" && Number.isFinite(payload.index)
                ? Math.trunc(payload.index)
                : 0;
            const total =
              typeof payload.total === "number" && Number.isFinite(payload.total)
                ? Math.trunc(payload.total)
                : 1;
            setWorkspaceAiStatus(`Applying edit ${index + 1}/${Math.max(total, 1)}...`);
            return;
          }

          if (message.event === "saved") {
            const version = typeof payload.version === "string" ? payload.version : workspaceDocument.version;
            const updatedAt =
              typeof payload.updatedAt === "string" ? payload.updatedAt : workspaceDocument.updatedAt;
            const sizeBytes =
              typeof payload.sizeBytes === "number" && Number.isFinite(payload.sizeBytes)
                ? payload.sizeBytes
                : workspaceDocument.sizeBytes;

            setWorkspaceDocument((previous) => {
              if (!previous) {
                return previous;
              }

              return {
                ...previous,
                content: workspaceDocumentContentRef.current,
                version,
                updatedAt,
                sizeBytes,
              };
            });
            setWorkspaceAiStatus("Saved AI edits.");
            return;
          }

          if (message.event === "done") {
            const summary =
              typeof payload.summary === "string" && payload.summary.trim().length > 0
                ? payload.summary
                : "AI edit finished.";
            setWorkspaceDocument((previous) =>
              previous
                ? {
                    ...previous,
                    content: workspaceDocumentContentRef.current,
                  }
                : previous,
            );
            setWorkspaceAiStatus(summary);
            setWorkspaceAiInstruction("");
            return;
          }

          if (message.event === "error") {
            const messageText =
              typeof payload.message === "string" && payload.message.trim().length > 0
                ? payload.message
                : "AI edit failed.";
            throw new Error(messageText);
          }
        });
      } catch (aiEditError) {
        setWorkspaceDocumentError(toErrorMessage(aiEditError));
        setWorkspaceAiStatus(null);
      } finally {
        setWorkspaceAiApplying(false);
      }
    },
    [activeUserId, workspaceAiApplying, workspaceAiInstruction, workspaceDocument],
  );

  const loadThreadMessages = useCallback(async (thread: Thread, userId: string) => {
    if (thread.kind === "channel") {
      const payload = await apiRequest<MessagePageResponse>(
        `/api/conversations/${encodeURIComponent(thread.conversationId)}/messages?limit=50`,
        userId,
      );
      setManualMessages(payload.messages);
      await apiRequest(
        `/api/conversations/${encodeURIComponent(payload.conversationId)}/read`,
        userId,
        { method: "POST" },
      );

      setBootstrap((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          channels: previous.channels.map((channel) =>
            channel.conversationId === thread.conversationId
              ? {
                  ...channel,
                  unreadCount: 0,
                }
              : channel,
          ),
        };
      });
      return;
    }

    const payload = await apiRequest<DmMessagePageResponse>(
      `/api/dms/${encodeURIComponent(thread.otherUserId)}/messages?limit=50`,
      userId,
    );

    const resolvedThread: Thread = {
      ...thread,
      conversationId: payload.conversationId,
    };

    setSelectedThread(resolvedThread);
    setManualMessages(payload.messages);
    await apiRequest(`/api/conversations/${encodeURIComponent(payload.conversationId)}/read`, userId, {
      method: "POST",
    });

    setBootstrap((previous) => {
      if (!previous) {
        return previous;
      }

      return {
        ...previous,
        dms: previous.dms.map((dm) =>
          dm.otherUser.id === thread.otherUserId
            ? {
                ...dm,
                unreadCount: 0,
                conversationId: payload.conversationId,
              }
            : dm,
        ),
      };
    });
  }, []);

  const refreshAll = useCallback(
    async (userId = activeUserId) => {
      const epoch = ++refreshEpochRef.current;
      const stale = () => refreshEpochRef.current !== epoch;

      setError(null);
      try {
        const loadedDirectories = Array.from(loadedDirectoriesRef.current);
        const directoriesToRefresh = loadedDirectories.length > 0 ? loadedDirectories : [""];

        await Promise.all([
          loadBootstrap(userId),
          loadBriefings(userId),
          loadChat(userId),
          loadTasks(userId),
          loadCalendar(userId, calendarMonthRef.current, { silent: true }),
          ...directoriesToRefresh.map((directory) =>
            loadWorkspaceDirectory(directory, { force: true, userId }),
          ),
        ]);

        if (stale()) return;

        if (userId === activeUserId && activeViewRef.current === "thread" && selectedThreadRef.current) {
          await loadThreadMessages(selectedThreadRef.current, userId);
        }
      } catch (refreshError) {
        if (!stale()) {
          setError(toErrorMessage(refreshError));
        }
      }
    },
    [
      activeUserId,
      loadBootstrap,
      loadBriefings,
      loadCalendar,
      loadChat,
      loadTasks,
      loadThreadMessages,
      loadWorkspaceDirectory,
    ],
  );

  const openThread = useCallback(
    async (thread: Thread, userId = activeUserId) => {
      setActiveView("thread");
      setSelectedThread(thread);
      setLoadingManual(true);
      setError(null);

      try {
        await loadThreadMessages(thread, userId);
      } catch (threadError) {
        setError(toErrorMessage(threadError));
      } finally {
        setLoadingManual(false);
      }
    },
    [activeUserId, loadThreadMessages],
  );

  const openGlobalSearchResult = useCallback(
    async (result: GlobalSearchResult) => {
      setGlobalSearchError(null);

      if (result.kind === "file" && result.filePath) {
        setWorkspaceFileSelection(result.filePath);
        setWorkspaceSelectedFilePath(result.filePath);
        setActiveView("docs");
        await loadWorkspaceDocument(result.filePath);
        return;
      }

      if (result.kind === "event" && result.eventStartAt) {
        const eventDate = new Date(result.eventStartAt);
        if (!Number.isNaN(eventDate.getTime())) {
          setCalendarMonth(startOfMonth(eventDate));
          setSelectedCalendarDate(toDateKey(eventDate));
        }
        setActiveView("calendar");
        return;
      }

      if (result.kind === "task") {
        setActiveView("tasks");
        return;
      }

      if (
        (result.kind === "channel" || (result.kind === "message" && result.threadKind === "channel")) &&
        result.conversationId
      ) {
        await openThread({
          kind: "channel",
          conversationId: result.conversationId,
          label: result.channelName ? `#${result.channelName}` : result.title,
        });
        return;
      }

      if (
        (result.kind === "dm" || (result.kind === "message" && result.threadKind === "dm")) &&
        result.otherUserId
      ) {
        await openThread({
          kind: "dm",
          otherUserId: result.otherUserId,
          conversationId: result.conversationId,
          label: result.otherUserName ?? result.title,
        });
        return;
      }

      if (result.kind === "user" && result.userId) {
        await openThread({
          kind: "dm",
          otherUserId: result.userId,
          conversationId: null,
          label: result.title,
        });
      }
    },
    [loadWorkspaceDocument, openThread],
  );

  const submitAgentCommand = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const input = commandInput.trim();
      if (!input) {
        return;
      }
      const mentions = commandMentions;
      const contextHints = buildMentionContextHints(mentions);
      const optimisticId = `optimistic-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticMessage: ChatMessageView = {
        id: optimisticId,
        role: "user",
        body: input,
        taskId: null,
        createdAt: new Date().toISOString(),
      };

      if (mentions.length > 0) {
        setMessageMentions((previous) => new Map(previous).set(optimisticId, mentions));
      }
      setChatMessages((previous) => [...previous, optimisticMessage]);
      setCommandInput("");
      setCommandCursor(0);
      setCommandMentions([]);

      setCommandRunning(true);
      setError(null);

      try {
        const payload = await apiRequest<AgentCommandResponse>("/api/agent/commands", activeUserId, {
          method: "POST",
          body: JSON.stringify({
            input,
            mentions,
            contextHints,
          }),
        });

        setMessageMentions((previous) => {
          const next = new Map(previous);
          next.delete(optimisticId);
          return next;
        });
        setChatMessages((previous) => {
          const withoutOptimistic = previous.filter(
            (message) => message.id !== optimisticId,
          );
          const existingIds = new Set(withoutOptimistic.map((message) => message.id));
          const next = [...withoutOptimistic];

          for (const message of payload.messages) {
            if (existingIds.has(message.id)) {
              continue;
            }

            next.push(message);
            existingIds.add(message.id);
          }

          return next;
        });
        await refreshAll(activeUserId);
      } catch (commandError) {
        setMessageMentions((previous) => {
          const next = new Map(previous);
          next.delete(optimisticId);
          return next;
        });
        setChatMessages((previous) =>
          previous.filter((message) => message.id !== optimisticId),
        );
        setCommandInput(input);
        setCommandCursor(input.length);
        setCommandMentions(mentions);
        setError(toErrorMessage(commandError));
      } finally {
        setCommandRunning(false);
      }
    },
    [activeUserId, commandInput, commandMentions, refreshAll],
  );

  const sendManualMessage = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const body = manualBody.trim();
      if (!selectedThread || !body) {
        return;
      }

      const optimisticId = `optimistic-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticMessage: MessageView = {
        id: optimisticId,
        conversationId: selectedThread.kind === "channel" ? selectedThread.conversationId : (selectedThread.conversationId ?? optimisticId),
        body,
        createdAt: new Date().toISOString(),
        isAgentMessage: false,
        sender: activeUser ?? { id: activeUserId, displayName: "You", avatarColor: "#8fb5ff" },
      };

      setManualBody("");
      setManualMessages((previous) => [...previous, optimisticMessage]);
      setError(null);

      try {
        if (selectedThread.kind === "channel") {
          const payload = await apiRequest<PostMessageResponse>(
            `/api/conversations/${encodeURIComponent(selectedThread.conversationId)}/messages`,
            activeUserId,
            {
              method: "POST",
              body: JSON.stringify({ body }),
            },
          );

          setManualMessages((previous) =>
            previous.map((m) => (m.id === optimisticId ? payload.message : m)),
          );
        } else {
          const payload = await apiRequest<PostDmMessageResponse>(
            `/api/dms/${encodeURIComponent(selectedThread.otherUserId)}/messages`,
            activeUserId,
            {
              method: "POST",
              body: JSON.stringify({ body }),
            },
          );

          setSelectedThread({
            ...selectedThread,
            conversationId: payload.conversationId,
          });
          setManualMessages((previous) =>
            previous.map((m) => (m.id === optimisticId ? payload.message : m)),
          );
        }

        await refreshAll(activeUserId);
      } catch (sendError) {
        setManualMessages((previous) => previous.filter((m) => m.id !== optimisticId));
        setManualBody(body);
        setError(toErrorMessage(sendError));
      }
    },
    [activeUser, activeUserId, manualBody, refreshAll, selectedThread],
  );

  const updateTaskStatus = useCallback(
    async (
      taskId: string,
      status: WorkspaceTaskView["status"],
      options?: {
        sortRank?: number;
      },
    ) => {
      const nowIso = new Date().toISOString();
      const nextSortRank = options?.sortRank;
      setTasks((previous) =>
        previous.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status,
                ...(nextSortRank !== undefined ? { sortRank: nextSortRank } : {}),
                updatedAt: nowIso,
              }
            : task,
        ),
      );

      try {
        await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, activeUserId, {
          method: "PATCH",
          body: JSON.stringify({
            status,
            ...(nextSortRank !== undefined ? { sortRank: nextSortRank } : {}),
          }),
        });
        await loadTasks(activeUserId);
      } catch (e) {
        await loadTasks(activeUserId);
        setError(toErrorMessage(e));
      }
    },
    [activeUserId, loadTasks],
  );

  const createTask = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const title = newTaskTitle.trim();
      if (!title || creatingTask) {
        return;
      }

      setCreatingTask(true);
      setError(null);

      try {
        await apiRequest("/api/tasks", activeUserId, {
          method: "POST",
          body: JSON.stringify({
            title,
            description: newTaskDescription.trim(),
            urgency: newTaskUrgency,
            status: "OPEN",
          }),
        });
        setNewTaskTitle("");
        setNewTaskDescription("");
        setNewTaskUrgency("MEDIUM");
        await loadTasks(activeUserId);
      } catch (taskError) {
        setError(toErrorMessage(taskError));
      } finally {
        setCreatingTask(false);
      }
    },
    [activeUserId, creatingTask, loadTasks, newTaskDescription, newTaskTitle, newTaskUrgency],
  );

  const selectUser = useCallback(
    (userId: string) => {
      if (userId !== activeUserId) {
        globalSearchRequestRef.current += 1;
        refreshEpochRef.current++;
        setActiveUserId(userId);
        setBootstrap(null);
        setSelectedThread(null);
        setManualMessages([]);
        setChatMessages([]);
        setCommandInput("");
        setCommandCursor(0);
        setCommandMentions([]);
        setGlobalSearchInput("");
        setGlobalSearchQuery("");
        setGlobalSearchResults([]);
        setGlobalSearchProviders({
          chat: "native",
          files: "native",
        });
        setGlobalSearchError(null);
        setGlobalSearchLoading(false);
        setWorkspaceMentionFiles(null);
        setWorkspaceMentionFilesLoading(false);
        setTasks([]);
        setCalendarEvents([]);
        setCalendarMonth(startOfMonth(new Date()));
        setSelectedCalendarDate(toDateKey(new Date()));
        setWorkspaceSelectedFilePath(null);
        setWorkspaceDocument(null);
        setWorkspaceDocumentContent("");
        workspaceDocumentContentRef.current = "";
        setWorkspaceDocumentError(null);
        setWorkspaceAiInstruction("");
        setWorkspaceAiStatus(null);
      }

      setProfileOpen(false);
    },
    [activeUserId],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const stored = window.localStorage.getItem(USER_STORAGE_KEY);
    if (stored && stored.trim()) {
      setActiveUserId(stored.trim());
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(USER_STORAGE_KEY, activeUserId);
    }

    void refreshAll(activeUserId);
  }, [activeUserId, refreshAll]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshAll(activeUserId);
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeUserId, refreshAll]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncNow = () => {
      void refreshAll(activeUserId);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        syncNow();
      }
    };

    window.addEventListener("focus", syncNow);
    window.addEventListener("online", syncNow);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", syncNow);
      window.removeEventListener("online", syncNow);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeUserId, refreshAll]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams({ userId: activeUserId });
    const source = new EventSource(`/api/events?${params.toString()}`);

    const handleRealtimeUpdate = () => {
      void refreshAll(activeUserId);
    };

    source.addEventListener("workspace-update", handleRealtimeUpdate);
    source.addEventListener("profile-update", handleRealtimeUpdate);

    return () => {
      source.removeEventListener("workspace-update", handleRealtimeUpdate);
      source.removeEventListener("profile-update", handleRealtimeUpdate);
      source.close();
    };
  }, [activeUserId, refreshAll]);

  useEffect(() => {
    if (activeView === "tasks") {
      void loadTasks(activeUserId);
    }
  }, [activeView, activeUserId, loadTasks]);

  useEffect(() => {
    if (activeView === "calendar") {
      void loadCalendar(activeUserId, calendarMonth).catch((calendarError) => {
        setError(toErrorMessage(calendarError));
      });
    }
  }, [activeView, activeUserId, calendarMonth, loadCalendar]);

  useEffect(() => {
    if (
      activeView === "docs" &&
      workspaceSelectedFilePath &&
      workspaceDocument?.path !== workspaceSelectedFilePath
    ) {
      void loadWorkspaceDocument(workspaceSelectedFilePath).catch((documentError) => {
        setWorkspaceDocumentError(toErrorMessage(documentError));
      });
    }
  }, [activeView, loadWorkspaceDocument, workspaceDocument?.path, workspaceSelectedFilePath]);

  useEffect(() => {
    const selected = fromDateKey(selectedCalendarDate);
    if (!selected) {
      setSelectedCalendarDate(toDateKey(calendarMonth));
      return;
    }

    const sameMonth =
      selected.getFullYear() === calendarMonth.getFullYear() &&
      selected.getMonth() === calendarMonth.getMonth();

    if (!sameMonth) {
      setSelectedCalendarDate(toDateKey(calendarMonth));
    }
  }, [calendarMonth, selectedCalendarDate]);

  useEffect(() => {
    if (!profileOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setProfileOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileOpen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [briefings, chatMessages]);

  useEffect(() => {
    workspaceDocumentContentRef.current = workspaceDocumentContent;
  }, [workspaceDocumentContent]);

  useEffect(() => {
    if (activeView !== "thread" || !selectedThread) {
      return;
    }

    const section = selectedThread.kind === "channel" ? "channels" : "dms";
    setOpenSidebarSections((current) => {
      const next = new Set(current);
      next.add(section);
      return next;
    });
  }, [activeView, selectedThread]);

  const toggleSidebarSection = useCallback((section: SidebarSection) => {
    setOpenSidebarSections((current) => {
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  const aiTimeline = useMemo<AiTimelineItem[]>(() => {
    const timeline: AiTimelineItem[] = [
      ...chatMessages.map((message) => ({
        kind: "chat" as const,
        ...message,
        mentions: messageMentions.get(message.id),
      })),
      ...briefings.map((briefing) => ({
        kind: "briefing" as const,
        id: briefing.id,
        body:
          briefing.summary.trim() ||
          briefing.title.trim() ||
          "Proactive update from your AI assistant.",
        createdAt: briefing.createdAt,
      })),
    ];

    timeline.sort((left, right) => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      if (left.kind === right.kind) {
        return 0;
      }

      return left.kind === "chat" ? -1 : 1;
    });

    return timeline;
  }, [briefings, chatMessages, messageMentions]);

  const filteredTasks = useMemo(() => {
    const search = taskSearch.trim().toLowerCase();
    return tasks.filter((task) => {
      if (taskFilterUrgency && task.urgency !== taskFilterUrgency) {
        return false;
      }

      if (!search) {
        return true;
      }

      const title = task.title.toLowerCase();
      const description = task.description.toLowerCase();
      return title.includes(search) || description.includes(search);
    });
  }, [taskFilterUrgency, taskSearch, tasks]);

  const tasksByStatus = useMemo(() => {
    const buckets = new Map<WorkspaceTaskView["status"], WorkspaceTaskView[]>();

    for (const column of TASK_COLUMNS) {
      buckets.set(column.status, []);
    }

    for (const task of filteredTasks) {
      buckets.get(task.status)?.push(task);
    }

    for (const [status, list] of buckets.entries()) {
      buckets.set(
        status,
        list.slice().sort((left, right) => {
          if (left.sortRank !== right.sortRank) {
            return left.sortRank - right.sortRank;
          }
          return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
        }),
      );
    }

    return buckets;
  }, [filteredTasks]);

  const clearTaskDragState = useCallback(() => {
    setDraggingTaskId(null);
    setDragOverSlot(null);
  }, []);

  const handleTaskDragStart = useCallback((event: DragEvent<HTMLElement>, taskId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
    setDraggingTaskId(taskId);
  }, []);

  const handleTaskDrop = useCallback(
    async (status: WorkspaceTaskView["status"], insertionIndex: number) => {
      const activeTaskId = draggingTaskId;
      if (!activeTaskId) {
        return;
      }

      const sourceTask = tasks.find((task) => task.id === activeTaskId);
      if (!sourceTask) {
        clearTaskDragState();
        return;
      }

      const currentColumn = tasksByStatus.get(status) ?? [];
      const destinationColumn = currentColumn.filter((task) => task.id !== activeTaskId);

      let targetIndex = Math.max(0, Math.min(insertionIndex, destinationColumn.length));
      if (sourceTask.status === status) {
        const sourceIndex = currentColumn.findIndex((task) => task.id === activeTaskId);
        if (sourceIndex !== -1 && sourceIndex < insertionIndex) {
          targetIndex = Math.max(0, targetIndex - 1);
        }
      }

      const previousTask = targetIndex > 0 ? destinationColumn[targetIndex - 1] : null;
      const nextTask = targetIndex < destinationColumn.length ? destinationColumn[targetIndex] : null;

      let sortRank = 0;
      if (previousTask && nextTask) {
        sortRank = (previousTask.sortRank + nextTask.sortRank) / 2;
      } else if (previousTask) {
        sortRank = previousTask.sortRank + 1;
      } else if (nextTask) {
        sortRank = nextTask.sortRank - 1;
      }

      clearTaskDragState();
      await updateTaskStatus(activeTaskId, status, { sortRank });
    },
    [clearTaskDragState, draggingTaskId, tasks, tasksByStatus, updateTaskStatus],
  );

  const handleTaskSlotDragOver = useCallback(
    (
      event: DragEvent<HTMLElement>,
      status: WorkspaceTaskView["status"],
      index: number,
    ) => {
      if (!draggingTaskId) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragOverSlot(`${status}:${index}`);
    },
    [draggingTaskId],
  );

  const mentionTrigger = useMemo(
    () => parseMentionTrigger(commandInput, commandCursor),
    [commandCursor, commandInput],
  );

  useEffect(() => {
    if (commandCursor > commandInput.length) {
      setCommandCursor(commandInput.length);
    }
  }, [commandCursor, commandInput.length]);

  useEffect(() => {
    if (
      mentionTrigger?.resolvedKind === "file" &&
      workspaceMentionFiles === null &&
      !workspaceMentionFilesLoading
    ) {
      void indexWorkspaceFilesForMentions(activeUserId);
    }
  }, [
    activeUserId,
    indexWorkspaceFilesForMentions,
    mentionTrigger?.resolvedKind,
    workspaceMentionFiles,
    workspaceMentionFilesLoading,
  ]);

  const channels = bootstrap?.channels ?? [];
  const dms = bootstrap?.dms ?? [];
  const loadedWorkspaceFiles = useMemo(
    () =>
      Object.values(workspaceFilesByDirectory)
        .flat()
        .filter((entry) => entry.kind === "file"),
    [workspaceFilesByDirectory],
  );
  const mentionableFiles = workspaceMentionFiles ?? loadedWorkspaceFiles;
  const selectedMentionKeys = useMemo(
    () => new Set(commandMentions.map((mention) => mentionKey(mention))),
    [commandMentions],
  );
  const mentionSuggestions = useMemo<MentionSuggestion[]>(() => {
    if (!mentionTrigger) {
      return [];
    }

    if (!mentionTrigger.resolvedKind) {
      const matchingKinds = MENTION_KINDS.filter((entry) =>
        mentionTrigger.kindToken
          ? entry.kind.toLowerCase().startsWith(mentionTrigger.kindToken)
          : true,
      );

      return matchingKinds.map((entry) => ({
        key: `kind:${entry.kind}`,
        type: "kind" as const,
        kind: entry.kind,
        label: entry.label,
        description: entry.description,
      }));
    }

    const query = mentionTrigger.query;

    if (mentionTrigger.resolvedKind === "event") {
      return calendarEvents
        .slice()
        .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())
        .map((event) => {
          const eventLabel = event.title.trim() || "Untitled event";
          const subtitle = `${formatDate(event.startAt)}${event.location ? ` · ${event.location}` : ""}`;
          return {
            key: `event:${event.id}`,
            type: "entity" as const,
            kind: "event" as const,
            label: eventLabel,
            description: subtitle,
            mention: {
              kind: "event" as const,
              eventId: event.id,
              title: eventLabel,
              startAt: event.startAt,
              endAt: event.endAt,
              allDay: event.allDay,
              ownerId: event.ownerId,
              attendeeUserIds: event.attendeeUserIds,
            },
          };
        })
        .filter((item) => {
          if (selectedMentionKeys.has(item.key)) {
            return false;
          }

          if (!query) {
            return true;
          }

          const haystack = `${item.label} ${item.description}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, MAX_MENTION_SUGGESTIONS);
    }

    if (mentionTrigger.resolvedKind === "task") {
      return tasks
        .slice()
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        .map((task) => ({
          key: `task:${task.id}`,
          type: "entity" as const,
          kind: "task" as const,
          label: task.title.trim() || "Untitled task",
          description: `${statusToLabel(task.status)} · ${task.urgency.toLowerCase()} urgency`,
          mention: {
            kind: "task" as const,
            taskId: task.id,
            title: task.title.trim() || "Untitled task",
            description: task.description,
            urgency: task.urgency,
            status: task.status,
            assigneeId: task.assigneeId,
            createdById: task.createdById,
            updatedAt: task.updatedAt,
          },
        }))
        .filter((item) => {
          if (selectedMentionKeys.has(item.key)) {
            return false;
          }

          if (!query) {
            return true;
          }

          const haystack = `${item.label} ${item.description} ${item.mention.description}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, MAX_MENTION_SUGGESTIONS);
    }

    if (mentionTrigger.resolvedKind === "dm") {
      return dms
        .map((dm) => ({
          key: `dm:${dm.otherUser.id}`,
          type: "entity" as const,
          kind: "dm" as const,
          label: dm.otherUser.displayName,
          description: dm.lastMessage ? summarizePreview(dm.lastMessage) : "No messages yet",
          mention: {
            kind: "dm" as const,
            userId: dm.otherUser.id,
            displayName: dm.otherUser.displayName,
            conversationId: dm.conversationId,
          },
        }))
        .filter((item) => {
          if (selectedMentionKeys.has(item.key)) {
            return false;
          }

          if (!query) {
            return true;
          }

          const haystack = `${item.label} ${item.description}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, MAX_MENTION_SUGGESTIONS);
    }

    if (mentionTrigger.resolvedKind === "channel") {
      return channels
        .map((channel) => ({
          key: `channel:${channel.channel.id}`,
          type: "entity" as const,
          kind: "channel" as const,
          label: `#${channel.channel.name}`,
          description: channel.lastMessage ? summarizePreview(channel.lastMessage) : "No messages yet",
          mention: {
            kind: "channel" as const,
            channelId: channel.channel.id,
            channelSlug: channel.channel.slug,
            channelName: channel.channel.name,
            conversationId: channel.conversationId,
          },
        }))
        .filter((item) => {
          if (selectedMentionKeys.has(item.key)) {
            return false;
          }

          if (!query) {
            return true;
          }

          const haystack = `${item.label} ${item.description}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, MAX_MENTION_SUGGESTIONS);
    }

    return mentionableFiles
      .slice()
      .sort((left, right) =>
        left.path.localeCompare(right.path, undefined, {
          sensitivity: "base",
          numeric: true,
        }),
      )
      .map((file) => ({
        key: `file:${file.path}`,
        type: "entity" as const,
        kind: "file" as const,
        label: file.name,
        description: file.path,
        mention: {
          kind: "file" as const,
          path: file.path,
          name: file.name,
        },
      }))
      .filter((item) => {
        if (selectedMentionKeys.has(item.key)) {
          return false;
        }

        if (!query) {
          return true;
        }

        const haystack = `${item.label} ${item.description}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, MAX_MENTION_SUGGESTIONS);
  }, [
    calendarEvents,
    channels,
    dms,
    mentionTrigger,
    mentionableFiles,
    selectedMentionKeys,
    tasks,
  ]);
  const mentionPickerOpen = mentionTrigger !== null;
  const mentionSuggestionsReady = mentionSuggestions.length > 0;

  useEffect(() => {
    setMentionNavIndex(0);
  }, [mentionSuggestions]);

  const focusCommandInputAt = useCallback((nextCursor: number) => {
    if (typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      const input = commandInputRef.current;
      if (!input) {
        return;
      }

      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }, []);

  const applyMentionSuggestion = useCallback(
    (suggestion: MentionSuggestion) => {
      if (!mentionTrigger) {
        return;
      }

      if (suggestion.type === "kind") {
        const replacement = `@${suggestion.kind} `;
        const nextInput = `${commandInput.slice(0, mentionTrigger.start)}${replacement}${commandInput.slice(
          mentionTrigger.end,
        )}`;
        const nextCursor = mentionTrigger.start + replacement.length;
        setCommandInput(nextInput);
        setCommandCursor(nextCursor);
        setMentionNavIndex(0);
        focusCommandInputAt(nextCursor);
        return;
      }

      const key = mentionKey(suggestion.mention);
      setCommandMentions((previous) => {
        if (previous.some((entry) => mentionKey(entry) === key)) {
          return previous;
        }

        return [...previous, suggestion.mention];
      });

      const before = commandInput.slice(0, mentionTrigger.start);
      const after = commandInput.slice(mentionTrigger.end);
      const needsSpace = before.length > 0 && after.length > 0 && !/\s$/.test(before) && !/^\s/.test(after);
      const nextInput = `${before}${needsSpace ? " " : ""}${after}`;
      const nextCursor = before.length + (needsSpace ? 1 : 0);
      setCommandInput(nextInput);
      setCommandCursor(nextCursor);
      setMentionNavIndex(0);
      focusCommandInputAt(nextCursor);
    },
    [commandInput, focusCommandInputAt, mentionTrigger],
  );

  const removeMention = useCallback((target: AgentMention) => {
    const targetKey = mentionKey(target);
    setCommandMentions((previous) =>
      previous.filter((mention) => mentionKey(mention) !== targetKey),
    );
  }, []);

  const channelUnreadCount = channels.reduce((sum, channel) => sum + channel.unreadCount, 0);
  const dmUnreadCount = dms.reduce((sum, dm) => sum + dm.unreadCount, 0);
  const rootDirectoryCount = workspaceFilesByDirectory[""]?.length ?? 0;
  const workspaceDocumentMode: WorkspaceDocumentMode | null = workspaceDocument
    ? resolveWorkspaceDocumentMode(workspaceDocument)
    : null;
  const workspaceDocumentRawUrl = workspaceDocument
    ? buildWorkspaceFileRawUrl(workspaceDocument.path, activeUserId)
    : null;
  const workspaceDocumentDirty =
    workspaceDocumentMode === "text"
      ? workspaceDocumentContent !== (workspaceDocument?.content ?? "")
      : false;
  const workspaceSelectedLabel = workspaceSelectedFilePath
    ? workspaceSelectedFilePath.split("/").at(-1) ?? workspaceSelectedFilePath
    : null;
  const sidebarSearchActive = globalSearchInput.trim().length > 0;
  const globalSearchResultsByKind = useMemo(() => {
    const buckets = new Map<GlobalSearchResult["kind"], GlobalSearchResult[]>();
    for (const result of globalSearchResults) {
      const current = buckets.get(result.kind) ?? [];
      current.push(result);
      buckets.set(result.kind, current);
    }

    const order: GlobalSearchResult["kind"][] = [
      "message",
      "file",
      "task",
      "event",
      "channel",
      "dm",
      "user",
    ];

    return order
      .map((kind) => ({
        kind,
        items: buckets.get(kind) ?? [],
      }))
      .filter((bucket) => bucket.items.length > 0);
  }, [globalSearchResults]);
  const todayKey = toDateKey(new Date());
  const calendarGridDays = useMemo(() => buildCalendarGridDays(calendarMonth), [calendarMonth]);
  const calendarEventsByDay = useMemo(() => {
    const buckets = new Map<string, CalendarEventView[]>();

    for (const day of calendarGridDays) {
      buckets.set(toDateKey(day), []);
    }

    for (const event of calendarEvents) {
      for (const day of calendarGridDays) {
        if (eventOccursOnDate(event, day)) {
          buckets.get(toDateKey(day))?.push(event);
        }
      }
    }

    for (const [key, events] of buckets.entries()) {
      buckets.set(
        key,
        events
          .slice()
          .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime()),
      );
    }

    return buckets;
  }, [calendarEvents, calendarGridDays]);

  const selectedCalendarDay = useMemo(
    () => fromDateKey(selectedCalendarDate) ?? calendarMonth,
    [calendarMonth, selectedCalendarDate],
  );

  const selectedCalendarDayEvents = useMemo(
    () =>
      (calendarEventsByDay.get(toDateKey(selectedCalendarDay)) ?? []).slice().sort((left, right) => {
        return new Date(left.startAt).getTime() - new Date(right.startAt).getTime();
      }),
    [calendarEventsByDay, selectedCalendarDay],
  );

  const threadTimeline = useMemo<ThreadTimelineItem[]>(() => {
    const items: ThreadTimelineItem[] = [];
    let previousMessage: MessageView | null = null;
    let previousDayKey: string | null = null;
    let previousTimestamp = 0;

    for (const message of manualMessages) {
      const dayKey = toMessageDayKey(message.createdAt);
      const timestamp = new Date(message.createdAt).getTime();
      if (dayKey !== previousDayKey) {
        items.push({
          kind: "divider",
          id: `divider-${dayKey}`,
          label: formatMessageDay(message.createdAt),
        });
      }

      const compact =
        previousMessage !== null &&
        previousMessage.sender.id === message.sender.id &&
        dayKey === previousDayKey &&
        timestamp - previousTimestamp <= COMPACT_MESSAGE_WINDOW_MS;

      items.push({
        kind: "message",
        id: message.id,
        message,
        compact,
      });

      previousMessage = message;
      previousDayKey = dayKey;
      previousTimestamp = timestamp;
    }

    return items;
  }, [manualMessages]);

  const calendarMonthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
      }).format(calendarMonth),
    [calendarMonth],
  );

  const toggleWorkspaceDirectory = useCallback(
    (directory: string) => {
      const isExpanded = expandedDirectories.has(directory);
      if (!isExpanded) {
        void loadWorkspaceDirectory(directory);
      }

      setExpandedDirectories((previous) => {
        const next = new Set(previous);
        if (next.has(directory)) {
          next.delete(directory);
        } else {
          next.add(directory);
        }
        return next;
      });
      setWorkspaceFileSelection(directory);
      setWorkspaceSelectedFilePath(null);
      setWorkspaceDocument(null);
      setWorkspaceDocumentContent("");
      workspaceDocumentContentRef.current = "";
      setWorkspaceDocumentError(null);
      setWorkspaceAiStatus(null);
    },
    [expandedDirectories, loadWorkspaceDirectory],
  );

  const renderWorkspaceFileNodes = (directory: string, depth = 0): ReactNode => {
    const entries = workspaceFilesByDirectory[directory] ?? [];
    if (entries.length === 0) {
      if (workspaceDirectoryLoading[directory]) {
        return (
          <p className="ow-side-file-status" style={{ paddingLeft: `${depth * 16 + 18}px` }}>
            Loading...
          </p>
        );
      }

      if (loadedDirectoriesRef.current.has(directory)) {
        return (
          <p className="ow-side-file-status" style={{ paddingLeft: `${depth * 16 + 18}px` }}>
            No documents in this folder
          </p>
        );
      }

      return null;
    }

    return (
      <ul className="ow-side-file-tree" role={depth === 1 ? "tree" : "group"}>
        {entries.map((entry) => {
          const isDirectory = entry.kind === "directory";
          const fileBadge = isDirectory ? null : fileBadgeFromName(entry.name);
          const isExpanded = isDirectory && expandedDirectories.has(entry.path);
          const isSelected = workspaceFileSelection === entry.path;
          const childLoading =
            isDirectory &&
            Boolean(workspaceDirectoryLoading[entry.path]) &&
            !workspaceFilesByDirectory[entry.path];

          return (
            <li
              key={entry.path}
              className="ow-side-file-item"
              role="treeitem"
              aria-expanded={isDirectory ? isExpanded : undefined}
              aria-selected={isSelected}
            >
              <button
                type="button"
                className={`ow-side-file-row ${isSelected ? "is-selected" : ""}`}
                style={{ paddingLeft: `${depth * 16 + 10}px` }}
                onClick={() => {
                  if (isDirectory) {
                    toggleWorkspaceDirectory(entry.path);
                  } else {
                    setWorkspaceFileSelection(entry.path);
                    setWorkspaceSelectedFilePath(entry.path);
                    setActiveView("docs");
                    void loadWorkspaceDocument(entry.path);
                  }
                }}
              >
                <span
                  className={`ow-side-file-caret ${isDirectory ? "" : "is-hidden"}`}
                  aria-hidden="true"
                >
                  {isDirectory ? <DisclosureChevron expanded={isExpanded} /> : null}
                </span>
                <span
                  className={`ow-side-file-chip ${
                    isDirectory ? "is-directory" : `is-file is-${fileBadge?.tone ?? "generic"}`
                  }`}
                >
                  {isDirectory ? "DIR" : fileBadge?.label}
                </span>
                <span className="ow-side-file-label">{entry.name}</span>
              </button>

              {isDirectory && isExpanded ? (
                <>
                  {childLoading ? (
                    <p className="ow-side-file-status" style={{ paddingLeft: `${(depth + 1) * 16 + 18}px` }}>
                      Loading...
                    </p>
                  ) : (
                    renderWorkspaceFileNodes(entry.path, depth + 1)
                  )}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  const mainTitle =
    activeView === "tasks"
      ? "Tasks"
      : activeView === "calendar"
        ? "Calendar"
        : activeView === "email"
          ? "Email"
          : activeView === "docs"
            ? workspaceSelectedLabel ?? "Documents"
            : selectedThread?.label ?? "Select a Channel or DM";

  return (
    <div className="ow-shell">
      <a className="skip-link" href="#ow-main-content">
        Skip to Main Content
      </a>

      <div
        className={`ow-layout ${sidebarOpen ? "" : "ow-sidebar-collapsed"} ${
          aiPanelOpen ? "" : "ow-ai-panel-collapsed"
        }`}
      >
        <aside className="ow-sidebar">
          <div className="ow-brand">
            <p className="ow-brand-kicker">OpenWork</p>
            <div className="ow-brand-row">
              <h1>Workspace</h1>
              <button
                type="button"
                className="ow-sidebar-collapse"
                onClick={() => setSidebarOpen(false)}
                aria-label="Collapse Sidebar"
              >
                {"\u2039"}
              </button>
            </div>
          </div>

          <div className="ow-profile" ref={profileMenuRef}>
            <button
              type="button"
              className="ow-profile-trigger"
              aria-haspopup="menu"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((open) => !open)}
            >
              <span
                className="ow-avatar-dot"
                style={{ backgroundColor: activeUser?.avatarColor ?? "#8fb5ff" }}
                aria-hidden="true"
              />
              <span className="ow-profile-name">{activeUser?.displayName ?? "Select User"}</span>
              <span className="ow-profile-chevron" aria-hidden="true">
                {profileOpen ? "▴" : "▾"}
              </span>
            </button>

            {profileOpen ? (
              <div className="ow-profile-menu" role="menu" aria-label="User Profiles">
                {(bootstrap?.users ?? []).map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    role="menuitem"
                    className={`ow-profile-option ${user.id === activeUserId ? "is-active" : ""}`}
                    onClick={() => selectUser(user.id)}
                  >
                    <span
                      className="ow-avatar-dot"
                      style={{ backgroundColor: user.avatarColor }}
                      aria-hidden="true"
                    />
                    <span>{user.displayName}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="ow-sidebar-search">
            <div className={`ow-sidebar-search-row${globalSearchLoading ? " is-loading" : ""}`}>
              <svg className="ow-sidebar-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.6"/>
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
              <input
                id="ow-sidebar-search-input"
                type="search"
                value={globalSearchInput}
                onChange={(event) => setGlobalSearchInput(event.target.value)}
                placeholder="Search…"
                maxLength={180}
                aria-label="Global search"
              />
              {globalSearchInput.trim().length > 0 ? (
                <button
                  type="button"
                  className="ow-sidebar-search-clear"
                  onClick={clearGlobalSearch}
                  disabled={globalSearchLoading}
                  aria-label="Clear search"
                >
                  ×
                </button>
              ) : null}
            </div>
          </div>

          <div className="ow-sidebar-scroll">
            {sidebarSearchActive ? (
              <div className="ow-sidebar-group ow-sidebar-search-results-wrap" aria-live="polite">
                {globalSearchError ? (
                  <p className="ow-empty-side ow-search-empty-error">{globalSearchError}</p>
                ) : null}

                {globalSearchLoading ? (
                  <p className="ow-empty-side">Searching...</p>
                ) : globalSearchResults.length === 0 ? (
                  <p className="ow-empty-side">No results found.</p>
                ) : (
                  <div className="ow-sidebar-search-groups">
                    {globalSearchResultsByKind.map((group) => (
                      <section key={group.kind} className="ow-sidebar-search-group">
                        <p className="ow-sidebar-label">
                          {searchKindLabel(group.kind)} ({group.items.length})
                        </p>
                        <ul className="ow-sidebar-search-results">
                          {group.items.map((result) => (
                            <li key={`${group.kind}:${result.id}`}>
                              <button
                                type="button"
                                className="ow-sidebar-search-result"
                                onClick={() => {
                                  void openGlobalSearchResult(result).catch((openError) => {
                                    setGlobalSearchError(toErrorMessage(openError));
                                  });
                                }}
                              >
                                <span className="ow-sidebar-search-title">
                                  {renderHighlightedText(result.title, result.highlights?.title)}
                                </span>
                                {result.subtitle ? (
                                  <span className="ow-sidebar-search-subtitle">
                                    {renderHighlightedText(result.subtitle, result.highlights?.subtitle)}
                                  </span>
                                ) : null}
                                {result.snippet ? (
                                  <span className="ow-sidebar-search-snippet">
                                    {renderHighlightedText(result.snippet, result.highlights?.snippet)}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}

                {globalSearchQuery ? (
                  <p className="ow-empty-side ow-search-provider-meta">
                    Providers: chat {globalSearchProviders.chat} · files {globalSearchProviders.files}
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="ow-sidebar-group">
                  <p className="ow-sidebar-label">Workspace</p>
                  <div className="ow-workspace-nav">
                    <button
                      type="button"
                      className={`ow-nav-item ${activeView === "tasks" ? "is-active" : ""}`}
                      onClick={() => setActiveView("tasks")}
                    >
                      <span className="ow-nav-item-main">
                        <span className="ow-nav-item-icon" aria-hidden="true">
                          ☑
                        </span>
                        <span className="ow-nav-item-label">Tasks</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`ow-nav-item ${activeView === "calendar" ? "is-active" : ""}`}
                      onClick={() => setActiveView("calendar")}
                    >
                      <span className="ow-nav-item-main">
                        <span className="ow-nav-item-icon" aria-hidden="true">
                          ◷
                        </span>
                        <span className="ow-nav-item-label">Calendar</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`ow-nav-item ${activeView === "email" ? "is-active" : ""}`}
                      onClick={() => setActiveView("email")}
                    >
                      <span className="ow-nav-item-main">
                        <span className="ow-nav-item-icon" aria-hidden="true">
                          ✉
                        </span>
                        <span className="ow-nav-item-label">
                          Email
                          {FAKE_EMAILS.filter((e) => !e.read && e.folder === "inbox").length > 0 ? (
                            <span className="ow-email-nav-badge">
                              {FAKE_EMAILS.filter((e) => !e.read && e.folder === "inbox").length}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </div>
                </div>

                <div
                  className={`ow-sidebar-group ow-sidebar-section ${openSidebarSections.has("channels") ? "is-open" : ""}`}
                >
                  <button
                    type="button"
                    className="ow-section-toggle"
                    onClick={() => toggleSidebarSection("channels")}
                    aria-expanded={openSidebarSections.has("channels")}
                  >
                    <span className="ow-sidebar-label">Channels</span>
                    <span className="ow-section-meta">
                      {channelUnreadCount > 0 ? (
                        <span className="ow-count ow-count-unread">{channelUnreadCount}</span>
                      ) : null}
                      <span className="ow-section-total">{channels.length}</span>
                      <span className="ow-section-caret" aria-hidden="true">
                        {openSidebarSections.has("channels") ? "▾" : "▸"}
                      </span>
                    </span>
                  </button>

                  {openSidebarSections.has("channels") ? (
                    channels.length === 0 ? (
                      <p className="ow-empty-side">No channels</p>
                    ) : (
                      <ul className="ow-thread-list">
                        {channels.map((channel) => {
                          const selected =
                            activeView === "thread" &&
                            selectedThread?.kind === "channel" &&
                            selectedThread.conversationId === channel.conversationId;

                          return (
                            <li key={channel.conversationId}>
                              <button
                                type="button"
                                className={`ow-thread-item ${selected ? "is-active" : ""}`}
                                onClick={() =>
                                  void openThread({
                                    kind: "channel",
                                    conversationId: channel.conversationId,
                                    label: `#${channel.channel.name}`,
                                  })
                                }
                              >
                                <span className="ow-thread-main">
                                  <span className="ow-thread-prefix" aria-hidden="true">
                                    #
                                  </span>
                                  <span className="ow-thread-name">{channel.channel.name}</span>
                                </span>
                                {channel.unreadCount > 0 ? (
                                  <span className="ow-count ow-count-unread">{channel.unreadCount}</span>
                                ) : null}
                                {selected ? (
                                  <span className="ow-thread-preview">{summarizePreview(channel.lastMessage)}</span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )
                  ) : null}
                </div>

                <div
                  className={`ow-sidebar-group ow-sidebar-section ${openSidebarSections.has("dms") ? "is-open" : ""}`}
                >
                  <button
                    type="button"
                    className="ow-section-toggle"
                    onClick={() => toggleSidebarSection("dms")}
                    aria-expanded={openSidebarSections.has("dms")}
                  >
                    <span className="ow-sidebar-label">Direct Messages</span>
                    <span className="ow-section-meta">
                      {dmUnreadCount > 0 ? (
                        <span className="ow-count ow-count-unread">{dmUnreadCount}</span>
                      ) : null}
                      <span className="ow-section-total">{dms.length}</span>
                      <span className="ow-section-caret" aria-hidden="true">
                        {openSidebarSections.has("dms") ? "▾" : "▸"}
                      </span>
                    </span>
                  </button>

                  {openSidebarSections.has("dms") ? (
                    dms.length === 0 ? (
                      <p className="ow-empty-side">No direct messages</p>
                    ) : (
                      <ul className="ow-thread-list">
                        {dms.map((dm) => {
                          const selected =
                            activeView === "thread" &&
                            selectedThread?.kind === "dm" &&
                            selectedThread.otherUserId === dm.otherUser.id;

                          return (
                            <li key={dm.otherUser.id}>
                              <button
                                type="button"
                                className={`ow-thread-item ${selected ? "is-active" : ""}`}
                                onClick={() =>
                                  void openThread({
                                    kind: "dm",
                                    otherUserId: dm.otherUser.id,
                                    conversationId: dm.conversationId,
                                    label: dm.otherUser.displayName,
                                  })
                                }
                              >
                                <span className="ow-thread-main">
                                  <span className="ow-thread-prefix ow-thread-prefix-dm" aria-hidden="true">
                                    <span
                                      className="ow-thread-presence"
                                      style={{ backgroundColor: dm.otherUser.avatarColor }}
                                    />
                                  </span>
                                  <span className="ow-thread-name">{dm.otherUser.displayName}</span>
                                </span>
                                {dm.unreadCount > 0 ? (
                                  <span className="ow-count ow-count-unread">{dm.unreadCount}</span>
                                ) : null}
                                {selected ? (
                                  <span className="ow-thread-preview">{summarizePreview(dm.lastMessage)}</span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )
                  ) : null}
                </div>

                <div
                  className={`ow-sidebar-group ow-sidebar-section ow-sidebar-files ${
                    openSidebarSections.has("files") ? "is-open" : ""
                  }`}
                >
                  <div className="ow-sidebar-files-head">
                    <span className="ow-sidebar-label">Company Files</span>
                  </div>

                  {workspaceFilesError ? <p className="ow-side-file-status">{workspaceFilesError}</p> : null}

                  <div className="ow-side-files-wrap">
                    <button
                      type="button"
                      className={`ow-side-file-row ow-side-file-root ${
                        workspaceFileSelection === "" ? "is-selected" : ""
                      }`}
                      onClick={() => toggleWorkspaceDirectory("")}
                      aria-expanded={expandedDirectories.has("")}
                    >
                      <span className="ow-side-file-caret" aria-hidden="true">
                        <DisclosureChevron expanded={expandedDirectories.has("")} />
                      </span>
                      <span className="ow-side-file-label">{workspaceRootLabel}</span>
                    </button>

                    {expandedDirectories.has("") ? (
                      workspaceDirectoryLoading[""] && !workspaceFilesByDirectory[""] ? (
                        <p className="ow-side-file-status" style={{ paddingLeft: "34px" }}>
                          Loading...
                        </p>
                      ) : (
                        renderWorkspaceFileNodes("", 1)
                      )
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>
        </aside>

        {!sidebarOpen && (
          <button
            type="button"
            className="ow-sidebar-expand"
            onClick={() => setSidebarOpen(true)}
            aria-label="Expand Sidebar"
          >
            {"\u203A"}
          </button>
        )}

        <main className="ow-main" id="ow-main-content" tabIndex={-1}>
          <header className="ow-main-header">
            <p className="ow-main-kicker">
              {activeView === "tasks"
                ? "Tasks"
                : activeView === "calendar"
                  ? "Calendar"
                  : activeView === "email"
                    ? "Inbox"
                    : activeView === "docs"
                      ? "Documents"
                      : "Conversation"}
            </p>
            <h2 className="ow-main-title">{mainTitle}</h2>
          </header>

          {error ? (
            <p className="ow-error" role="status" aria-live="polite">
              {error}
            </p>
          ) : null}

          {activeView === "tasks" ? (
            <section className="ow-pane ow-tasks-pane">
              <form className="ow-task-create" onSubmit={(event) => void createTask(event)}>
                <div className="ow-task-create-row">
                  <input
                    type="text"
                    className="ow-task-create-title"
                    placeholder="Add a task"
                    value={newTaskTitle}
                    onChange={(event) => setNewTaskTitle(event.target.value)}
                    maxLength={200}
                  />
                  <button type="submit" disabled={creatingTask || newTaskTitle.trim().length === 0}>
                    {creatingTask ? "Adding…" : "Add"}
                  </button>
                </div>
                <textarea
                  className="ow-task-create-notes"
                  placeholder="Add details (optional)"
                  value={newTaskDescription}
                  onChange={(event) => setNewTaskDescription(event.target.value)}
                  rows={2}
                  maxLength={1500}
                />
                <div className="ow-task-create-row">
                  <select
                    className="ow-tasks-filter"
                    value={newTaskUrgency}
                    onChange={(event) =>
                      setNewTaskUrgency(event.target.value as WorkspaceTaskView["urgency"])
                    }
                    aria-label="New task urgency"
                  >
                    <option value="LOW">Low urgency</option>
                    <option value="MEDIUM">Medium urgency</option>
                    <option value="HIGH">High urgency</option>
                    <option value="CRITICAL">Critical urgency</option>
                  </select>
                  <input
                    type="search"
                    className="ow-tasks-search"
                    placeholder="Search tasks"
                    value={taskSearch}
                    onChange={(event) => setTaskSearch(event.target.value)}
                  />
                  <select
                    className="ow-tasks-filter"
                    value={taskFilterUrgency}
                    onChange={(event) => setTaskFilterUrgency(event.target.value)}
                    aria-label="Filter by urgency"
                  >
                    <option value="">All urgencies</option>
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="CRITICAL">Critical</option>
                  </select>
                </div>
              </form>

              <div className="ow-task-board">
                {TASK_COLUMNS.map((column) => {
                  const columnTasks = tasksByStatus.get(column.status) ?? [];
                  return (
                    <section
                      key={column.status}
                      className={`ow-task-column ${draggingTaskId ? "is-drag-active" : ""}`}
                    >
                      <header className="ow-task-column-head">
                        <div>
                          <h3>{column.label}</h3>
                          <p>{column.subtitle}</p>
                        </div>
                        <span className="ow-task-count">{columnTasks.length}</span>
                      </header>
                      <div className="ow-task-column-body">
                        <div
                          className={`ow-task-drop-slot ${
                            dragOverSlot === `${column.status}:0` ? "is-target" : ""
                          }`}
                          aria-label={`Drop task into ${statusToLabel(column.status)}`}
                          onDragOver={(event) => handleTaskSlotDragOver(event, column.status, 0)}
                          onDragLeave={() => setDragOverSlot(null)}
                          onDrop={(event) => {
                            event.preventDefault();
                            void handleTaskDrop(column.status, 0);
                          }}
                        />

                        {columnTasks.map((task, index) => (
                          <div key={task.id}>
                            <article
                              draggable
                              className={`ow-task-card is-urgency-${task.urgency.toLowerCase()} ${
                                draggingTaskId === task.id ? "is-dragging" : ""
                              }`}
                              onDragStart={(event) => handleTaskDragStart(event, task.id)}
                              onDragEnd={clearTaskDragState}
                            >
                              <div className="ow-task-card-head">
                                <div className="ow-task-card-title-wrap">
                                  <span
                                    className={`ow-task-dot is-${task.urgency.toLowerCase()}`}
                                    aria-hidden="true"
                                  />
                                  <strong>{task.title}</strong>
                                </div>
                                <span className="ow-task-pill">{task.urgency}</span>
                              </div>
                              {task.description ? (
                                <p className="ow-task-desc">{task.description}</p>
                              ) : null}
                              <div className="ow-task-meta">
                                {task.deadline ? <span>Due {formatDate(task.deadline)}</span> : null}
                                {task.assigneeName ? <span>→ {task.assigneeName}</span> : null}
                                <span>{formatDate(task.updatedAt)}</span>
                              </div>
                              <div className="ow-task-actions">
                                {task.status !== "OPEN" ? (
                                  <button type="button" onClick={() => void updateTaskStatus(task.id, "OPEN")}>
                                    Open
                                  </button>
                                ) : null}
                                {task.status !== "IN_PROGRESS" ? (
                                  <button
                                    type="button"
                                    onClick={() => void updateTaskStatus(task.id, "IN_PROGRESS")}
                                  >
                                    Start
                                  </button>
                                ) : null}
                                {task.status !== "DONE" ? (
                                  <button type="button" onClick={() => void updateTaskStatus(task.id, "DONE")}>
                                    Done
                                  </button>
                                ) : null}
                              </div>
                            </article>
                            <div
                              className={`ow-task-drop-slot ${
                                dragOverSlot === `${column.status}:${index + 1}` ? "is-target" : ""
                              }`}
                              aria-label={`Drop task into ${statusToLabel(column.status)}`}
                              onDragOver={(event) =>
                                handleTaskSlotDragOver(event, column.status, index + 1)
                              }
                              onDragLeave={() => setDragOverSlot(null)}
                              onDrop={(event) => {
                                event.preventDefault();
                                void handleTaskDrop(column.status, index + 1);
                              }}
                            />
                          </div>
                        ))}

                        {columnTasks.length === 0 ? (
                          <p className="ow-task-empty">Drop tasks here or add one above.</p>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            </section>
          ) : activeView === "calendar" ? (
            <section className="ow-pane ow-calendar-pane">
              <div className="ow-calendar-toolbar">
                <div className="ow-calendar-toolbar-group">
                  <button
                    type="button"
                    className="ow-calendar-nav-btn"
                    aria-label="Previous month"
                    onClick={() =>
                      setCalendarMonth(
                        (previous) =>
                          new Date(previous.getFullYear(), previous.getMonth() - 1, 1),
                      )
                    }
                  >
                    {"\u2039"}
                  </button>
                  <button
                    type="button"
                    className="ow-calendar-nav-btn is-today"
                    onClick={() => {
                      const today = new Date();
                      const monthStart = startOfMonth(today);
                      setCalendarMonth(monthStart);
                      setSelectedCalendarDate(toDateKey(today));
                      void loadCalendar(activeUserId, monthStart).catch((calendarError) => {
                        setError(toErrorMessage(calendarError));
                      });
                    }}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className="ow-calendar-nav-btn"
                    aria-label="Next month"
                    onClick={() =>
                      setCalendarMonth(
                        (previous) =>
                          new Date(previous.getFullYear(), previous.getMonth() + 1, 1),
                      )
                    }
                  >
                    {"\u203A"}
                  </button>
                </div>
                <div className="ow-calendar-toolbar-copy">
                  <strong className="ow-calendar-month-label">{calendarMonthLabel}</strong>
                  <p className="ow-calendar-toolbar-meta">Outlook-style month view</p>
                </div>
                <label className="ow-calendar-timezone">
                  <span className="ow-calendar-timezone-label">Time zone</span>
                  <select
                    className="ow-calendar-timezone-select"
                    value={calendarTimeZone}
                    onChange={(event) => setCalendarTimeZone(event.target.value)}
                  >
                    {calendarTimeZoneOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="ow-calendar-layout">
                <div className="ow-calendar-grid-wrap">
                  <div className="ow-calendar-weekdays">
                    {WEEKDAY_LABELS.map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                  <div className="ow-calendar-grid">
                    {calendarGridDays.map((day) => {
                      const dayKey = toDateKey(day);
                      const dayEvents = calendarEventsByDay.get(dayKey) ?? [];
                      const isOutsideMonth = day.getMonth() !== calendarMonth.getMonth();
                      const isSelected = dayKey === selectedCalendarDate;
                      const isToday = dayKey === todayKey;

                      return (
                        <button
                          key={dayKey}
                          type="button"
                          className={`ow-calendar-day ${isOutsideMonth ? "is-muted" : ""} ${
                            isSelected ? "is-selected" : ""
                          } ${isToday ? "is-today" : ""}`}
                          aria-pressed={isSelected}
                          onClick={() => {
                            setSelectedCalendarDate(dayKey);
                            if (isOutsideMonth) {
                              setCalendarMonth(startOfMonth(day));
                            }
                          }}
                        >
                          <span className="ow-calendar-day-number">{day.getDate()}</span>
                          <div className="ow-calendar-day-events">
                            {dayEvents.slice(0, 2).map((event) => (
                              <span key={`${event.id}-${dayKey}`} className="ow-calendar-pill">
                                {event.title}
                              </span>
                            ))}
                            {dayEvents.length > 2 ? (
                              <span className="ow-calendar-more">+{dayEvents.length - 2} more</span>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <aside className="ow-calendar-agenda">
                  <div className="ow-calendar-agenda-head">
                    <p className="ow-calendar-agenda-kicker">Selected day</p>
                    <h3>
                      {new Intl.DateTimeFormat(undefined, {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                      }).format(selectedCalendarDay)}
                    </h3>
                  </div>

                  {loadingCalendar ? (
                    <p className="ow-hint">Loading calendar…</p>
                  ) : selectedCalendarDayEvents.length === 0 ? (
                    <p className="ow-hint">No events scheduled for this date.</p>
                  ) : (
                    <ul className="ow-calendar-agenda-list">
                      {selectedCalendarDayEvents.map((event) => (
                        <li key={event.id} className="ow-calendar-agenda-item">
                          <div>
                            <strong>{event.title}</strong>
                            <p>{formatCalendarTimeRange(event, calendarTimeZone)}</p>
                            {event.attendees.length > 1 ? (
                              <p className="ow-calendar-attendees">
                                {event.attendees.map((attendee) => attendee.displayName).join(", ")}
                              </p>
                            ) : null}
                          </div>
                          {event.location ? <span>{event.location}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="ow-hint">
                    Ask AI: &quot;Schedule a meeting tomorrow at 3pm&quot;, &quot;Move launch planning sync
                    to Friday&quot;, or &quot;Delete design QA review&quot;.
                  </p>
                </aside>
              </div>
            </section>
          ) : activeView === "docs" ? (
            <section className="ow-pane ow-docs-pane">
              {!workspaceSelectedFilePath ? (
                <p className="ow-hint">Select a file from Company Files to open it here.</p>
              ) : workspaceDocumentLoading ? (
                <p className="ow-hint">Loading document…</p>
              ) : (
                <>
                  {workspaceDocumentError ? (
                    <p className="ow-error" role="status" aria-live="polite">
                      {workspaceDocumentError}
                    </p>
                  ) : null}

                  {workspaceDocument ? (
                    <>
                      <div className="ow-docs-toolbar">
                        <div>
                          <p className="ow-docs-path">{workspaceDocument.path}</p>
                          <p className="ow-hint">
                            {formatFileSize(workspaceDocument.sizeBytes)} · Updated{" "}
                            {formatDate(workspaceDocument.updatedAt)}
                          </p>
                        </div>
                        {workspaceDocumentMode === "text" ? (
                          <button
                            type="button"
                            className="ow-files-refresh"
                            onClick={() => void saveWorkspaceDocument()}
                            disabled={
                              !workspaceDocumentDirty ||
                              workspaceDocumentSaving ||
                              workspaceAiApplying
                            }
                          >
                            {workspaceDocumentSaving ? "Saving…" : "Save"}
                          </button>
                        ) : null}
                      </div>

                      {workspaceDocumentMode === "text" ? (
                        <>
                          <textarea
                            className="ow-docs-editor"
                            value={workspaceDocumentContent}
                            onChange={(event) => setWorkspaceDocumentContent(event.target.value)}
                            spellCheck={false}
                            disabled={workspaceAiApplying || workspaceDocumentSaving}
                          />

                          <form className="ow-command-form" onSubmit={applyAiWorkspaceEdits}>
                            <label htmlFor="ow-doc-ai-instruction">AI edit instruction</label>
                            <textarea
                              id="ow-doc-ai-instruction"
                              rows={2}
                              value={workspaceAiInstruction}
                              onChange={(event) => setWorkspaceAiInstruction(event.target.value)}
                              placeholder="Example: tighten wording in the intro and add an action-item summary."
                              disabled={workspaceAiApplying || workspaceDocumentSaving}
                            />
                            <div className="ow-command-footer">
                              <p className="ow-hint">
                                {workspaceAiStatus ??
                                  "Scaffold mode: AI returns structured edit operations and applies them live."}
                              </p>
                              <button
                                type="submit"
                                disabled={
                                  workspaceAiApplying ||
                                  workspaceDocumentSaving ||
                                  workspaceAiInstruction.trim().length === 0
                                }
                              >
                                {workspaceAiApplying ? "Applying…" : "Apply AI Edit"}
                              </button>
                            </div>
                          </form>
                        </>
                      ) : workspaceDocumentMode === "univer" ? (
                        <WorkspaceUniverEditor
                          userId={activeUserId}
                          filePath={workspaceDocument.path}
                          extension={workspaceDocument.extension}
                          version={workspaceDocument.version}
                          onSaved={handleUniverDocumentSaved}
                        />
                      ) : workspaceDocumentMode === "pdf" ? (
                        <>
                          <p className="ow-hint">
                            {workspaceDocument.message ?? "PDF files are preview-only in this workspace."}
                          </p>
                          {workspaceDocumentRawUrl ? (
                            <iframe
                              className="ow-doc-preview-frame"
                              src={workspaceDocumentRawUrl}
                              title={`Preview ${workspaceDocument.name}`}
                            />
                          ) : null}
                        </>
                      ) : (
                        <>
                          <p className="ow-hint">
                            {workspaceDocument.message ??
                              "Read-only preview for this file type is limited in the current workspace view."}
                          </p>
                          {workspaceDocumentRawUrl ? (
                            <a
                              className="ow-doc-download-link"
                              href={workspaceDocumentRawUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open raw file
                            </a>
                          ) : null}
                        </>
                      )}
                    </>
                  ) : (
                    <p className="ow-hint">Select a file to preview it.</p>
                  )}
                </>
              )}
            </section>
          ) : activeView === "email" ? (
            <section className="ow-pane ow-email-pane">
              {/* Gmail-style left folder nav */}
              <nav className="ow-email-nav" aria-label="Email folders">
                <button
                  type="button"
                  className="ow-email-compose-btn"
                  onClick={() => {
                    setEmailFolder("drafts");
                    setSelectedEmailId(null);
                  }}
                >
                  <span aria-hidden="true">✎</span> Compose
                </button>
                {(["inbox", "sent", "drafts", "spam"] as EmailFolder[]).map((folder) => {
                  const count = FAKE_EMAILS.filter((e) => e.folder === folder && !e.read).length;
                  return (
                    <button
                      key={folder}
                      type="button"
                      className={`ow-email-folder-btn ${emailFolder === folder ? "is-active" : ""}`}
                      onClick={() => {
                        setEmailFolder(folder);
                        setSelectedEmailId(null);
                      }}
                    >
                      <span className="ow-email-folder-icon" aria-hidden="true">
                        {folder === "inbox" ? "📥" : folder === "sent" ? "📤" : folder === "drafts" ? "📝" : "🚫"}
                      </span>
                      <span className="ow-email-folder-label">
                        {folder.charAt(0).toUpperCase() + folder.slice(1)}
                      </span>
                      {count > 0 ? (
                        <span className="ow-email-folder-count">{count}</span>
                      ) : null}
                    </button>
                  );
                })}
                <div className="ow-email-nav-divider" />
                <button
                  type="button"
                  className={`ow-email-folder-btn ${emailFolder === "inbox" && false ? "is-active" : ""}`}
                  style={{ opacity: 0.6 }}
                >
                  <span className="ow-email-folder-icon" aria-hidden="true">⭐</span>
                  <span className="ow-email-folder-label">Starred</span>
                  <span className="ow-email-folder-count">
                    {FAKE_EMAILS.filter((e) => e.starred).length}
                  </span>
                </button>
              </nav>

              {/* Email list */}
              <div className="ow-email-list-col">
                <div className="ow-email-list-toolbar">
                  <input
                    type="search"
                    className="ow-email-search"
                    placeholder="Search mail"
                    value={emailSearchInput}
                    onChange={(event) => setEmailSearchInput(event.target.value)}
                    aria-label="Search email"
                  />
                  <span className="ow-email-list-meta">
                    {FAKE_EMAILS.filter((e) => e.folder === emailFolder).length} conversations
                  </span>
                </div>
                <ul className="ow-email-list" aria-label="Email list">
                  {FAKE_EMAILS.filter((e) => {
                    if (e.folder !== emailFolder) return false;
                    if (!emailSearchInput.trim()) return true;
                    const q = emailSearchInput.toLowerCase();
                    return (
                      e.subject.toLowerCase().includes(q) ||
                      e.from.toLowerCase().includes(q) ||
                      e.preview.toLowerCase().includes(q)
                    );
                  }).map((email) => (
                    <li key={email.id}>
                      <button
                        type="button"
                        className={`ow-email-row ${!email.read ? "is-unread" : ""} ${selectedEmailId === email.id ? "is-selected" : ""}`}
                        onClick={() => setSelectedEmailId(email.id)}
                        aria-pressed={selectedEmailId === email.id}
                      >
                        <span
                          className={`ow-email-star ${email.starred ? "is-starred" : ""}`}
                          aria-label={email.starred ? "Starred" : "Not starred"}
                        >
                          {email.starred ? "★" : "☆"}
                        </span>
                        <span className="ow-email-from">{email.from}</span>
                        <span className="ow-email-subject-preview">
                          <span className="ow-email-subject">{email.subject}</span>
                          <span className="ow-email-preview"> — {email.preview}</span>
                        </span>
                        <span className="ow-email-date">
                          {new Date(email.date).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </button>
                    </li>
                  ))}
                  {FAKE_EMAILS.filter((e) => e.folder === emailFolder).length === 0 ? (
                    <li>
                      <p className="ow-hint" style={{ padding: "24px 16px" }}>No messages in {emailFolder}.</p>
                    </li>
                  ) : null}
                </ul>
              </div>

              {/* Email detail */}
              <div className="ow-email-detail">
                {selectedEmailId ? (() => {
                  const email = FAKE_EMAILS.find((e) => e.id === selectedEmailId);
                  if (!email) return null;
                  return (
                    <>
                      <div className="ow-email-detail-head">
                        <h2 className="ow-email-detail-subject">{email.subject}</h2>
                        <div className="ow-email-detail-meta">
                          <div className="ow-email-detail-avatar" aria-hidden="true">
                            {email.from.charAt(0).toUpperCase()}
                          </div>
                          <div className="ow-email-detail-from-block">
                            <div className="ow-email-detail-from-name">
                              <strong>{email.from}</strong>
                              <span className="ow-email-detail-from-addr">&lt;{email.fromEmail}&gt;</span>
                            </div>
                            <div className="ow-email-detail-to">
                              To: {email.to}
                            </div>
                          </div>
                          <div className="ow-email-detail-date">
                            {new Date(email.date).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>
                      </div>
                      <div className="ow-email-detail-body">
                        {email.body.split("\n").map((line, index) => (
                          <p key={index} className="ow-email-body-line">
                            {line || "\u00A0"}
                          </p>
                        ))}
                      </div>
                      <div className="ow-email-reply-bar">
                        <button type="button" className="ow-email-reply-btn">↩ Reply</button>
                        <button type="button" className="ow-email-reply-btn">↪ Forward</button>
                      </div>
                    </>
                  );
                })() : (
                  <div className="ow-email-empty-detail">
                    <p className="ow-email-empty-icon" aria-hidden="true">✉</p>
                    <p>Select an email to read it</p>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="ow-pane ow-thread-pane">
              <div className="ow-thread-stream" aria-live="polite">
                {!selectedThread ? (
                  <p className="ow-hint">Select a channel or DM from the sidebar.</p>
                ) : loadingManual ? (
                  <p className="ow-hint">Loading messages…</p>
                ) : manualMessages.length === 0 ? (
                  <p className="ow-hint">No messages yet in this conversation.</p>
                ) : (
                  <ul className="ow-message-list">
                    {threadTimeline.map((item) =>
                      item.kind === "divider" ? (
                        <li key={item.id} className="ow-message-divider" role="separator">
                          <span>{item.label}</span>
                        </li>
                      ) : (
                        <li
                          key={item.id}
                          className={`ow-message-row ${item.compact ? "is-compact" : ""}`}
                        >
                          {item.compact ? (
                            <span className="ow-message-avatar-spacer" aria-hidden="true" />
                          ) : (
                            <span
                              className="ow-message-avatar"
                              style={{ backgroundColor: item.message.sender.avatarColor }}
                              aria-hidden="true"
                            >
                              {item.message.isAgentMessage
                                ? `${initialsFromName(item.message.sender.displayName)}-AI`
                                : initialsFromName(item.message.sender.displayName)}
                            </span>
                          )}
                          <div className="ow-message-content">
                            {item.compact ? null : (
                              <div className="ow-message-head">
                                <strong className="ow-message-sender">
                                  {item.message.isAgentMessage
                                    ? `${item.message.sender.displayName}'s AI`
                                    : item.message.sender.displayName}
                                </strong>
                                <span className="ow-message-time">
                                  {formatMessageTime(item.message.createdAt)}
                                </span>
                              </div>
                            )}
                            <p className="ow-message-body">{item.message.body}</p>
                          </div>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>

              <form className="ow-thread-form" onSubmit={sendManualMessage}>
                <label className="sr-only" htmlFor="ow-thread-input">
                  Message
                </label>
                <textarea
                  id="ow-thread-input"
                  value={manualBody}
                  onChange={(event) => setManualBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={3}
                  maxLength={2000}
                  placeholder={
                    selectedThread
                      ? "Write a message…"
                      : "Select a channel or DM to start messaging…"
                  }
                  disabled={!selectedThread}
                />
              </form>
            </section>
          )}
        </main>

        <aside className="ow-ai-panel" aria-label="AI Chat Panel">
          <header className="ow-ai-panel-head">
            <div>
              <p className="ow-ai-panel-kicker">Assistant</p>
              <h3 className="ow-ai-panel-title">AI Chat</h3>
            </div>
            <div className="ow-ai-panel-head-actions">
              <button
                type="button"
                className="ow-ai-new-chat"
                onClick={clearChat}
                title="New chat"
                aria-label="Start a new chat"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2" y="2" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M5 5h6M5 8h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  <path d="M11.5 10.5l2.5-2.5-1.5-1.5-2.5 2.5V11h1.5z" fill="currentColor"/>
                </svg>
              </button>
              <button
                type="button"
                className="ow-ai-panel-collapse"
                onClick={() => setAiPanelOpen(false)}
                aria-label="Hide AI Chat Panel"
              >
                {"\u203A"}
              </button>
            </div>
          </header>

          <section className="ow-pane ow-ai-pane">
            <div className="ow-ai-stream" aria-live="polite">
              {aiTimeline.length === 0 ? (
                <article className="ow-turn ow-turn-ai">
                  <p>Send a message to start chatting with your AI assistant.</p>
                </article>
              ) : (
                aiTimeline.map((item) => {
                  const isUserMessage = item.kind === "chat" && item.role === "user";
                  const messageBody = item.body;
                  const messageKey = item.kind === "chat" ? item.id : `briefing-${item.id}`;

                  const itemMentions = item.kind === "chat" ? item.mentions : undefined;

                  return (
                    <article key={messageKey} className={`ow-turn ${isUserMessage ? "ow-turn-user" : "ow-turn-ai"}`}>
                      {!isUserMessage && (
                        <div className="ow-turn-head">
                          <strong>AI</strong>
                          <span>{formatDate(item.createdAt)}</span>
                        </div>
                      )}
                      {isUserMessage && itemMentions && itemMentions.length > 0 && (
                        <div className="ow-turn-mention-pills">
                          {itemMentions.map((mention) => (
                            <span key={mentionKey(mention)} className="ow-turn-mention-pill">
                              <span className="ow-mention-chip-sigil" aria-hidden="true">
                                {mention.kind === "channel" ? "#" : mention.kind === "dm" ? "@" : mention.kind === "file" ? "↗" : mention.kind === "task" ? "✓" : "◷"}
                              </span>
                              {mentionLabel(mention)}
                            </span>
                          ))}
                        </div>
                      )}
                      <p style={{ whiteSpace: "pre-wrap" }}>{messageBody}</p>
                      {isUserMessage && <span className="ow-turn-time">{formatDate(item.createdAt)}</span>}
                    </article>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>

            <form className="ow-command-form" onSubmit={submitAgentCommand}>
              <label htmlFor="ow-command-input">Message</label>
              <div className={`ow-command-input-box${commandMentions.length > 0 ? " has-chips" : ""}`}>
                {commandMentions.length > 0 ? (
                  <div className="ow-mention-chip-list" aria-label="Attached context">
                    {commandMentions.map((mention) => (
                      <button
                        key={mentionKey(mention)}
                        type="button"
                        className="ow-mention-chip"
                        onClick={() => removeMention(mention)}
                        title="Remove context"
                      >
                        <span className="ow-mention-chip-sigil" aria-hidden="true">
                          {mention.kind === "channel" ? "#" : mention.kind === "dm" ? "@" : mention.kind === "file" ? "↗" : mention.kind === "task" ? "✓" : "◷"}
                        </span>
                        <span className="ow-mention-chip-label">{mentionLabel(mention)}</span>
                        <span className="ow-mention-chip-remove" aria-hidden="true">×</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  id="ow-command-input"
                  ref={commandInputRef}
                  value={commandInput}
                  onChange={(event) => {
                    setCommandInput(event.target.value);
                    setCommandCursor(event.target.selectionStart ?? event.target.value.length);
                  }}
                  onSelect={(event) => {
                    setCommandCursor(event.currentTarget.selectionStart ?? commandInput.length);
                  }}
                  onClick={(event) => {
                    setCommandCursor(event.currentTarget.selectionStart ?? commandInput.length);
                  }}
                  onKeyUp={(event) => {
                    setCommandCursor(event.currentTarget.selectionStart ?? commandInput.length);
                  }}
                  rows={3}
                  maxLength={2000}
                  placeholder="Tell AI what to do…"
                  disabled={commandRunning}
                  onKeyDown={(event) => {
                    if (mentionPickerOpen && mentionSuggestionsReady) {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setMentionNavIndex((previous) => (previous + 1) % mentionSuggestions.length);
                        return;
                      }

                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setMentionNavIndex((previous) =>
                          (previous - 1 + mentionSuggestions.length) % mentionSuggestions.length,
                        );
                        return;
                      }

                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        const next = mentionSuggestions[mentionNavIndex] ?? mentionSuggestions[0];
                        if (next) {
                          applyMentionSuggestion(next);
                        }
                        return;
                      }
                    }

                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
              </div>
              {mentionPickerOpen ? (
                <div className="ow-mention-picker" role="listbox" aria-label="Context suggestions">
                  {mentionSuggestionsReady ? (
                    <ul className="ow-mention-list">
                      {mentionSuggestions.map((suggestion, index) => (
                        <li key={suggestion.key}>
                          <button
                            type="button"
                            className={`ow-mention-option ${index === mentionNavIndex ? "is-active" : ""}`}
                            aria-selected={index === mentionNavIndex}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => applyMentionSuggestion(suggestion)}
                          >
                            <span className="ow-mention-option-head">
                              <span className="ow-mention-option-kind">
                                {mentionKindLabel(suggestion.kind)}
                              </span>
                              <strong>{suggestion.label}</strong>
                            </span>
                            <span className="ow-mention-option-desc">{suggestion.description}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="ow-mention-empty">
                      {mentionTrigger?.resolvedKind === "file" && workspaceMentionFilesLoading
                        ? "Indexing company files..."
                        : "No matching context found."}
                    </p>
                  )}
                </div>
              ) : null}
              <div className="ow-command-footer">
                <p className="ow-hint">
                  Mode: Auto · Sender: {activeUser?.displayName ?? "User"} + AI tag · Type @ to attach
                  context
                </p>
                <button type="submit" disabled={commandRunning || commandInput.trim().length === 0}>
                  {commandRunning ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          </section>
        </aside>

        {!aiPanelOpen && (
          <button
            type="button"
            className="ow-ai-panel-expand"
            onClick={() => setAiPanelOpen(true)}
            aria-label="Show AI Chat Panel"
          >
            {"\u2039"}
          </button>
        )}
      </div>
    </div>
  );
}
