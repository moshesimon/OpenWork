import { ConversationType, Prisma, PrismaClient } from "@prisma/client";

type DbClient = Prisma.TransactionClient | PrismaClient;

export const SEEDED_USERS = [
  { id: "u_alex", displayName: "Alex Park", avatarColor: "#3B82F6" },
  { id: "u_brooke", displayName: "Brooke Lane", avatarColor: "#EF4444" },
  { id: "u_carmen", displayName: "Carmen Diaz", avatarColor: "#14B8A6" },
  { id: "u_diego", displayName: "Diego Moss", avatarColor: "#F97316" },
  { id: "u_erin", displayName: "Erin Shaw", avatarColor: "#22C55E" },
] as const;

export const SEEDED_CHANNELS = [
  { id: "ch_general", slug: "general", name: "general" },
  { id: "ch_build", slug: "build", name: "build" },
  { id: "ch_design", slug: "design", name: "design" },
] as const;

export const SEEDED_CHANNEL_CONVERSATIONS = [
  { id: "conv_ch_general", channelId: "ch_general" },
  { id: "conv_ch_build", channelId: "ch_build" },
  { id: "conv_ch_design", channelId: "ch_design" },
] as const;

export async function resetDatabase(db: DbClient): Promise<void> {
  await db.readState.deleteMany();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channel.deleteMany();
  await db.user.deleteMany();
}

export async function seedDatabase(db: DbClient): Promise<void> {
  await db.user.createMany({
    data: SEEDED_USERS.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
    })),
  });

  await db.channel.createMany({
    data: SEEDED_CHANNELS.map((channel) => ({
      id: channel.id,
      slug: channel.slug,
      name: channel.name,
    })),
  });

  await db.conversation.createMany({
    data: SEEDED_CHANNEL_CONVERSATIONS.map((conversation) => ({
      id: conversation.id,
      type: ConversationType.CHANNEL,
      channelId: conversation.channelId,
    })),
  });

  const now = Date.now();
  const seededMessages = [
    {
      id: "msg_seed_1",
      conversationId: "conv_ch_general",
      senderId: "u_alex",
      body: "Welcome to #general. Keep updates short and actionable.",
      createdAt: new Date(now - 1000 * 60 * 80),
    },
    {
      id: "msg_seed_2",
      conversationId: "conv_ch_general",
      senderId: "u_brooke",
      body: "Noted. Shipping today’s frontend slice before lunch.",
      createdAt: new Date(now - 1000 * 60 * 74),
    },
    {
      id: "msg_seed_3",
      conversationId: "conv_ch_build",
      senderId: "u_carmen",
      body: "Build pipeline is green after dependency cleanup.",
      createdAt: new Date(now - 1000 * 60 * 50),
    },
    {
      id: "msg_seed_4",
      conversationId: "conv_ch_design",
      senderId: "u_erin",
      body: "Pushed refreshed layout spacing for mobile cards.",
      createdAt: new Date(now - 1000 * 60 * 30),
    },
  ];

  await db.message.createMany({ data: seededMessages });

  const readStateRows = SEEDED_CHANNEL_CONVERSATIONS.flatMap((conversation) =>
    SEEDED_USERS.map((user) => ({
      conversationId: conversation.id,
      userId: user.id,
      lastReadAt: new Date(now),
    })),
  );

  await db.readState.createMany({ data: readStateRows });
}
