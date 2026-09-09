// Per-project SSE fan-out. Replay comes from the persisted event log
// (see Db.getLog), so this hub only tracks live subscribers: no ring, no
// second source of truth.
import type { ServerEvent } from "@todo/shared";

// Below Bun.serve's default idleTimeout (10s) so quiet streams stay open.
const PING_INTERVAL_MS = 5_000;

type Sink = (frame: string) => void;

export function encodeEvent(event: ServerEvent): string {
  return `id: ${event.rev}\ndata: ${JSON.stringify(event)}\n\n`;
}

class ProjectHub {
  private subs = new Set<Sink>();

  publish(frame: string): void {
    for (const sink of this.subs) sink(frame);
  }

  subscribe(sink: Sink): () => void {
    this.subs.add(sink);
    return () => {
      this.subs.delete(sink);
    };
  }
}

export class EventHub {
  private hubs = new Map<string, ProjectHub>();

  private hub(projectId: string): ProjectHub {
    let hub = this.hubs.get(projectId);
    if (!hub) {
      hub = new ProjectHub();
      this.hubs.set(projectId, hub);
    }
    return hub;
  }

  publish(projectId: string, event: ServerEvent): void {
    this.hub(projectId).publish(encodeEvent(event));
  }

  /**
   * Open an SSE stream, emitting `initial` frames first (missed events from
   * the log, or a single reset). Query and subscribe happen synchronously in
   * stream construction, so no event slips between replay and live.
   */
  stream(projectId: string, initial: ServerEvent[]): Response {
    const hub = this.hub(projectId);
    const frames = initial.map(encodeEvent);
    let unsubscribe: (() => void) | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<string>({
      start(controller) {
        const sink: Sink = (frame) => {
          try {
            controller.enqueue(frame);
          } catch {
            // Consumer gone; cleanup happens on cancel.
          }
        };
        for (const frame of frames) sink(frame);
        unsubscribe = hub.subscribe(sink);
        ping = setInterval(() => {
          try {
            controller.enqueue(": ping\n\n");
          } catch {
            if (ping) clearInterval(ping);
          }
        }, PING_INTERVAL_MS);
      },
      cancel() {
        if (ping) clearInterval(ping);
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }
}
