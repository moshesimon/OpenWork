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

type WorkspaceView = "thread" | "tasks" | "calendar" | "docs";
type SidebarSection = "channels" | "dms" | "files";
type FileBadgeTone = "generic" | "pdf" | "word" | "excel" | "slides" | "text" | "image" | "archive";

type AiTimelineItem =
  | ({ kind: "chat" } & ChatMessageView)
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

  const [commandInput, setCommandInput] = useState("");
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandMentions, setCommandMentions] = useState<AgentMention[]>([]);
  const [mentionNavIndex, setMentionNavIndex] = useState(0);
  const [commandRunning, setCommandRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [manualMessages, setManualMessages] = useState<MessageView[]>([]);
  const [manualBody, setManualBody] = useState("");
  const [loadingManual, setLoadingManual] = useState(false);
  const [sendingManual, setSendingManual] = useState(false);

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
  const [profileOpen, setProfileOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const [openSidebarSections, setOpenSidebarSections] = useState<Set<SidebarSection>>(
    () => new Set(["channels", "files"]),
  );
  const loadedDirectoriesRef = useRef<Set<string>>(new Set());
  const refreshInFlightRef = useRef(false);
  const pendingRefreshUserIdRef = useRef<string | null>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLTextAreaElement>(null);
  const workspaceDocumentContentRef = useRef("");

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
      if (refreshInFlightRef.current) {
        pendingRefreshUserIdRef.current = userId;
        return;
      }

      let nextUserId: string | null = userId;
      while (nextUserId) {
        const refreshUserId = nextUserId;
        refreshInFlightRef.current = true;
        pendingRefreshUserIdRef.current = null;

        setError(null);
        try {
          await Promise.all([
            loadBootstrap(refreshUserId),
            loadBriefings(refreshUserId),
            loadChat(refreshUserId),
            loadTasks(refreshUserId),
            loadCalendar(refreshUserId, calendarMonth, { silent: true }),
          ]);

          if (
            refreshUserId === activeUserId &&
            activeView === "thread" &&
            selectedThread
          ) {
            await loadThreadMessages(selectedThread, refreshUserId);
          }

          const loadedDirectories = Array.from(loadedDirectoriesRef.current);
          const directoriesToRefresh = loadedDirectories.length > 0 ? loadedDirectories : [""];
          await Promise.all(
            directoriesToRefresh.map((directory) =>
              loadWorkspaceDirectory(directory, { force: true, userId: refreshUserId }),
            ),
          );
        } catch (refreshError) {
          setError(toErrorMessage(refreshError));
        } finally {
          refreshInFlightRef.current = false;
        }

        nextUserId = pendingRefreshUserIdRef.current;
      }
    },
    [
      activeUserId,
      activeView,
      calendarMonth,
      loadBootstrap,
      loadBriefings,
      loadCalendar,
      loadChat,
      loadTasks,
      loadThreadMessages,
      loadWorkspaceDirectory,
      selectedThread,
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

  const submitAgentCommand = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const input = commandInput.trim();
      if (!input) {
        return;
      }
      const mentions = commandMentions;
      const contextHints = buildMentionContextHints(mentions);
      const optimisticMessage: ChatMessageView = {
        id: `optimistic-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        body: input,
        taskId: null,
        createdAt: new Date().toISOString(),
      };

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

        setChatMessages((previous) => {
          const withoutOptimistic = previous.filter(
            (message) => message.id !== optimisticMessage.id,
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
        setChatMessages((previous) =>
          previous.filter((message) => message.id !== optimisticMessage.id),
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

      setSendingManual(true);
      setError(null);

      try {
        if (selectedThread.kind === "channel") {
          await apiRequest<PostMessageResponse>(
            `/api/conversations/${encodeURIComponent(selectedThread.conversationId)}/messages`,
            activeUserId,
            {
              method: "POST",
              body: JSON.stringify({ body }),
            },
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
        }

        setManualBody("");
        await openThread(selectedThread, activeUserId);
        await refreshAll(activeUserId);
      } catch (sendError) {
        setError(toErrorMessage(sendError));
      } finally {
        setSendingManual(false);
      }
    },
    [activeUserId, manualBody, openThread, refreshAll, selectedThread],
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
        setActiveUserId(userId);
        setSelectedThread(null);
        setManualMessages([]);
        setChatMessages([]);
        setCommandInput("");
        setCommandCursor(0);
        setCommandMentions([]);
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
  }, [briefings, chatMessages]);

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
  const workspaceDocumentDirty =
    workspaceDocument?.editable === true
      ? workspaceDocumentContent !== (workspaceDocument.content ?? "")
      : false;
  const workspaceSelectedLabel = workspaceSelectedFilePath
    ? workspaceSelectedFilePath.split("/").at(-1) ?? workspaceSelectedFilePath
    : null;
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

          <div className="ow-sidebar-scroll">
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
                  className={`ow-nav-item ${activeView === "docs" ? "is-active" : ""}`}
                  onClick={() => setActiveView("docs")}
                  disabled={!workspaceSelectedFilePath}
                >
                  <span className="ow-nav-item-main">
                    <span className="ow-nav-item-icon" aria-hidden="true">
                      ▣
                    </span>
                    <span className="ow-nav-item-label">Docs</span>
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
                  {dmUnreadCount > 0 ? <span className="ow-count ow-count-unread">{dmUnreadCount}</span> : null}
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
                <button
                  type="button"
                  className="ow-section-toggle"
                  onClick={() => toggleSidebarSection("files")}
                  aria-expanded={openSidebarSections.has("files")}
                >
                  <span className="ow-sidebar-label">Company Files</span>
                  <span className="ow-section-meta">
                    <span className="ow-section-total">{rootDirectoryCount}</span>
                    <span className="ow-section-caret" aria-hidden="true">
                      {openSidebarSections.has("files") ? "▾" : "▸"}
                    </span>
                  </span>
                </button>
              </div>

              {openSidebarSections.has("files") ? (
                <>
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
                      <span className="ow-side-file-chip is-directory">ROOT</span>
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
                </>
              ) : null}
            </div>
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
                        <button
                          type="button"
                          className="ow-files-refresh"
                          onClick={() => void saveWorkspaceDocument()}
                          disabled={
                            !workspaceDocument.editable ||
                            !workspaceDocumentDirty ||
                            workspaceDocumentSaving ||
                            workspaceAiApplying
                          }
                        >
                          {workspaceDocumentSaving ? "Saving…" : "Save"}
                        </button>
                      </div>

                      {!workspaceDocument.editable ? (
                        <p className="ow-hint">
                          {workspaceDocument.message ??
                            "This file can be listed, but editing requires a Univer adapter."}
                        </p>
                      ) : (
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
                      )}
                    </>
                  ) : (
                    <p className="ow-hint">Select a file to preview it.</p>
                  )}
                </>
              )}
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
                              {initialsFromName(item.message.sender.displayName)}
                            </span>
                          )}
                          <div className="ow-message-content">
                            {item.compact ? null : (
                              <div className="ow-message-head">
                                <strong className="ow-message-sender">
                                  {item.message.sender.displayName}
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
                  rows={3}
                  maxLength={2000}
                  placeholder={
                    selectedThread
                      ? "Write a message…"
                      : "Select a channel or DM to start messaging…"
                  }
                  disabled={!selectedThread || sendingManual}
                />
                <button
                  type="submit"
                  disabled={!selectedThread || sendingManual || manualBody.trim().length === 0}
                >
                  {sendingManual ? "Sending…" : "Send Message"}
                </button>
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
            <button
              type="button"
              className="ow-ai-panel-collapse"
              onClick={() => setAiPanelOpen(false)}
              aria-label="Hide AI Chat Panel"
            >
              {"\u203A"}
            </button>
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

                  return (
                    <article key={messageKey} className={`ow-turn ${isUserMessage ? "ow-turn-user" : "ow-turn-ai"}`}>
                      {!isUserMessage && (
                        <div className="ow-turn-head">
                          <strong>AI</strong>
                          <span>{formatDate(item.createdAt)}</span>
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
                      <span className="ow-mention-chip-kind">{mentionKindLabel(mention.kind)}</span>
                      <span className="ow-mention-chip-label">{mentionLabel(mention)}</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              ) : null}
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
