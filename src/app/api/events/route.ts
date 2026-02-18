import { NextRequest } from "next/server";
import {
  subscribeRealtimeEvents,
  type RealtimeEvent,
} from "@/server/realtime-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function toSseChunk(eventName: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function shouldDeliverEvent(event: RealtimeEvent, userIdFilter: string | null): boolean {
  if (!userIdFilter || !event.userIds || event.userIds.length === 0) {
    return true;
  }
  return event.userIds.includes(userIdFilter);
}

export async function GET(request: NextRequest) {
  const userIdFilter = request.nextUrl.searchParams.get("userId")?.trim() || null;

  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // Stream can already be closed if client disconnected abruptly.
        }
      };

      cleanup = close;

      unsubscribe = subscribeRealtimeEvents((event) => {
        if (!shouldDeliverEvent(event, userIdFilter)) {
          return;
        }
        safeEnqueue(toSseChunk(event.type, event));
      });

      safeEnqueue(toSseChunk("ready", { at: new Date().toISOString() }));
      heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 20_000);

      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
