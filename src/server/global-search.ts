import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { ConversationType, Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import { listCalendarEvents } from "@/server/calendar-service";
import {
  isEditableTextDocumentFile,
  resolveWorkspacePath,
  shouldIncludeDirectory,
  WORKSPACE_ROOT,
} from "@/server/workspace-files";

type DbClient = PrismaClient | Prisma.TransactionClient;

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 180;

const MAX_FILE_SCAN_DIRECTORIES = 300;
const MAX_FILE_SCAN_RESULTS = 240;
const MAX_FILE_CONTENT_READS = 80;
const MAX_FILE_CONTENT_BYTES = 280_000;

type SearchSource =
  | "native"
  | "chatindex-service"
  | "pageindex-service"
  | "officeindex-service";

type SearchResultKind = "channel" | "dm" | "message" | "file" | "task" | "event" | "user";

export type GlobalSearchHighlightRange = {
  start: number;
  end: number;
};

export type GlobalSearchHighlights = {
  title?: GlobalSearchHighlightRange[];
  subtitle?: GlobalSearchHighlightRange[];
  snippet?: GlobalSearchHighlightRange[];
};

export type GlobalSearchResult = {
  id: string;
  kind: SearchResultKind;
  source: SearchSource;
  score: number;
  title: string;
  subtitle: string;
  snippet: string | null;
  createdAt: string | null;
  conversationId: string | null;
  threadKind: "channel" | "dm" | null;
  channelSlug: string | null;
  channelName: string | null;
  otherUserId: string | null;
  otherUserName: string | null;
  messageId: string | null;
  filePath: string | null;
  taskId: string | null;
  eventId: string | null;
  eventStartAt: string | null;
  userId: string | null;
  highlights?: GlobalSearchHighlights;
};

export type GlobalSearchResponse = {
  query: string;
  total: number;
  tookMs: number;
  providers: {
    chat: string;
    files: string;
  };
  results: GlobalSearchResult[];
};

export type GlobalSearchInput = {
  query: string;
  limit?: number;
};

const HIGHLIGHT_FIELDS = ["title", "subtitle", "snippet"] as const;
type HighlightField = (typeof HIGHLIGHT_FIELDS)[number];

const AUTO_HIGHLIGHT_FIELDS_BY_KIND: Record<SearchResultKind, HighlightField[]> = {
  channel: ["title", "snippet"],
  dm: ["title", "snippet"],
  message: ["title", "snippet"],
  file: ["title", "snippet"],
  task: [],
  event: ["title", "subtitle", "snippet"],
  user: [],
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseHighlightNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function parseHighlightRange(value: unknown): GlobalSearchHighlightRange | null {
  if (Array.isArray(value) && value.length >= 2) {
    const start = parseHighlightNumber(value[0]);
    const end = parseHighlightNumber(value[1]);
    if (start === null || end === null) {
      return null;
    }

    return { start, end };
  }

  if (!isRecord(value)) {
    return null;
  }

  const start =
    parseHighlightNumber(value.start) ??
    parseHighlightNumber(value.from) ??
    parseHighlightNumber(value.offset);
  const directEnd = parseHighlightNumber(value.end) ?? parseHighlightNumber(value.to);
  const length = parseHighlightNumber(value.length);
  const end = directEnd ?? (start !== null && length !== null ? start + length : null);
  if (start === null || end === null) {
    return null;
  }

  return { start, end };
}

function normalizeHighlightRanges(
  ranges: GlobalSearchHighlightRange[],
  textLength: number,
): GlobalSearchHighlightRange[] {
  if (ranges.length === 0 || textLength <= 0) {
    return [];
  }

  const normalized = ranges
    .map((range) => {
      const start = Math.max(0, Math.min(textLength, Math.floor(range.start)));
      const end = Math.max(0, Math.min(textLength, Math.ceil(range.end)));
      if (end <= start) {
        return null;
      }

      return { start, end };
    })
    .filter((range): range is GlobalSearchHighlightRange => Boolean(range))
    .sort((left, right) => (left.start === right.start ? left.end - right.end : left.start - right.start));

  if (normalized.length === 0) {
    return [];
  }

  const merged: GlobalSearchHighlightRange[] = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }

    last.end = Math.max(last.end, range.end);
  }

  return merged;
}

