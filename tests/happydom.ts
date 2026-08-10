// Preloaded before the test suite (see bunfig.toml) so component tests get a DOM
// (document, window, HTMLElement) to render React into and dispatch events against.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
