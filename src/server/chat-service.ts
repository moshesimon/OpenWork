import { ConversationType, Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import type {
  BootstrapResponse,
  DmMessagePageResponse,
  MessagePageResponse,
  MessagePreview,
  MessageView,
  PostDmMessageResponse,
  PostMessageResponse,
  PublicUser,
  ReadConversationResponse,
} from "@/types/chat";

type DbClient = PrismaClient | Prisma.TransactionClient;

const USER_SELECT = {
  id: true,
  displayName: true,
  avatarColor: true,
} as const;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 50;
export const MAX_MESSAGE_LENGTH = 2000;

export function canonicalDmPair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA];
}

export function resolvePageLimit(rawLimit: string | null | undefined): number {
  if (!rawLimit) {
    return DEFAULT_PAGE_SIZE;
  }

  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ApiError(400, "INVALID_LIMIT", "limit must be a positive integer.");
  }

  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function normalizeMessageBody(rawBody: unknown): string {
  if (typeof rawBody !== "string") {
    throw new ApiError(400, "INVALID_BODY", "body must be a string.");
  }

  const trimmed = rawBody.trim();
  if (!trimmed) {
    throw new ApiError(400, "EMPTY_BODY", "Message body cannot be empty.");
  }

  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(
      413,
      "BODY_TOO_LARGE",
      `Message body cannot exceed ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  return trimmed;
}

function toPublicUser(user: {
  id: string;
  displayName: string;
  avatarColor: string;
}): PublicUser {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
  };
}

function toMessageView(message: {
  id: string;
  body: string;
  conversationId: string;
  createdAt: Date;
  sender: {
    id: string;
    displayName: string;
    avatarColor: string;
  };
}): MessageView {
  return {
    id: message.id,
    body: message.body,
    conversationId: message.conversationId,
    createdAt: message.createdAt.toISOString(),
    sender: toPublicUser(message.sender),
  };
}

function toMessagePreview(
  message:
    | {
        id: string;
        body: string;
        createdAt: Date;
        sender: { displayName: string };
      }
    | undefined,
): MessagePreview | null {
  if (!message) {
    return null;
  }

  return {
    id: message.id,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    senderDisplayName: message.sender.displayName,
  };
}

async function requireActiveUser(db: DbClient, userId: string): Promise<PublicUser> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });

  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User does not exist.");
  }

  return toPublicUser(user);
}

async function requireConversation(
  db: DbClient,
  conversationId: string,
  userId: string,
) {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      channel: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });

  if (!conversation) {
    throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation was not found.");
  }

  if (
    conversation.type === ConversationType.DM &&
    conversation.dmUserAId !== userId &&
    conversation.dmUserBId !== userId
  ) {
    throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation was not found.");
  }

  return conversation;
}

async function resolveCursor(
  db: DbClient,
  conversationId: string,
  rawCursor: string | null | undefined,
): Promise<string | undefined> {
  const cursor = rawCursor?.trim();
  if (!cursor) {
    return undefined;
  }

  const cursorMessage = await db.message.findFirst({
    where: {
      id: cursor,
      conversationId,
    },
    select: {
      id: true,
    },
  });

  if (!cursorMessage) {
    throw new ApiError(
      400,
      "INVALID_CURSOR",
      "cursor must reference a message in the requested conversation.",
    );
  }

  return cursor;
}

async function paginateMessages(
  db: DbClient,
  conversationId: string,
  limit: number,
  cursor?: string,
): Promise<MessagePageResponse> {
  const rawMessages = await db.message.findMany({
    where: { conversationId },
    include: {
      sender: {
        select: USER_SELECT,
      },
    },
    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "desc",
      },
    ],
    take: limit + 1,
    ...(cursor
      ? {
          cursor: { id: cursor },
          skip: 1,
        }
      : {}),
  });

  const hasMore = rawMessages.length > limit;
  const window = hasMore ? rawMessages.slice(0, limit) : rawMessages;
  const nextCursor = hasMore && window.length > 0 ? window[window.length - 1].id : null;
  const ascendingMessages = window
    .slice()
    .reverse()
    .map((message) => toMessageView(message));

  return {
    conversationId,
    messages: ascendingMessages,
    nextCursor,
  };
}

async function unreadCountForConversation(
  db: DbClient,
  conversationId: string,
  userId: string,
  lastReadAt: Date | undefined,
): Promise<number> {
  return db.message.count({
    where: {
      conversationId,
      senderId: {
        not: userId,
      },
      createdAt: {
        gt: lastReadAt ?? new Date(0),
      },
    },
  });
}

async function unreadCountMap(
  db: DbClient,
  userId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) {
    return new Map();
  }

  const readStates = await db.readState.findMany({
    where: {
      userId,
      conversationId: {
        in: conversationIds,
      },
    },
    select: {
      conversationId: true,
      lastReadAt: true,
    },
  });

  const readMap = new Map(readStates.map((state) => [state.conversationId, state.lastReadAt]));

  const counts = await Promise.all(
    conversationIds.map(async (conversationId) => {
      const unread = await unreadCountForConversation(
        db,
        conversationId,
        userId,
        readMap.get(conversationId),
      );

      return [conversationId, unread] as const;
    }),
  );

  return new Map(counts);
}

async function requireOtherUser(db: DbClient, currentUserId: string, otherUserId: string) {
  if (currentUserId === otherUserId) {
    throw new ApiError(400, "INVALID_DM_TARGET", "Cannot open a DM with yourself.");
  }

  const user = await db.user.findUnique({
    where: { id: otherUserId },
    select: USER_SELECT,
  });

  if (!user) {
    throw new ApiError(404, "DM_TARGET_NOT_FOUND", "Requested DM user does not exist.");
  }

  return toPublicUser(user);
}

async function getOrCreateDmConversation(
  db: DbClient,
  userId: string,
  otherUserId: string,
) {
  const [dmUserAId, dmUserBId] = canonicalDmPair(userId, otherUserId);
  const existing = await db.conversation.findFirst({
    where: {
      type: ConversationType.DM,
      dmUserAId,
      dmUserBId,
    },
  });

  if (existing) {
    return existing;
  }

  return db.conversation.create({
    data: {
      type: ConversationType.DM,
      dmUserAId,
      dmUserBId,
    },
  });
}

export async function getBootstrapData(
  db: DbClient,
  userId: string,
): Promise<BootstrapResponse> {
  const activeUser = await requireActiveUser(db, userId);

  const [users, channelConversations, dmConversations] = await Promise.all([
    db.user.findMany({
      select: USER_SELECT,
      orderBy: {
        displayName: "asc",
      },
    }),
    db.conversation.findMany({
      where: { type: ConversationType.CHANNEL },
      include: {
        channel: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
        messages: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
          include: {
            sender: {
              select: {
                displayName: true,
              },
            },
          },
        },
      },
    }),
    db.conversation.findMany({
      where: {
        type: ConversationType.DM,
        OR: [{ dmUserAId: userId }, { dmUserBId: userId }],
      },
      include: {
        messages: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
          include: {
            sender: {
              select: {
                displayName: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const unread = await unreadCountMap(
    db,
    userId,
    [...channelConversations.map((conversation) => conversation.id), ...dmConversations.map((conversation) => conversation.id)],
  );

  const channels = channelConversations
    .filter((conversation) => conversation.channel)
    .map((conversation) => ({
      conversationId: conversation.id,
      channel: {
        id: conversation.channel!.id,
        slug: conversation.channel!.slug,
        name: conversation.channel!.name,
      },
      unreadCount: unread.get(conversation.id) ?? 0,
      lastMessage: toMessagePreview(conversation.messages[0]),
    }))
    .sort((left, right) => left.channel.name.localeCompare(right.channel.name));

  const dmByOtherUser = new Map<string, (typeof dmConversations)[number]>();
  for (const conversation of dmConversations) {
    const otherUserId =
      conversation.dmUserAId === userId ? conversation.dmUserBId : conversation.dmUserAId;

    if (otherUserId) {
      dmByOtherUser.set(otherUserId, conversation);
    }
  }

  const dms = users
    .filter((user) => user.id !== userId)
    .map((user) => {
      const conversation = dmByOtherUser.get(user.id);
      return {
        otherUser: toPublicUser(user),
        conversationId: conversation?.id ?? null,
        unreadCount: conversation ? unread.get(conversation.id) ?? 0 : 0,
        lastMessage: toMessagePreview(conversation?.messages[0]),
      };
    });

  return {
    activeUser,
    users: users.map(toPublicUser),
    channels,
    dms,
    refreshedAt: new Date().toISOString(),
  };
}

export async function getConversationMessagesPage(
  db: DbClient,
  userId: string,
  conversationId: string,
  rawCursor?: string | null,
  rawLimit?: string | null,
): Promise<MessagePageResponse> {
  await requireActiveUser(db, userId);
  await requireConversation(db, conversationId, userId);

  const limit = resolvePageLimit(rawLimit);
  const cursor = await resolveCursor(db, conversationId, rawCursor);
  return paginateMessages(db, conversationId, limit, cursor);
}

export async function createConversationMessage(
  db: DbClient,
  userId: string,
  conversationId: string,
  rawBody: unknown,
): Promise<PostMessageResponse> {
  await requireActiveUser(db, userId);
  await requireConversation(db, conversationId, userId);

  const body = normalizeMessageBody(rawBody);

  const message = await db.message.create({
    data: {
      conversationId,
      senderId: userId,
      body,
    },
    include: {
      sender: {
        select: USER_SELECT,
      },
    },
  });

  return { message: toMessageView(message) };
}

export async function getDmMessagesPage(
  db: DbClient,
  userId: string,
  otherUserId: string,
  rawCursor?: string | null,
  rawLimit?: string | null,
): Promise<DmMessagePageResponse> {
  await requireActiveUser(db, userId);
  const otherUser = await requireOtherUser(db, userId, otherUserId);
  const conversation = await getOrCreateDmConversation(db, userId, otherUserId);

  const limit = resolvePageLimit(rawLimit);
  const cursor = await resolveCursor(db, conversation.id, rawCursor);
  const page = await paginateMessages(db, conversation.id, limit, cursor);

  return {
    ...page,
    otherUser,
  };
}

export async function createDmMessage(
  db: DbClient,
  userId: string,
  otherUserId: string,
  rawBody: unknown,
): Promise<PostDmMessageResponse> {
  await requireActiveUser(db, userId);
  await requireOtherUser(db, userId, otherUserId);

  const body = normalizeMessageBody(rawBody);
  const conversation = await getOrCreateDmConversation(db, userId, otherUserId);

  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      senderId: userId,
      body,
    },
    include: {
      sender: {
        select: USER_SELECT,
      },
    },
  });

  return {
    conversationId: conversation.id,
    message: toMessageView(message),
  };
}

export async function markConversationRead(
  db: DbClient,
  userId: string,
  conversationId: string,
): Promise<ReadConversationResponse> {
  await requireActiveUser(db, userId);
  await requireConversation(db, conversationId, userId);

  const lastReadAt = new Date();

  await db.readState.upsert({
    where: {
      conversationId_userId: {
        conversationId,
        userId,
      },
    },
    create: {
      conversationId,
      userId,
      lastReadAt,
    },
    update: {
      lastReadAt,
    },
  });

  return {
    ok: true,
    conversationId,
    lastReadAt: lastReadAt.toISOString(),
  };
}
