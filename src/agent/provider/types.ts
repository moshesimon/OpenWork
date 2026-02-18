import type { ZodTypeAny } from "zod";
import type { AgentCommandContextHints } from "@/types/agent";

export type ContextHints = AgentCommandContextHints;

export type AgentContextPack = {
  activeUser: {
    id: string;
    displayName: string;
  };
  users: { id: string; displayName: string }[];
  channels: {
    id: string;
    slug: string;
    name: string;
    conversationId: string;
  }[];
  recentMessages: {
    id: string;
    conversationId: string;
    senderId: string;
    body: string;
    createdAt: string;
  }[];
  chatHistory: { role: "user" | "assistant"; body: string }[];
  calendarEvents: {
    id: string;
    ownerId: string;
    createdById: string;
    attendeeUserIds: string[];
    title: string;
    description: string;
    location: string;
    startAt: string;
    endAt: string;
    allDay: boolean;
  }[];
  recentBriefings: {
    id: string;
    title: string;
    summary: string;
    importance: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    status: "UNREAD" | "ACKED" | "DISMISSED" | "ACTED";
    sourceConversationId: string | null;
    sourceMessageIds: string[];
    createdAt: string;
  }[];
  relevanceProfile: {
    priorityPeople: string[];
    priorityChannels: string[];
    priorityTopics: string[];
    urgencyKeywords: string[];
    mutedTopics: string[];
  };
};

export type IntentKind =
  | "inform"
  | "ask"
  | "follow_up"
  | "summarize"
  | "respond"
  | "create_task"
  | "update_task"
  | "create_calendar_event"
  | "update_calendar_event"
  | "delete_calendar_event"
  | "query_calendar";

export type CalendarIntentPayload = {
  eventId: string | null;
  title: string | null;
  description: string | null;
  location: string | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean | null;
  rangeStart: string | null;
  rangeEnd: string | null;
};

export type IntentClassification = {
  intent: IntentKind;
  summary: string;
  confidence: number;
  targetUserIds: string[];
  targetChannelSlugs: string[];
  topic: string | null;
  urgency: "low" | "medium" | "high";
  calendar: CalendarIntentPayload | null;
};

export type RelevanceInput = {
  sourceConversationId: string;
  sourceMessageId: string;
  sourceSenderId: string;
  messageBody: string;
  isDm: boolean;
};

export type RelevanceScore = {
  llmScore: number;
  confidence: number;
  rationale: string;
};

export type DraftRequest = {
  input: string;
  summary: string;
  audienceLabel: string;
  intent: IntentKind;
  topic: string | null;
};

export type DraftResult = {
  body: string;
  confidence: number;
  rationale: string;
};

export type BriefingSummaryRequest = {
  titleHint: string;
  rawItems: string[];
};

export type BriefingSummaryResult = {
  title: string;
  summary: string;
  importance: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  recommendedAction: Record<string, unknown> | null;
};

export type AgentTurnMessage = {
  role: "system" | "user" | "assistant";
  body: string;
};

export type AgentTurnInput = {
  message: string;
  history: AgentTurnMessage[];
  relevantContext: string;
  systemPrompt?: string;
  maxSteps?: number;
  tools?: AgentRuntimeTool[];
};

export type AgentTurnResult = {
  text: string;
};

export type AgentRuntimeTool = {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  execute: (input: unknown) => Promise<unknown>;
};

export interface AgentProvider {
  readonly name: string;
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}
