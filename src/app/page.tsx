"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type {
  BootstrapResponse,
  DmMessagePageResponse,
  DmItem,
  MessagePageResponse,
  MessagePreview,
  MessageView,
  PostDmMessageResponse,
  PostMessageResponse,
  ReadConversationResponse,
} from "@/types/chat";

type SelectedThread =
  | {
      kind: "channel";
      conversationId: string;
    }
  | {
      kind: "dm";
      otherUserId: string;
      conversationId: string | null;
    };

const DEFAULT_USER_ID = "u_alex";
const ACTIVE_USER_STORAGE_KEY = "thin-slack-active-user";
const THREAD_STORAGE_PREFIX = "thin-slack-thread";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Request failed. Refresh and try again.";
}

function toPreview(message: MessageView): MessagePreview {
  return {
    id: message.id,
    body: message.body,
    createdAt: message.createdAt,
    senderDisplayName: message.sender.displayName,
  };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function summarizePreview(preview: MessagePreview | null): string {
  if (!preview) {
    return "No messages yet";
  }

  return `${preview.senderDisplayName}: ${preview.body}`;
}

function threadToStorageValue(thread: SelectedThread): string {
  if (thread.kind === "channel") {
    return `channel:${thread.conversationId}`;
  }

  return `dm:${thread.otherUserId}`;
}

function getThreadStorageKey(userId: string): string {
  return `${THREAD_STORAGE_PREFIX}:${userId}`;
}

function threadExists(thread: SelectedThread, payload: BootstrapResponse): boolean {
  if (thread.kind === "channel") {
    return payload.channels.some(
      (channel) => channel.conversationId === thread.conversationId,
    );
  }

  return payload.dms.some((dm) => dm.otherUser.id === thread.otherUserId);
}

function fallbackThread(payload: BootstrapResponse): SelectedThread | null {
  const firstChannel = payload.channels[0];
  if (firstChannel) {
    return {
      kind: "channel",
      conversationId: firstChannel.conversationId,
    };
  }

  const firstDm = payload.dms[0];
  if (firstDm) {
    return {
      kind: "dm",
      otherUserId: firstDm.otherUser.id,
      conversationId: firstDm.conversationId,
    };
  }

  return null;
}

function parseThreadFromSearch(search: URLSearchParams): SelectedThread | null {
  const threadKind = search.get("thread");
  const threadId = search.get("id");

  if (!threadKind || !threadId) {
    return null;
  }

  if (threadKind === "channel") {
    return { kind: "channel", conversationId: threadId };
  }

  if (threadKind === "dm") {
    return { kind: "dm", otherUserId: threadId, conversationId: null };
  }

  return null;
}

function getStoredThread(userId: string, payload: BootstrapResponse): SelectedThread | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(getThreadStorageKey(userId));
  if (!raw) {
    return null;
  }

  if (raw.startsWith("channel:")) {
    const conversationId = raw.replace("channel:", "").trim();
    const thread: SelectedThread = { kind: "channel", conversationId };
    return threadExists(thread, payload) ? thread : null;
  }

  if (raw.startsWith("dm:")) {
    const otherUserId = raw.replace("dm:", "").trim();
    const dm = payload.dms.find((entry) => entry.otherUser.id === otherUserId);
    if (!dm) {
      return null;
    }

    return {
      kind: "dm",
      otherUserId,
      conversationId: dm.conversationId,
    };
  }

  return null;
}

function persistThread(userId: string, thread: SelectedThread): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getThreadStorageKey(userId), threadToStorageValue(thread));
}

async function apiRequest<T>(
  path: string,
  userId: string,
  init?: RequestInit,
): Promise<T> {
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
        : `Request failed (${response.status}). Refresh and try again.`,
    );
  }

  return payload as T;
}

