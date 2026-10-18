// Preloaded before the test suite (see bunfig.toml) so component tests get a DOM
// (document, window, HTMLElement) to render React into and dispatch events against.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun's own, captured before happy-dom replaces the globals. A test that drives the BRIDGE's
// network code (the preview readiness probe) needs both back: happy-dom's fetch CORS-blocks a real
// port, and Bun's fetch (1.4+) rejects happy-dom's AbortSignal as "not of type AbortSignal".
// `Response` too: a Bun.serve handler in a test must return Bun's Response, not happy-dom's (which
// Bun.serve doesn't recognise and answers with its welcome page). `WebSocket`: the terminal's
// tests talk to a real Bun server, which happy-dom's client can't.
export const native = { fetch: Bun.fetch as typeof fetch, AbortSignal: globalThis.AbortSignal, AbortController: globalThis.AbortController, Response: globalThis.Response, Request: globalThis.Request, Headers: globalThis.Headers, WebSocket: globalThis.WebSocket };

// A real base URL (not about:blank, whose pathname reads "blank"), so navigate() moves the route
// store between pages the way it does in the browser. Not localhost: code that behaves differently
// on a localhost page (previewHref) keeps its non-local default.
GlobalRegistrator.register({ url: "http://orca.test/" });

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

// happy-dom's IntersectionObserver never calls back, and has no layout to measure against. The chat
// mounts only the items near its viewport (views/Chat.tsx LazyItem), so with that stub every older
// turn stayed an empty box. This one reports each observed element as visible at once — a viewport
// tall enough for everything. A test of the lazy mount itself swaps in its own (chatPagination).
class VisibleIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = VisibleIntersectionObserver;