function parseExternalHighlightField(
  value: unknown,
  text: string | null,
): GlobalSearchHighlightRange[] | undefined {
  if (!text) {
    return undefined;
  }

  const values = Array.isArray(value) ? value : [value];
  const parsedRanges = values
    .map((entry) => parseHighlightRange(entry))
    .filter((entry): entry is GlobalSearchHighlightRange => Boolean(entry));
  const normalized = normalizeHighlightRanges(parsedRanges, text.length);
  return normalized.length > 0 ? normalized : undefined;
}

function parseExternalHighlights(
  item: Record<string, unknown>,
  text: {
    title: string;
    subtitle: string;
    snippet: string | null;
  },
): GlobalSearchHighlights | undefined {
  const raw = isRecord(item.highlights)
    ? item.highlights
    : isRecord(item.highlight)
      ? item.highlight
      : null;
  if (!raw) {
    return undefined;
  }

  const titleRanges = parseExternalHighlightField(raw.title, text.title);
  const subtitleRanges = parseExternalHighlightField(raw.subtitle, text.subtitle);
  const snippetRanges = parseExternalHighlightField(raw.snippet, text.snippet);
  if (!titleRanges && !subtitleRanges && !snippetRanges) {
    return undefined;
  }

  return {
    ...(titleRanges ? { title: titleRanges } : {}),
    ...(subtitleRanges ? { subtitle: subtitleRanges } : {}),
    ...(snippetRanges ? { snippet: snippetRanges } : {}),
  };
}

function parseSearchLimit(rawLimit: number | undefined): number {
  if (!Number.isFinite(rawLimit)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(Math.floor(rawLimit ?? DEFAULT_LIMIT), MAX_LIMIT));
}

function parseSearchQuery(rawQuery: string): string {
  const query = rawQuery.trim();
  if (!query) {
    throw new ApiError(400, "INVALID_QUERY", "Search query is required.");
  }

  if (query.length < MIN_QUERY_LENGTH) {
    throw new ApiError(
      400,
      "INVALID_QUERY",
      `Search query must be at least ${MIN_QUERY_LENGTH} characters.`,
    );
  }

  return query.slice(0, MAX_QUERY_LENGTH);
}

export function scoreTextMatch(haystack: string, needleLower: string): number {
  if (!haystack) {
    return 0;
  }

  const value = haystack.toLowerCase();
  if (value === needleLower) {
    return 220;
  }

  if (value.startsWith(needleLower)) {
    return 170;
  }

  const index = value.indexOf(needleLower);
  if (index === -1) {
    return 0;
  }

  const earlyBonus = Math.max(0, 40 - Math.floor(index / 4));
  return 120 + earlyBonus;
}

export function extractSearchSnippet(text: string, needleLower: string, radius = 90): string | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  const index = lower.indexOf(needleLower);
  if (index === -1) {
    const fallback = normalized.slice(0, radius * 2);
    return normalized.length > fallback.length ? `${fallback}…` : fallback;
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(normalized.length, index + needleLower.length + radius);
  const snippet = normalized.slice(start, end).trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  return `${prefix}${snippet}${suffix}`;
}

export function findTextMatchRanges(
  text: string,
  needleLower: string,
): GlobalSearchHighlightRange[] {
  if (!text) {
    return [];
  }

  const query = needleLower.trim().toLowerCase();
  if (!query) {
    return [];
  }

  const haystack = text.toLowerCase();
  const ranges: GlobalSearchHighlightRange[] = [];
  let cursor = 0;

  while (cursor < haystack.length) {
    const index = haystack.indexOf(query, cursor);
    if (index === -1) {
      break;
    }

    ranges.push({
      start: index,
      end: index + query.length,
    });
    cursor = index + Math.max(query.length, 1);
  }

  return normalizeHighlightRanges(ranges, text.length);
}