export default function Home() {
  const router = useRouter();
  const pathname = usePathname();
  const [activeUserId, setActiveUserId] = useState(DEFAULT_USER_ID);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedThread, setSelectedThread] = useState<SelectedThread | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [composer, setComposer] = useState("");

  const [loadingBootstrap, setLoadingBootstrap] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [urlReady, setUrlReady] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);
  const initialUserFromQueryRef = useRef<string | null>(null);
  const initialThreadFromQueryRef = useRef<SelectedThread | null>(null);

  const activeUser = useMemo(() => {
    if (!bootstrap) {
      return null;
    }

    return bootstrap.users.find((user) => user.id === activeUserId) ?? bootstrap.activeUser;
  }, [bootstrap, activeUserId]);

  const threadTitle = useMemo(() => {
    if (!selectedThread || !bootstrap) {
      return "Select a Conversation";
    }

    if (selectedThread.kind === "channel") {
      const channel = bootstrap.channels.find(
        (entry) => entry.conversationId === selectedThread.conversationId,
      );
      return channel ? `#${channel.channel.name}` : "Unknown Channel";
    }

    const dm = bootstrap.dms.find(
      (entry) => entry.otherUser.id === selectedThread.otherUserId,
    );
    return dm ? dm.otherUser.displayName : "Unknown User";
  }, [selectedThread, bootstrap]);

  const markThreadAsRead = useCallback(
    async (conversationId: string, thread: SelectedThread, userId: string) => {
      try {
        await apiRequest<ReadConversationResponse>(
          `/api/conversations/${encodeURIComponent(conversationId)}/read`,
          userId,
          { method: "POST" },
        );
      } catch (markError) {
        setError(toErrorMessage(markError));
        return;
      }

      setBootstrap((previous) => {
        if (!previous) {
          return previous;
        }

        if (thread.kind === "channel") {
          return {
            ...previous,
            channels: previous.channels.map((channel) =>
              channel.conversationId === conversationId
                ? {
                    ...channel,
                    unreadCount: 0,
                  }
                : channel,
            ),
          };
        }

        return {
          ...previous,
          dms: previous.dms.map((dm) =>
            dm.otherUser.id === thread.otherUserId
              ? {
                  ...dm,
                  unreadCount: 0,
                  conversationId,
                }
              : dm,
          ),
        };
      });
    },
    [],
  );

  const openThread = useCallback(
    async (thread: SelectedThread, userId = activeUserId) => {
      setSelectedThread(thread);
      persistThread(userId, thread);
      setLoadingMessages(true);
      setError(null);

      try {
        if (thread.kind === "channel") {
          const payload = await apiRequest<MessagePageResponse>(
            `/api/conversations/${encodeURIComponent(thread.conversationId)}/messages?limit=50`,
            userId,
          );

          setMessages(payload.messages);
          setNextCursor(payload.nextCursor);
          await markThreadAsRead(payload.conversationId, thread, userId);
        } else {
          const payload = await apiRequest<DmMessagePageResponse>(
            `/api/dms/${encodeURIComponent(thread.otherUserId)}/messages?limit=50`,
            userId,
          );

          const resolvedThread: SelectedThread = {
            kind: "dm",
            otherUserId: thread.otherUserId,
            conversationId: payload.conversationId,
          };

          setSelectedThread(resolvedThread);
          persistThread(userId, resolvedThread);
          setMessages(payload.messages);
          setNextCursor(payload.nextCursor);

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
                      conversationId: payload.conversationId,
                    }
                  : dm,
              ),
            };
          });

          await markThreadAsRead(payload.conversationId, resolvedThread, userId);
        }

        if (window.innerWidth <= 920) setSidebarOpen(false);
      } catch (openError) {
        setError(toErrorMessage(openError));
      } finally {
        setLoadingMessages(false);
      }
    },
    [activeUserId, markThreadAsRead],
  );

  const initializeWorkspace = useCallback(
    async (userId: string, preferredThread: SelectedThread | null) => {
      setLoadingBootstrap(true);
      setError(null);

      try {
        const payload = await apiRequest<BootstrapResponse>("/api/bootstrap", userId);
        setBootstrap(payload);

        const resolvedThread =
          (preferredThread && threadExists(preferredThread, payload)
            ? preferredThread
            : null) ??
          getStoredThread(userId, payload) ??
          fallbackThread(payload);

        if (!resolvedThread) {
          setSelectedThread(null);
          setMessages([]);
          setNextCursor(null);
          return;
        }

        await openThread(resolvedThread, userId);
      } catch (bootstrapError) {
        setBootstrap(null);
        setSelectedThread(null);
        setMessages([]);
        setNextCursor(null);
        setError(toErrorMessage(bootstrapError));
      } finally {
        setLoadingBootstrap(false);
      }
    },
    [openThread],
  );

  const updatePreviewAfterSend = useCallback(
    (
      thread: SelectedThread,
      message: MessageView,
      conversationId: string,
      otherUserId?: string,
    ) => {
      setBootstrap((previous) => {
        if (!previous) {
          return previous;
        }

        if (thread.kind === "channel") {
          return {
            ...previous,
            channels: previous.channels.map((channel) =>
              channel.conversationId === conversationId
                ? {
                    ...channel,
                    unreadCount: 0,
                    lastMessage: toPreview(message),
                  }
                : channel,
            ),
          };
        }

        return {
          ...previous,
          dms: previous.dms.map((dm) =>
            dm.otherUser.id === (otherUserId ?? thread.otherUserId)
              ? {
                  ...dm,
                  unreadCount: 0,
                  conversationId,
                  lastMessage: toPreview(message),
                }
              : dm,
          ),
        };
      });
    },
    [],
  );

  const handleLoadOlder = useCallback(async () => {
    if (!selectedThread || !nextCursor) {
      return;
    }

    setLoadingOlder(true);
    setError(null);

    try {
      if (selectedThread.kind === "channel") {
        const payload = await apiRequest<MessagePageResponse>(
          `/api/conversations/${encodeURIComponent(
            selectedThread.conversationId,
          )}/messages?limit=50&cursor=${encodeURIComponent(nextCursor)}`,
          activeUserId,
        );

        setMessages((previous) => [...payload.messages, ...previous]);
        setNextCursor(payload.nextCursor);
      } else {
        const payload = await apiRequest<DmMessagePageResponse>(
          `/api/dms/${encodeURIComponent(
            selectedThread.otherUserId,
          )}/messages?limit=50&cursor=${encodeURIComponent(nextCursor)}`,
          activeUserId,
        );

        setMessages((previous) => [...payload.messages, ...previous]);
        setNextCursor(payload.nextCursor);

        if (payload.conversationId !== selectedThread.conversationId) {
          const resolvedThread: SelectedThread = {
            kind: "dm",
            otherUserId: selectedThread.otherUserId,
            conversationId: payload.conversationId,
          };
          setSelectedThread(resolvedThread);
          persistThread(activeUserId, resolvedThread);
        }
      }
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setLoadingOlder(false);
    }
  }, [activeUserId, nextCursor, selectedThread]);

  const handleSend = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!selectedThread || !bootstrap) {
        return;
      }

      const body = composer.trim();
      if (!body) {
        return;
      }

      const sender = activeUser ?? bootstrap.activeUser;
      if (!sender) {
        return;
      }

      setSending(true);
      setError(null);

      const optimisticId = `optimistic-${Date.now()}`;
      const optimisticMessage: MessageView = {
        id: optimisticId,
        conversationId:
          selectedThread.kind === "channel"
            ? selectedThread.conversationId
            : selectedThread.conversationId ?? "pending_dm",
        body,
        createdAt: new Date().toISOString(),
        sender,
      };

      setComposer("");
      setMessages((previous) => [...previous, optimisticMessage]);

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

          setMessages((previous) =>
            previous.map((message) =>
              message.id === optimisticId ? payload.message : message,
            ),
          );

          updatePreviewAfterSend(
            selectedThread,
            payload.message,
            selectedThread.conversationId,
          );
          await markThreadAsRead(selectedThread.conversationId, selectedThread, activeUserId);
        } else {
          const payload = await apiRequest<PostDmMessageResponse>(
            `/api/dms/${encodeURIComponent(selectedThread.otherUserId)}/messages`,
            activeUserId,
            {
              method: "POST",
              body: JSON.stringify({ body }),
            },
          );

          const resolvedThread: SelectedThread = {
            kind: "dm",
            otherUserId: selectedThread.otherUserId,
            conversationId: payload.conversationId,
          };

          setSelectedThread(resolvedThread);
          persistThread(activeUserId, resolvedThread);
          setMessages((previous) =>
            previous.map((message) =>
              message.id === optimisticId ? payload.message : message,
            ),
          );

          updatePreviewAfterSend(
            resolvedThread,
            payload.message,
            payload.conversationId,
            selectedThread.otherUserId,
          );
          await markThreadAsRead(payload.conversationId, resolvedThread, activeUserId);
        }
      } catch (sendError) {
        setMessages((previous) =>
          previous.filter((message) => message.id !== optimisticId),
        );
        setComposer(body);
        setError(toErrorMessage(sendError));
      } finally {
        setSending(false);
      }
    },
    [
      activeUser,
      activeUserId,
      bootstrap,
      composer,
      markThreadAsRead,
      selectedThread,
      updatePreviewAfterSend,
    ],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await initializeWorkspace(activeUserId, selectedThread);
    setRefreshing(false);
  }, [activeUserId, initializeWorkspace, selectedThread]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userDropdownRef.current && !userDropdownRef.current.contains(event.target as Node)) {
        setUserDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const search = new URLSearchParams(window.location.search);
    const storedUser = window.localStorage.getItem(ACTIVE_USER_STORAGE_KEY)?.trim();
    const userFromSearch = search.get("user")?.trim();
    const resolvedUserId = userFromSearch || storedUser || DEFAULT_USER_ID;

    initialUserFromQueryRef.current = resolvedUserId;
    initialThreadFromQueryRef.current = parseThreadFromSearch(search);
    if (resolvedUserId !== DEFAULT_USER_ID) {
      setActiveUserId(resolvedUserId);
    }

    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady || typeof window === "undefined") {
      return;
    }

    if (initialUserFromQueryRef.current && activeUserId !== initialUserFromQueryRef.current) {
      return;
    }
    initialUserFromQueryRef.current = null;

    window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, activeUserId);

    const preferredThread = initialThreadFromQueryRef.current;
    initialThreadFromQueryRef.current = null;
    void initializeWorkspace(activeUserId, preferredThread);
  }, [activeUserId, initializeWorkspace, urlReady]);

  useEffect(() => {
    if (!urlReady || typeof window === "undefined") {
      return;
    }

    const search = new URLSearchParams(window.location.search);
    search.set("user", activeUserId);

    if (selectedThread?.kind === "channel") {
      search.set("thread", "channel");
      search.set("id", selectedThread.conversationId);
    } else if (selectedThread?.kind === "dm") {
      search.set("thread", "dm");
      search.set("id", selectedThread.otherUserId);
    } else {
      search.delete("thread");
      search.delete("id");
    }

    const nextSearch = search.toString();
    const nextUrl = nextSearch ? `${pathname}?${nextSearch}` : pathname;
    const currentUrl = `${pathname}${window.location.search}`;

    if (nextUrl !== currentUrl) {
      router.replace(nextUrl, { scroll: false });
    }
  }, [activeUserId, pathname, router, selectedThread, urlReady]);

  const renderThreadItem = (
    key: string,
    label: string,
    preview: MessagePreview | null,
    unreadCount: number,
    selected: boolean,
    onClick: () => void,
  ) => (
    <button
      key={key}
      type="button"
      className={`thread-button ${selected ? "is-selected" : ""}`}
      onClick={onClick}
    >
      <span className="thread-button-label">{label}</span>
      <span className="thread-button-preview">{summarizePreview(preview)}</span>
      {unreadCount > 0 ? <span className="thread-badge">{unreadCount}</span> : null}
    </button>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#chat-main">
        Skip to Active Conversation
      </a>
      <h1 className="sr-only">Thin Slack Workspace</h1>
      <div className={`workspace ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
        <section className="pane threads-pane" id="thread-sidebar">
          {activeUser ? (
            <div className="user-switcher" ref={userDropdownRef}>
              <button
                type="button"
                className="user-switcher-toggle"
                onClick={() => setUserDropdownOpen((open) => !open)}
                aria-expanded={userDropdownOpen}
              >
                <span
                  className="avatar-dot"
                  style={{ backgroundColor: activeUser.avatarColor }}
                  aria-hidden="true"
                />
                <span className="user-switcher-name">{activeUser.displayName}</span>
                <span className="user-switcher-chevron" aria-hidden="true">
                  {userDropdownOpen ? "\u25B4" : "\u25BE"}
                </span>
              </button>
              {userDropdownOpen ? (
                <div className="user-switcher-menu">
                  {(bootstrap?.users ?? []).map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className={`user-switcher-option ${user.id === activeUserId ? "is-active" : ""}`}
                      onClick={() => {
                        if (user.id !== activeUserId) {
                          setActiveUserId(user.id);
                          setMessages([]);
                          setNextCursor(null);
                          setSelectedThread(null);
                        }
                        setUserDropdownOpen(false);
                      }}
                    >
                      <span
                        className="avatar-dot"
                        style={{ backgroundColor: user.avatarColor }}
                        aria-hidden="true"
                      />
                      <span>{user.displayName}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="threads-header">
            <div>
              <p className="pane-kicker">Browse</p>
              <h2 className="pane-title">Conversations</h2>
            </div>
            <div className="threads-header-actions">
              <button
                type="button"
                className="refresh-button"
                onClick={handleRefresh}
                disabled={refreshing || loadingBootstrap}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <button
                type="button"
                className="sidebar-toggle"
                onClick={() => setSidebarOpen(false)}
                aria-controls="thread-sidebar"
                aria-label="Collapse Sidebar"
              >
                {"\u2039"}
              </button>
            </div>
          </div>

          {loadingBootstrap ? (
            <p className="empty-state status-line" role="status" aria-live="polite">
              Loading Workspace…
            </p>
          ) : null}

          {!loadingBootstrap && bootstrap ? (
            <div className="thread-groups">
              <div className="thread-group">
                <p className="thread-group-title"># Channels</p>
                {bootstrap.channels.map((channel) =>
                  renderThreadItem(
                    channel.conversationId,
                    `#${channel.channel.name}`,
                    channel.lastMessage,
                    channel.unreadCount,
                    selectedThread?.kind === "channel" &&
                      selectedThread.conversationId === channel.conversationId,
                    () =>
                      void openThread({
                        kind: "channel",
                        conversationId: channel.conversationId,
                      }),
                  ),
                )}
              </div>

              <div className="thread-group">
                <p className="thread-group-title">Direct messages</p>
                {bootstrap.dms.map((dm: DmItem) =>
                  renderThreadItem(
                    dm.otherUser.id,
                    dm.otherUser.displayName,
                    dm.lastMessage,
                    dm.unreadCount,
                    selectedThread?.kind === "dm" &&
                      selectedThread.otherUserId === dm.otherUser.id,
                    () =>
                      void openThread({
                        kind: "dm",
                        otherUserId: dm.otherUser.id,
                        conversationId: dm.conversationId,
                      }),
                  ),
                )}
              </div>
            </div>
          ) : null}
        </section>

        {!sidebarOpen && (
          <button
            type="button"
            className="sidebar-expand-tab"
            onClick={() => setSidebarOpen(true)}
            aria-controls="thread-sidebar"
            aria-label="Expand Sidebar"
          >
            {"\u203A"}
          </button>
        )}

        <main className="pane chat-pane" id="chat-main" tabIndex={-1}>
          <header className="chat-header">
            <div className="chat-header-main">
              <div>
                <p className="pane-kicker">Active Thread</p>
                <h2 className="chat-title">{threadTitle}</h2>
              </div>
            </div>
            <button
              type="button"
              className="refresh-ghost"
              onClick={handleRefresh}
              disabled={refreshing || loadingBootstrap}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </header>

          {error ? (
            <p className="error-banner" role="status" aria-live="polite">
              {error}
            </p>
          ) : null}

          <div className="timeline">
            {nextCursor ? (
              <button
                type="button"
                className="load-older"
                onClick={handleLoadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? "Loading…" : "Load Older Messages"}
              </button>
            ) : null}

            {loadingMessages ? (
              <p className="empty-state status-line" role="status" aria-live="polite">
                Loading Messages…
              </p>
            ) : (
              <ul className="message-list">
                {messages.length === 0 ? (
                  <li className="empty-state">No Messages Yet. Start the Conversation.</li>
                ) : (
                  messages.map((message) => {
                    const mine = message.sender.id === activeUserId;

                    return (
                      <li
                        key={message.id}
                        className={`message-row ${mine ? "is-mine" : ""}`}
                      >
                        <div className="message-meta">
                          <span
                            className="avatar-dot"
                            style={{ backgroundColor: message.sender.avatarColor }}
                            aria-hidden="true"
                          />
                          <span className="message-sender">{message.sender.displayName}</span>
                          <span className="message-time">
                            {formatTime(message.createdAt)}
                          </span>
                        </div>
                        <p className="message-body">{message.body}</p>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </div>

          <form className="composer" onSubmit={handleSend}>
            <label className="sr-only" htmlFor="composer-input">
              Message
            </label>
            <textarea
              id="composer-input"
              name="messageBody"
              autoComplete="off"
              className="composer-input"
              rows={3}
              maxLength={2000}
              value={composer}
              placeholder={
                selectedThread
                  ? "Write a Message… (Shift+Enter for a New Line)"
                  : "Pick a Channel or DM to Start Messaging…"
              }
              onChange={(event) => setComposer(event.target.value)}
              disabled={!selectedThread || sending}
            />
            <button
              type="submit"
              className="composer-submit"
              disabled={!selectedThread || sending || composer.trim().length === 0}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        </main>
      </div>
    </div>
  );
}
