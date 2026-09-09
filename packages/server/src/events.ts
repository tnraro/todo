// Per-project SSE fan-out with a small ring buffer for reconnect replay.
//
// Every mutation bumps the project rev by exactly 1 and publishes exactly one
// event, so buffered revs are consecutive: if the oldest buffered rev is at
// most sinceRev + 1, replay is complete; otherwise the client must refetch.
import type { ServerEvent } from "@todo/shared";

const RING_CAP = 100;
// Below Bun.serve's default idleTimeout (10s) so quiet streams stay open.
const PING_INTERVAL_MS = 5_000;

interface Buffered {
  rev: number;
  frame: string;
}

type Sink = (frame: string) => void;

function encode(event: ServerEvent): string {
  return `id: ${event.rev}\ndata: ${JSON.stringify(event)}\n\n`;
}

class ProjectHub {
  private subs = new Set<Sink>();
  private ring: Buffered[] = [];

  publish(event: ServerEvent): void {
    const frame = encode(event);
    this.ring.push({ rev: event.rev, frame });
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    for (const sink of this.subs) sink(frame);
  }

  /**
   * Frames with rev > sinceRev, or null when the gap cannot be replayed.
   * An empty ring replays nothing: after a restart the buffer is gone, so any
   * missed rev is a gap and the client must refetch.
   */
  replay(sinceRev: number): string[] | null {
    if (this.ring.length === 0) return null;
    if (this.ring[0].rev > sinceRev + 1) return null;
    return this.ring.filter((b) => b.rev > sinceRev).map((b) => b.frame);
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
    this.hub(projectId).publish(event);
  }

  replay(projectId: string, sinceRev: number): string[] | null {
    return this.hub(projectId).replay(sinceRev);
  }

  /**
   * Open an SSE stream. Replays missed events when possible, otherwise emits a
   * reset event so the client refetches the snapshot.
   */
  stream(projectId: string, sinceRev: number, currentRev: number): Response {
    const hub = this.hub(projectId);
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
        if (sinceRev < currentRev) {
          const missed = hub.replay(sinceRev);
          if (missed === null) {
            sink(encode({ type: "reset", rev: currentRev }));
          } else {
            for (const frame of missed) sink(frame);
          }
        }
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
