export type PublicUser = {
  id: string;
  displayName: string;
  avatarColor: string;
};

export type MessageView = {
  id: string;
  conversationId: string;
  sender: PublicUser;
  body: string;
  createdAt: string;
};

export type MessagePreview = {
  id: string;
  body: string;
  createdAt: string;
  senderDisplayName: string;
};

export type ChannelItem = {
  conversationId: string;
  channel: {
    id: string;
    slug: string;
    name: string;
  };
  unreadCount: number;
  lastMessage: MessagePreview | null;
};

export type DmItem = {
  otherUser: PublicUser;
  conversationId: string | null;
  unreadCount: number;
  lastMessage: MessagePreview | null;
};

export type BootstrapResponse = {
  activeUser: PublicUser;
  users: PublicUser[];
  channels: ChannelItem[];
  dms: DmItem[];
  refreshedAt: string;
};

export type MessagePageResponse = {
  conversationId: string;
  messages: MessageView[];
  nextCursor: string | null;
};

export type DmMessagePageResponse = MessagePageResponse & {
  otherUser: PublicUser;
};

export type PostMessageResponse = {
  message: MessageView;
};

export type PostDmMessageResponse = {
  conversationId: string;
  message: MessageView;
};

export type ReadConversationResponse = {
  ok: true;
  conversationId: string;
  lastReadAt: string;
};
