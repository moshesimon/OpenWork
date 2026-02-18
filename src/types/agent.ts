export type AutonomyLevel = "OFF" | "REVIEW" | "AUTO";
export type SenderMode = "USER_AI_TAG" | "AGENT_ACCOUNT";

export type AgentActionType =
  | "SEND_MESSAGE"
  | "CREATE_CHANNEL"
  | "CREATE_DM"
  | "INFORM_USER"
  | "DRAFT_SUGGESTION"
  | "LOG_ONLY";

export type AgentTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED_TIMEOUT"
  | "FAILED_ERROR";

export type AgentActionStatus = "PLANNED" | "SKIPPED" | "EXECUTED" | "FAILED";

export type BriefingStatus = "UNREAD" | "ACKED" | "DISMISSED" | "ACTED";

export type AgentActionView = {
  id: string;
  type: AgentActionType;
  status: AgentActionStatus;
  targetConversationId: string | null;
  targetUserId: string | null;
  targetChannelSlug: string | null;
  reasoning: string | null;
  confidence: number | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  executedAt: string | null;
};

export type AgentTaskView = {
  id: string;
  source: string;
  status: AgentTaskStatus;
  inputText: string;
  confidence: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  actions: AgentActionView[];
  events: {
    id: string;
    eventType: string;
    message: string;
    createdAt: string;
    actionId: string | null;
    meta: Record<string, unknown> | null;
  }[];
  deliveries: {
    id: string;
    actionId: string;
    conversationId: string;
    messageId: string;
    senderUserId: string;
    aiAttribution: string;
    createdAt: string;
  }[];
};

export type AgentMentionKind = "event" | "task" | "dm" | "channel" | "file";

export type AgentMention =
  | {
      kind: "event";
      eventId: string;
      title: string;
      startAt: string;
      endAt: string;
      allDay: boolean;
      ownerId: string;
      attendeeUserIds: string[];
    }
  | {
      kind: "task";
      taskId: string;
      title: string;
      description: string;
      urgency: TaskUrgency;
      status: TaskItemStatus;
      assigneeId: string | null;
      createdById: string;
      updatedAt: string;
    }
  | {
      kind: "dm";
      userId: string;
      displayName: string;
      conversationId: string | null;
    }
  | {
      kind: "channel";
      channelId: string;
      channelSlug: string;
      channelName: string;
      conversationId: string;
    }
  | {
      kind: "file";
      path: string;
      name: string;
    };

export type AgentCommandContextHints = {
  userIds?: string[];
  channelIds?: string[];
  conversationIds?: string[];
  taskIds?: string[];
  eventIds?: string[];
  filePaths?: string[];
};

export type AgentCommandRequest = {
  input: string;
  mode?: AutonomyLevel;
  contextHints?: AgentCommandContextHints;
  mentions?: AgentMention[];
};

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  body: string;
  taskId: string | null;
  createdAt: string;
};

export type AgentCommandResponse = {
  taskId: string;
  status: AgentTaskStatus;
  reply: string;
  messages: ChatMessageView[];
};

export type AgentProfileResponse = {
  userId: string;
  defaultAutonomyLevel: AutonomyLevel;
  senderMode: SenderMode;
  settings: Record<string, unknown>;
  relevance: {
    priorityPeople: string[];
    priorityChannels: string[];
    priorityTopics: string[];
    urgencyKeywords: string[];
    mutedTopics: string[];
  };
  policies: {
    id: string;
    scopeType: string;
    scopeKey: string;
    autonomyLevel: AutonomyLevel;
  }[];
  updatedAt: string;
};

export type BriefingItemView = {
  id: string;
  importance: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  title: string;
  summary: string;
  status: BriefingStatus;
  createdAt: string;
  readAt: string | null;
  sourceConversationId: string | null;
  sourceMessageIds: string[];
  recommendedAction: Record<string, unknown> | null;
};

export type BriefingsResponse = {
  items: BriefingItemView[];
};

export type AgentPolicyInput = {
  scopeType: string;
  scopeKey: string;
  autonomyLevel: AutonomyLevel;
};

export type TaskUrgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type TaskItemStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export type WorkspaceTaskView = {
  id: string;
  title: string;
  description: string;
  urgency: TaskUrgency;
  status: TaskItemStatus;
  sortRank: number;
  deadline: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type TasksResponse = {
  items: WorkspaceTaskView[];
};

export type CalendarEventView = {
  id: string;
  ownerId: string;
  createdById: string;
  createdByName: string;
  attendeeUserIds: string[];
  attendees: {
    id: string;
    displayName: string;
  }[];
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CalendarEventsResponse = {
  items: CalendarEventView[];
};

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
};

export type WorkspaceFilesResponse = {
  rootLabel: string;
  directory: string;
  items: WorkspaceFileEntry[];
};

export type WorkspaceTextEditOperation =
  | {
      type: "replace_range";
      start: number;
      end: number;
      text: string;
    }
  | {
      type: "insert";
      offset: number;
      text: string;
    }
  | {
      type: "delete_range";
      start: number;
      end: number;
    };

export type WorkspaceDocumentReadResponse = {
  path: string;
  name: string;
  extension: string;
  editable: boolean;
  content: string | null;
  sizeBytes: number;
  updatedAt: string;
  version: string;
  message: string | null;
};

export type WorkspaceDocumentSaveResponse = {
  path: string;
  sizeBytes: number;
  updatedAt: string;
  version: string;
};

export type WorkspaceDocumentAiEditRequest = {
  path: string;
  instruction: string;
  content: string;
  baseVersion?: string;
  autoSave?: boolean;
  selection?: {
    start: number;
    end: number;
  };
};

export type WorkspaceDocumentAiEditEvent =
  | {
      event: "ready";
      path: string;
      version: string;
    }
  | {
      event: "operation";
      operation: WorkspaceTextEditOperation;
      index: number;
      total: number;
    }
  | {
      event: "saved";
      version: string;
      sizeBytes: number;
      updatedAt: string;
    }
  | {
      event: "done";
      summary: string;
      operations: number;
    }
  | {
      event: "error";
      message: string;
    };
