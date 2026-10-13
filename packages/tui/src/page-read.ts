import type { ViewState } from "./types.js";
import { retainAttentionSources } from "./attention/source-continuity.js";

/** One page's successful HTTP reads; never shared between TUIs or used for effects.
 * Each source can fail without erasing siblings. */
export class PageRead {
  private values = new Map<string, { body: string; status: number; headers: Headers; at: number }>();
  private seen = new Set<string>();
  errors: string[] = [];
  retainedAt: number | undefined;
  constructor(private now: () => number, private denied: (url: string) => void = () => {}) {}
  has(url: string): boolean { return this.values.has(url); }
  begin(): void { this.seen.clear(); this.errors = []; this.retainedAt = undefined; }
  end(): void { for (const key of this.values.keys()) if (!this.seen.has(key)) this.values.delete(key); }
  fetch(fetchImpl: typeof fetch, signal: AbortSignal, optional = false): typeof fetch {
    return (async (input, init) => {
      if (init?.method && init.method !== "GET") throw new Error("Page reader is read-only");
      const key = String(input);
      const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
      // Optional enrichment shares cancellation, but neither contributes page
      // failures nor retains a former owner as if it were freshly resolved.
      if (optional) return fetchImpl(input, { ...init, signal: requestSignal });
      this.seen.add(key);
      try {
        const response = await fetchImpl(input, { ...init, signal: requestSignal });
        if (response.status >= 500) {
          // This response is discarded in favor of a failed read or cached value.
          void response.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${response.status}`);
        }
        // Absence/access refusal is a new answer; do not resurrect deleted or
        // newly forbidden content from the prior successful response.
        if (!response.ok) {
          signal.throwIfAborted();
          this.values.delete(key);
          this.denied(key);
          this.errors.push(`${new URL(key).pathname}: HTTP ${response.status}`);
          return response;
        }
        let body = await response.text();
        const decoded = JSON.parse(body); // all page reads are JSON; a broken body is a failed read
        signal.throwIfAborted();
        let at = this.now();
        // Attention declares independent source outages inside HTTP 200. Keep
        // those contributions in this same page/URL cache, alongside fresh siblings.
        if (new URL(key).pathname === "/api/attention") {
          const prior = this.values.get(key);
          const merged = retainAttentionSources(decoded, prior && JSON.parse(prior.body));
          body = JSON.stringify(merged.read);
          this.errors.push(...merged.errors);
          if (merged.retained && prior) {
            at = prior.at; // conservative time basis until the whole read succeeds
            this.retainedAt = Math.min(this.retainedAt ?? at, at);
          }
        }
        const value = { body, status: response.status, headers: response.headers, at };
        this.values.set(key, value);
        return new Response(body, value);
      } catch (error) {
        signal.throwIfAborted();
        const detail = error instanceof Error ? error.message : String(error);
        const route = new URL(key).pathname;
        this.errors.push(`${route}: ${detail}`);
        const prior = this.values.get(key);
        if (!prior) throw error;
        this.retainedAt = Math.min(this.retainedAt ?? prior.at, prior.at);
        return new Response(prior.body, prior);
      }
    }) as typeof fetch;
  }
}

/** Data coordinates only; scrolling, selection, filters and Help never evict a read. */
export function pageReadKey(s: ViewState): string {
  return JSON.stringify([s.section, s.viewTab, s.drill, s.project, s.scopesMission,
    s.scopesSelected, s.executionOpen, s.file && [s.file.root, s.file.path],
    s.externalUrl, s.terminalView, s.attentionOpen, s.pendingDrill]);
}
