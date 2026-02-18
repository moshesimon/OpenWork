export type RealtimeEvent = {
  type: "workspace-update" | "profile-update";
  reason: string;
  at: string;
  userIds?: string[];
  conversationId?: string;
};

type RealtimeListener = (event: RealtimeEvent) => void;

const listeners = new Set<RealtimeListener>();

export function subscribeRealtimeEvents(listener: RealtimeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishRealtimeEvent(
  event: Omit<RealtimeEvent, "at"> & { at?: string },
): void {
  const payload: RealtimeEvent = {
    ...event,
    at: event.at ?? new Date().toISOString(),
  };

  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      console.warn("Realtime listener failed:", error);
    }
  }
}
