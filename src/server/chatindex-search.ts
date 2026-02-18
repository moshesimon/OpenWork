import { ConversationType, Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import { extractSearchSnippet, scoreTextMatch } from "@/server/global-search";

type DbClient = PrismaClient | Prisma.TransactionClient;

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 180;

export type ChatIndexSearchInput = {
  query: string;
  userId: string;
  limit?: number;
};

export type ChatIndexSearchResult = {
  kind: "channel" | "dm" | "message";
  id: string;
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
};

export type ChatIndexSearchResponse = {
  query: string;
  total: number;
  tookMs: number;
  results: ChatIndexSearchResult[];
};

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

function parseUserId(rawUserId: string): string {
  const userId = rawUserId.trim();
  if (!userId) {
    throw new ApiError(400, "INVALID_USER", "userId is required.");
  }

  return userId;
}

function resultKey(result: ChatIndexSearchResult): string {
  if (result.kind === "channel") {
    return `channel:${result.conversationId ?? result.channelSlug ?? result.id}`;
  }

  if (result.kind === "dm") {
    return `dm:${result.otherUserId ?? result.conversationId ?? result.id}`;
  }

  return `message:${result.messageId ?? result.id}`;
}

function dedupeResults(results: ChatIndexSearchResult[]): ChatIndexSearchResult[] {
  const bestByKey = new Map<string, ChatIndexSearchResult>();

  for (const result of results) {
    const key = resultKey(result);
    const existing = bestByKey.get(key);
    if (!existing || result.score > existing.score) {
      bestByKey.set(key, result);
    }
  }

  return Array.from(bestByKey.values());
}

function sortResults(results: ChatIndexSearchResult[]): ChatIndexSearchResult[] {
  return results.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

const messageSubtitleFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

async function searchChannels(
  db: DbClient,
  query: string,
  needleLower: string,
  limit: number,
): Promise<ChatIndexSearchResult[]> {
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
        kind: "channel",
        id: row.id,
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
      } satisfies ChatIndexSearchResult;
    });
}

async function searchDms(
  db: DbClient,
  userId: string,
  needleLower: string,
  limit: number,
): Promise<ChatIndexSearchResult[]> {
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

  const results: ChatIndexSearchResult[] = [];
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
      kind: "dm",
      id: row.id,
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
    });
  }

  return results.slice(0, limit);
}

async function searchMessages(
  db: DbClient,
  userId: string,
  query: string,
  needleLower: string,
  limit: number,
): Promise<ChatIndexSearchResult[]> {
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

  const results: ChatIndexSearchResult[] = [];
  for (const row of rows) {
    const bodyScore = scoreTextMatch(row.body, needleLower);
    if (bodyScore === 0) {
      continue;
    }

    const snippet = extractSearchSnippet(row.body, needleLower);
    const createdAt = row.createdAt.toISOString();

    if (row.conversation.type === ConversationType.CHANNEL) {
      const channelName = row.conversation.channel?.name ?? "channel";
      const channelSlug = row.conversation.channel?.slug ?? "";

      results.push({
        kind: "message",
        id: row.id,
        score: bodyScore + 30,
        title: `${row.sender.displayName} in #${channelName}`,
        subtitle: `Channel message · ${messageSubtitleFormatter.format(row.createdAt)}`,
        snippet,
        createdAt,
        conversationId: row.conversationId,
        threadKind: "channel",
        channelSlug,
        channelName,
        otherUserId: null,
        otherUserName: null,
        messageId: row.id,
      });
      continue;
    }

    const otherUser =
      row.conversation.dmUserAId === userId
        ? row.conversation.dmUserB
        : row.conversation.dmUserBId === userId
          ? row.conversation.dmUserA
          : null;

    results.push({
      kind: "message",
      id: row.id,
      score: bodyScore + 30,
      title: `${row.sender.displayName} in DM with ${otherUser?.displayName ?? "DM"}`,
      subtitle: `Direct message · ${messageSubtitleFormatter.format(row.createdAt)}`,
      snippet,
      createdAt,
      conversationId: row.conversationId,
      threadKind: "dm",
      channelSlug: null,
      channelName: null,
      otherUserId: otherUser?.id ?? null,
      otherUserName: otherUser?.displayName ?? null,
      messageId: row.id,
    });
  }

  return results;
}

export async function searchChatIndex(
  db: DbClient,
  input: ChatIndexSearchInput,
): Promise<ChatIndexSearchResponse> {
  const startedAt = Date.now();
  const query = parseSearchQuery(input.query);
  const userId = parseUserId(input.userId);
  const limit = parseSearchLimit(input.limit);
  const needleLower = query.toLowerCase();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User does not exist.");
  }

  const channelLimit = Math.min(10, Math.max(4, Math.floor(limit / 3)));
  const dmLimit = Math.min(10, Math.max(4, Math.floor(limit / 4)));
  const messageLimit = Math.max(10, Math.floor(limit * 1.8));

  const [channelResults, dmResults, messageResults] = await Promise.all([
    searchChannels(db, query, needleLower, channelLimit),
    searchDms(db, userId, needleLower, dmLimit),
    searchMessages(db, userId, query, needleLower, messageLimit),
  ]);

  const results = sortResults(dedupeResults([...channelResults, ...dmResults, ...messageResults])).slice(
    0,
    limit,
  );

  return {
    query,
    total: results.length,
    tookMs: Date.now() - startedAt,
    results,
  };
}