function getHighlightFieldValue(
  result: GlobalSearchResult,
  field: HighlightField,
): string | null {
  if (field === "title") {
    return result.title;
  }

  if (field === "subtitle") {
    return result.subtitle;
  }

  return result.snippet;
}

function withAutoHighlights(
  result: GlobalSearchResult,
  needleLower: string,
): GlobalSearchResult {
  const fields = AUTO_HIGHLIGHT_FIELDS_BY_KIND[result.kind];
  if (fields.length === 0) {
    return result;
  }

  const highlights: GlobalSearchHighlights = {};
  for (const field of fields) {
    const text = getHighlightFieldValue(result, field);
    if (!text) {
      continue;
    }

    const mergedRanges = normalizeHighlightRanges(
      [...(result.highlights?.[field] ?? []), ...findTextMatchRanges(text, needleLower)],
      text.length,
    );
    if (mergedRanges.length === 0) {
      continue;
    }

    highlights[field] = mergedRanges;
  }

  if (Object.keys(highlights).length === 0) {
    if (!result.highlights) {
      return result;
    }

    return {
      ...result,
      highlights: undefined,
    };
  }

  return {
    ...result,
    highlights,
  };
}

function resultKey(result: GlobalSearchResult): string {
  if (result.kind === "channel") {
    return `channel:${result.conversationId ?? result.channelSlug ?? result.id}`;
  }
  if (result.kind === "dm") {
    return `dm:${result.otherUserId ?? result.conversationId ?? result.id}`;
  }
  if (result.kind === "message") {
    return `message:${result.messageId ?? result.id}`;
  }
  if (result.kind === "file") {
    return `file:${result.filePath ?? result.id}`;
  }
  if (result.kind === "task") {
    return `task:${result.taskId ?? result.id}`;
  }
  if (result.kind === "event") {
    return `event:${result.eventId ?? result.id}`;
  }
  return `user:${result.userId ?? result.id}`;
}

function dedupeResults(results: GlobalSearchResult[]): GlobalSearchResult[] {
  const bestByKey = new Map<string, GlobalSearchResult>();

  for (const result of results) {
    const key = resultKey(result);
    const current = bestByKey.get(key);
    if (!current || result.score > current.score) {
      bestByKey.set(key, result);
    }
  }

  return Array.from(bestByKey.values());
}

function sortResults(results: GlobalSearchResult[]): GlobalSearchResult[] {
  return results.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function parseExternalItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }

  if (!isRecord(payload)) {
    return [];
  }

  const candidate = payload.results ?? payload.items ?? payload.hits;
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter(isRecord);
}

