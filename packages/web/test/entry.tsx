// DOM-test harness entry. Bundled by vite.focus.config.ts and driven by
// test/focus.test.ts under happy-dom. Installs fetch/EventSource stubs so no
// network is needed.
import { render } from "@solidjs/web";
import App from "../src/App";

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {}
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

export async function mountApp(snapshot: unknown): Promise<void> {
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    if (
      url.startsWith("/api/projects/") &&
      !url.includes("/events") &&
      !url.includes("/todos")
    ) {
      return Response.json(snapshot);
    }
    return Response.json({}, { status: 200 });
  };
  document.body.innerHTML = '<div id="app"></div>';
  render(() => <App />, document.getElementById("app")!);
  await settle();
}

/** Let Solid 2.0's microtask flush (and one frame) run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 16);
    raf(() => setTimeout(resolve, 0));
  });
}
