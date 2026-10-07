// Preloaded before the test suite (see bunfig.toml) so component tests get a DOM
// (document, window, HTMLElement) to render React into and dispatch events against.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun's own, captured before happy-dom replaces the globals. A test that drives the BRIDGE's
// network code (the preview readiness probe) needs both back: happy-dom's fetch CORS-blocks a real
// port, and Bun's fetch (1.4+) rejects happy-dom's AbortSignal as "not of type AbortSignal".
export const native = { fetch: Bun.fetch as typeof fetch, AbortSignal: globalThis.AbortSignal };

GlobalRegistrator.register();

// happy-dom ships no EventSource, and the chat opens one for its live step feed — without this the
// panel throws on mount. A stub rather than a real connection: component tests assert rendering, and
// the stream's own behaviour is covered server-side. Tests that want to drive it can reach the
// instances through `EventSource.opened`.
if (typeof globalThis.EventSource === "undefined") {
  class FakeEventSource extends EventTarget {
    static opened: FakeEventSource[] = [];
    readonly url: string;
    constructor(url: string) {
      super();
      this.url = url;
      FakeEventSource.opened.push(this);
    }
    close(): void {
      FakeEventSource.opened = FakeEventSource.opened.filter((s) => s !== this);
    }
  }
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
}

// happy-dom's WebSocket really connects, and the live terminal opens one to the bridge on mount —
// in a test there is no bridge (or the wrong one), and the failed connection surfaces as an unhandled
// error event. Same stub as above: never connects, so component tests assert rendering only.
{
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    static opened: FakeWebSocket[] = [];
    readonly url: string;
    readyState = 0;
    binaryType = "blob";
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(url: string) { super(); this.url = url; FakeWebSocket.opened.push(this); }
    send(): void { /* nowhere to send */ }
    close(): void { this.readyState = 3; FakeWebSocket.opened = FakeWebSocket.opened.filter((s) => s !== this); }
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}