async function postJsonWithTimeout(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 3_500,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function mapExternalChatResult(
  item: Record<string, unknown>,
  needleLower: string,
): GlobalSearchResult | null {
  const kindRaw = (asString(item.kind) ?? asString(item.type) ?? "message").toLowerCase();
  const kind =
    kindRaw === "channel" || kindRaw === "dm" || kindRaw === "message"
      ? (kindRaw as "channel" | "dm" | "message")
      : "message";
  const id =
    asString(item.id) ??
    asString(item.messageId) ??
    asString(item.conversationId) ??
    asString(item.userId);
  if (!id) {
    return null;
  }

  const title =
    asString(item.title) ??
    asString(item.name) ??
    asString(item.channelName) ??
    asString(item.otherUserName) ??
    (kind === "channel" ? "Channel result" : kind === "dm" ? "DM result" : "Message result");
  const subtitle = asString(item.subtitle) ?? "ChatIndex result";
  const snippet =
    asString(item.snippet) ??
    asString(item.preview) ??
    asString(item.body) ??
    asString(item.summary) ??
    null;
  const createdAt = asString(item.createdAt) ?? null;

  const baseScore =
    asNumber(item.score) ??
    Math.max(
      scoreTextMatch(title, needleLower),
      snippet ? scoreTextMatch(snippet, needleLower) : 0,
    );

  return {
    id: `chatidx:${id}`,
    kind,
    source: "chatindex-service",
    score: baseScore + 12,
    title,
    subtitle,
    snippet: snippet ? extractSearchSnippet(snippet, needleLower) : null,
    createdAt,
    conversationId: asString(item.conversationId) ?? null,
    threadKind:
      kind === "channel" ? "channel" : kind === "dm" ? "dm" : (asString(item.threadKind) as "channel" | "dm" | null) ?? null,
    channelSlug: asString(item.channelSlug) ?? null,
    channelName: asString(item.channelName) ?? null,
    otherUserId: asString(item.otherUserId) ?? null,
    otherUserName: asString(item.otherUserName) ?? null,
    messageId: asString(item.messageId) ?? (kind === "message" ? id : null),
    filePath: null,
    taskId: null,
    eventId: null,
    eventStartAt: null,
    userId: null,
  };
}

function mapExternalFileResult(
  item: Record<string, unknown>,
  needleLower: string,
  source: "pageindex-service" | "officeindex-service",
): GlobalSearchResult | null {
  const filePath =
    asString(item.filePath) ??
    asString(item.path) ??
    asString(item.documentPath) ??
    asString(item.document_id);
  if (!filePath) {
    return null;
  }

  const fileName = path.basename(filePath);
  const title = asString(item.title) ?? (fileName || "File result");
  const subtitle = asString(item.subtitle) ?? filePath;
  const snippet =
    asString(item.snippet) ??
    asString(item.preview) ??
    asString(item.summary) ??
    asString(item.content) ??
    null;
  const baseScore =
    asNumber(item.score) ??
    Math.max(
      scoreTextMatch(filePath, needleLower),
      snippet ? scoreTextMatch(snippet, needleLower) : 0,
      scoreTextMatch(title, needleLower),
    );

  return {
    id: `${source === "officeindex-service" ? "officeidx" : "pageidx"}:${filePath}`,
    kind: "file",
    source,
    score: baseScore + 12,
    title,
    subtitle,
    snippet: snippet ? extractSearchSnippet(snippet, needleLower) : null,
    createdAt: null,
    conversationId: null,
    threadKind: null,
    channelSlug: null,
    channelName: null,
    otherUserId: null,
    otherUserName: null,
    messageId: null,
    filePath,
    taskId: null,
    eventId: null,
    eventStartAt: null,
    userId: null,
  };
}

async function searchChatExternal(
  query: string,
  userId: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const endpoint = process.env.CHATINDEX_SEARCH_URL?.trim();
  if (!endpoint) {
    return [];
  }

  const payload = await postJsonWithTimeout(endpoint, { query, userId, limit });
  if (!payload) {
    return [];
  }

  const needleLower = query.toLowerCase();
  return parseExternalItems(payload)
    .map((item) => mapExternalChatResult(item, needleLower))
    .filter((item): item is GlobalSearchResult => Boolean(item))
    .slice(0, limit);
}

async function searchPageFilesExternal(query: string, limit: number): Promise<GlobalSearchResult[]> {
  const endpoint = process.env.PAGEINDEX_SEARCH_URL?.trim();
  if (!endpoint) {
    return [];
  }

  const payload = await postJsonWithTimeout(endpoint, {
    query,
    limit,
    workspaceRoot: WORKSPACE_ROOT,
  });
  if (!payload) {
    return [];
  }

  const needleLower = query.toLowerCase();
  return parseExternalItems(payload)
    .map((item) => mapExternalFileResult(item, needleLower, "pageindex-service"))
    .filter((item): item is GlobalSearchResult => Boolean(item))
    .slice(0, limit);
}

async function searchOfficeFilesExternal(query: string, limit: number): Promise<GlobalSearchResult[]> {
  const endpoint = process.env.OFFICEINDEX_SEARCH_URL?.trim();
  if (!endpoint) {
    return [];
  }

  const payload = await postJsonWithTimeout(endpoint, {
    query,
    limit,
    workspaceRoot: WORKSPACE_ROOT,
  });
  if (!payload) {
    return [];
  }

  const needleLower = query.toLowerCase();
  return parseExternalItems(payload)
    .map((item) => mapExternalFileResult(item, needleLower, "officeindex-service"))
    .filter((item): item is GlobalSearchResult => Boolean(item))
    .slice(0, limit);
}

async function searchChannelsNative(
  db: DbClient,
  query: string,
  needleLower: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const rows = await db.conversation.findMany({
    where: {
      type: ConversationType.CHANNEL,
      OR: [
        {
          channel: {
            is: {
              name: { contains: query },
            },
          },
        },
        {
          channel: {
            is: {
              slug: { contains: query },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      createdAt: true,
      channel: {
        select: {
          name: true,
          slug: true,
        },
      },
    },
    take: limit,
    orderBy: [{ createdAt: "desc" }],
  });

  return rows
    .filter((row) => row.channel)
    .map((row) => {
      const channel = row.channel!;
      const score = Math.max(
        scoreTextMatch(channel.name, needleLower),
        scoreTextMatch(channel.slug, needleLower),
      );

      return {
        id: `channel:${row.id}`,
        kind: "channel",
        source: "native",
        score: score + 50,
        title: `#${channel.name}`,
        subtitle: `Channel · ${channel.slug}`,
        snippet: null,
        createdAt: row.createdAt.toISOString(),
        conversationId: row.id,
        threadKind: "channel",
        channelSlug: channel.slug,
        channelName: channel.name,
        otherUserId: null,
        otherUserName: null,
        messageId: null,
        filePath: null,
        taskId: null,
        eventId: null,
        eventStartAt: null,
        userId: null,
      } satisfies GlobalSearchResult;
    });
}

async function searchDmsNative(
  db: DbClient,
  userId: string,
  needleLower: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const rows = await db.conversation.findMany({
    where: {
      type: ConversationType.DM,
      OR: [{ dmUserAId: userId }, { dmUserBId: userId }],
    },
    select: {
      id: true,
      createdAt: true,
      dmUserAId: true,
      dmUserBId: true,
      dmUserA: {
        select: {
          id: true,
          displayName: true,
        },
      },
      dmUserB: {
        select: {
          id: true,
          displayName: true,
        },
      },
    },
    take: 500,
  });

  const results: GlobalSearchResult[] = [];
  for (const row of rows) {
    const otherUser =
      row.dmUserAId === userId
        ? row.dmUserB
        : row.dmUserBId === userId
          ? row.dmUserA
          : null;
    if (!otherUser) {
      continue;
    }

    const score = Math.max(
      scoreTextMatch(otherUser.displayName, needleLower),
      scoreTextMatch(otherUser.id, needleLower),
    );
    if (score === 0) {
      continue;
    }

    results.push({
      id: `dm:${row.id}`,
      kind: "dm",
      source: "native",
      score: score + 44,
      title: otherUser.displayName,
      subtitle: "Direct message",
      snippet: null,
      createdAt: row.createdAt.toISOString(),
      conversationId: row.id,
      threadKind: "dm",
      channelSlug: null,
      channelName: null,
      otherUserId: otherUser.id,
      otherUserName: otherUser.displayName,
      messageId: null,
      filePath: null,
      taskId: null,
      eventId: null,
      eventStartAt: null,
      userId: null,
    });
  }

  return results.slice(0, limit);
}

async function searchMessagesNative(
  db: DbClient,
  userId: string,
  query: string,
  needleLower: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const rows = await db.message.findMany({
    where: {
      body: { contains: query },
      conversation: {
        is: {
          OR: [
            { type: ConversationType.CHANNEL },
            {
              AND: [
                { type: ConversationType.DM },
                {
                  OR: [{ dmUserAId: userId }, { dmUserBId: userId }],
                },
              ],
            },
          ],
        },
      },
    },
    select: {
      id: true,
      conversationId: true,
      body: true,
      createdAt: true,
      sender: {
        select: {
          id: true,
          displayName: true,
        },
      },
      conversation: {
        select: {
          type: true,
          channel: {
            select: {
              name: true,
              slug: true,
            },
          },
          dmUserAId: true,
          dmUserBId: true,
          dmUserA: {
            select: {
              id: true,
              displayName: true,
            },
          },
          dmUserB: {
            select: {
              id: true,
              displayName: true,
            },
          },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });

  const results: GlobalSearchResult[] = [];
  for (const row of rows) {
    const snippet = extractSearchSnippet(row.body, needleLower);
    const bodyScore = scoreTextMatch(row.body, needleLower);
    if (bodyScore === 0) {
      continue;
    }

    const createdAt = row.createdAt.toISOString();
    if (row.conversation.type === ConversationType.CHANNEL) {
      const channelName = row.conversation.channel?.name ?? "channel";
      const channelSlug = row.conversation.channel?.slug ?? "";
      results.push({
        id: `message:${row.id}`,
        kind: "message",
        source: "native",
        score: bodyScore + 30,
        title: `${row.sender.displayName} in #${channelName}`,
        subtitle: `Channel message · ${new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(row.createdAt)}`,
        snippet,
        createdAt,
        conversationId: row.conversationId,
        threadKind: "channel",
        channelSlug,
        channelName,
        otherUserId: null,
        otherUserName: null,
        messageId: row.id,
        filePath: null,
        taskId: null,
        eventId: null,
        eventStartAt: null,
        userId: null,
      });
      continue;
    }

    const otherUser =
      row.conversation.dmUserAId === userId
        ? row.conversation.dmUserB
        : row.conversation.dmUserBId === userId
          ? row.conversation.dmUserA
          : null;
    const otherName = otherUser?.displayName ?? "DM";

    results.push({
      id: `message:${row.id}`,
      kind: "message",
      source: "native",
      score: bodyScore + 30,
      title: `${row.sender.displayName} in DM with ${otherName}`,
      subtitle: `Direct message · ${new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(row.createdAt)}`,
      snippet,
      createdAt,
      conversationId: row.conversationId,
      threadKind: "dm",
      channelSlug: null,
      channelName: null,
      otherUserId: otherUser?.id ?? null,
      otherUserName: otherUser?.displayName ?? null,
      messageId: row.id,
      filePath: null,
      taskId: null,
      eventId: null,
      eventStartAt: null,
      userId: null,
    });
  }

  return results;
}

async function searchChatNative(
  db: DbClient,
  userId: string,
  query: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const needleLower = query.toLowerCase();
  const channelLimit = Math.min(10, Math.max(4, Math.floor(limit / 3)));
  const dmLimit = Math.min(10, Math.max(4, Math.floor(limit / 4)));
  const messageLimit = Math.max(10, Math.floor(limit * 1.8));

  const [channelResults, dmResults, messageResults] = await Promise.all([
    searchChannelsNative(db, query, needleLower, channelLimit),
    searchDmsNative(db, userId, needleLower, dmLimit),
    searchMessagesNative(db, userId, query, needleLower, messageLimit),
  ]);

  return sortResults(dedupeResults([...channelResults, ...dmResults, ...messageResults])).slice(0, limit);
}

async function searchUsersNative(
  db: DbClient,
  userId: string,
  query: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const needleLower = query.toLowerCase();
  const rows = await db.user.findMany({
    where: {
      OR: [{ displayName: { contains: query } }, { id: { contains: query } }],
    },
    select: {
      id: true,
      displayName: true,
    },
    orderBy: [{ displayName: "asc" }],
    take: limit,
  });

  const results: GlobalSearchResult[] = [];
  for (const row of rows) {
    if (row.id === userId) {
      continue;
    }

    const score =
      Math.max(scoreTextMatch(row.displayName, needleLower), scoreTextMatch(row.id, needleLower)) + 14;
    if (score <= 14) {
      continue;
    }

    results.push({
      id: `user:${row.id}`,
      kind: "user",
      source: "native",
      score,
      title: row.displayName,
      subtitle: `User · ${row.id}`,
      snippet: null,
      createdAt: null,
      conversationId: null,
      threadKind: null,
      channelSlug: null,
      channelName: null,
      otherUserId: null,
      otherUserName: null,
      messageId: null,
      filePath: null,
      taskId: null,
      eventId: null,
      eventStartAt: null,
      userId: row.id,
    });
  }

  return results;
}

async function searchTasksNative(
  db: DbClient,
  query: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const needleLower = query.toLowerCase();
  const rows = await db.workspaceTask.findMany({
    where: {
      OR: [{ title: { contains: query } }, { description: { contains: query } }],
    },
    select: {
      id: true,
      title: true,
      description: true,
      urgency: true,
      status: true,
      updatedAt: true,
    },
    orderBy: [{ updatedAt: "desc" }],
    take: limit,
  });

  return rows.map((row) => {
    const titleScore = scoreTextMatch(row.title, needleLower);
    const descriptionScore = scoreTextMatch(row.description, needleLower);
    return {
      id: `task:${row.id}`,
      kind: "task",
      source: "native",
      score: Math.max(titleScore + 34, descriptionScore + 18),
      title: row.title.trim() || "Untitled task",
      subtitle: `Task · ${row.status.replace("_", " ").toLowerCase()} · ${row.urgency.toLowerCase()} urgency`,
      snippet: extractSearchSnippet(row.description, needleLower),
      createdAt: row.updatedAt.toISOString(),
      conversationId: null,
      threadKind: null,
      channelSlug: null,
      channelName: null,
      otherUserId: null,
      otherUserName: null,
      messageId: null,
      filePath: null,
      taskId: row.id,
      eventId: null,
      eventStartAt: null,
      userId: null,
    } satisfies GlobalSearchResult;
  });
}

async function searchEventsNative(
  db: DbClient,
  userId: string,
  query: string,
  limit: number,
): Promise<GlobalSearchResult[]> {
  const needleLower = query.toLowerCase();
  const payload = await listCalendarEvents(db, userId, {
    search: query,
    limit,
  });

  return payload.items.map((event) => {
    const titleScore = scoreTextMatch(event.title, needleLower);
    const descriptionScore = scoreTextMatch(event.description, needleLower);
    const locationScore = scoreTextMatch(event.location, needleLower);
    const score = Math.max(titleScore + 30, descriptionScore + 16, locationScore + 16);

    return {
      id: `event:${event.id}`,
      kind: "event",
      source: "native",
      score,
      title: event.title.trim() || "Untitled event",
      subtitle: event.location
        ? `Calendar · ${event.location}`
        : "Calendar event",
      snippet: extractSearchSnippet(
        `${event.description} ${event.location}`.trim(),
        needleLower,
      ),
      createdAt: event.updatedAt,
      conversationId: null,
      threadKind: null,
      channelSlug: null,
      channelName: null,
      otherUserId: null,
      otherUserName: null,
      messageId: null,
      filePath: null,
      taskId: null,
      eventId: event.id,
      eventStartAt: event.startAt,
      userId: null,
    } satisfies GlobalSearchResult;
  });
}

async function searchFilesNative(query: string, limit: number): Promise<GlobalSearchResult[]> {
  const needleLower = query.toLowerCase();
  const queue: string[] = [""];
  const visited = new Set<string>();
  const results: GlobalSearchResult[] = [];
  let contentReads = 0;

  while (queue.length > 0 && visited.size < MAX_FILE_SCAN_DIRECTORIES) {
    const directory = queue.shift();
    if (directory === undefined || visited.has(directory)) {
      continue;
    }

    visited.add(directory);
    const absoluteDirectoryPath = resolveWorkspacePath(directory);

    let entries: Dirent<string>[];
    try {
      entries = await readdir(absoluteDirectoryPath, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldIncludeDirectory(entry.name)) {
          queue.push(directory ? `${directory}/${entry.name}` : entry.name);
        }
        continue;
      }

      if (!entry.isFile() || entry.name.startsWith(".") || entry.name.startsWith("~$")) {
        continue;
      }

      const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
      const pathScore = Math.max(
        scoreTextMatch(relativePath, needleLower),
        scoreTextMatch(entry.name, needleLower),
      );

      let contentScore = 0;
      let snippet: string | null = null;
      if (pathScore === 0 && isEditableTextDocumentFile(entry.name) && contentReads < MAX_FILE_CONTENT_READS) {
        const absoluteFilePath = resolveWorkspacePath(relativePath);
        try {
          const fileStats = await stat(absoluteFilePath);
          if (fileStats.isFile() && fileStats.size <= MAX_FILE_CONTENT_BYTES) {
            const content = await readFile(absoluteFilePath, "utf8");
            contentReads += 1;
            contentScore = scoreTextMatch(content, needleLower);
            if (contentScore > 0) {
              snippet = extractSearchSnippet(content, needleLower);
            }
          }
        } catch {
          // Ignore unreadable files.
        }
      }

      if (pathScore === 0 && contentScore === 0) {
        continue;
      }

      results.push({
        id: `file:${relativePath}`,
        kind: "file",
        source: "native",
        score: Math.max(pathScore + 40, contentScore + 16),
        title: entry.name,
        subtitle: relativePath,
        snippet,
        createdAt: null,
        conversationId: null,
        threadKind: null,
        channelSlug: null,
        channelName: null,
        otherUserId: null,
        otherUserName: null,
        messageId: null,
        filePath: relativePath,
        taskId: null,
        eventId: null,
        eventStartAt: null,
        userId: null,
      });

      if (results.length >= MAX_FILE_SCAN_RESULTS) {
        break;
      }
    }

    if (results.length >= MAX_FILE_SCAN_RESULTS) {
      break;
    }
  }

  return sortResults(results).slice(0, limit);
}

async function searchChatWithProvider(
  db: DbClient,
  userId: string,
  query: string,
  limit: number,
): Promise<{ provider: string; results: GlobalSearchResult[] }> {
  const [external, native] = await Promise.all([
    searchChatExternal(query, userId, limit),
    searchChatNative(db, userId, query, limit),
  ]);

  if (external.length > 0) {
    return {
      provider: "chatindex-service+native",
      results: sortResults(dedupeResults([...external, ...native])).slice(0, limit),
    };
  }

  return {
    provider: "native",
    results: native,
  };
}

async function searchFilesWithProvider(
  query: string,
  limit: number,
): Promise<{ provider: string; results: GlobalSearchResult[] }> {
  const [officeExternal, pageExternal, native] = await Promise.all([
    searchOfficeFilesExternal(query, limit),
    searchPageFilesExternal(query, limit),
    searchFilesNative(query, limit),
  ]);

  const providers: string[] = [];
  if (officeExternal.length > 0) {
    providers.push("officeindex-service");
  }
  if (pageExternal.length > 0) {
    providers.push("pageindex-service");
  }

  if (providers.length > 0) {
    return {
      provider: `${providers.join("+")}+native`,
      results: sortResults(dedupeResults([...officeExternal, ...pageExternal, ...native])).slice(0, limit),
    };
  }

  return {
    provider: "native",
    results: native,
  };
}

export async function searchWorkspaceGlobal(
  db: DbClient,
  userId: string,
  input: GlobalSearchInput,
): Promise<GlobalSearchResponse> {
  const startedAt = Date.now();
  const query = parseSearchQuery(input.query);
  const limit = parseSearchLimit(input.limit);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User does not exist.");
  }

  const bucket = Math.max(10, Math.floor(limit / 2));
  const [chat, files, tasks, events, users] = await Promise.all([
    searchChatWithProvider(db, userId, query, bucket),
    searchFilesWithProvider(query, bucket),
    searchTasksNative(db, query, Math.max(8, Math.floor(limit / 2))),
    searchEventsNative(db, userId, query, Math.max(8, Math.floor(limit / 2))),
    searchUsersNative(db, userId, query, Math.max(6, Math.floor(limit / 3))),
  ]);

  const needleLower = query.toLowerCase();
  const merged = sortResults(
    dedupeResults([...chat.results, ...files.results, ...tasks, ...events, ...users]),
  )
    .slice(0, limit)
    .map((result) => withAutoHighlights(result, needleLower));

  return {
    query,
    total: merged.length,
    tookMs: Date.now() - startedAt,
    providers: {
      chat: chat.provider,
      files: files.provider,
    },
    results: merged,
  };
}
