import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EventBus } from "../event-bus.js";
import type { OpenViewResult } from "./terminal-provider.js";
import type { FollowControls } from "./terminal-follow-policy.js";

export interface FollowingSelector { view: string; provider: "herdr"; session?: string }
type Selection = { selector: FollowingSelector; enabled: boolean };

/** Saved selectors only, never saved task membership. Core events coalesce
 * onto one serialized render; retention/suppression use one-shot deadlines. */
export class TerminalFollowing {
  private selections = new Map<string, Selection>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private stopped = false;
  private loadError?: string;
  private unsubscribe: () => void;
  private latest = new Map<string, OpenViewResult>();

  constructor(private readonly file: string, bus: Pick<EventBus, "subscribe">,
    private readonly render: (selector: FollowingSelector, controls: FollowControls) => Promise<OpenViewResult>) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { version: number; selections: Selection[] };
      if (saved.version !== 1 || !Array.isArray(saved.selections) || saved.selections.length > 64
        || saved.selections.some(s => typeof s.enabled !== "boolean" || s.selector?.provider !== "herdr"
          || typeof s.selector.view !== "string" || !/^(qitem|slice|mission):.+/.test(s.selector.view)
          || (s.selector.session !== undefined && typeof s.selector.session !== "string"))) throw new Error("Invalid following selectors.");
      for (const selected of saved.selections) this.selections.set(this.key(selected.selector), selected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.loadError = "Saved following selectors are unreadable; their file was preserved.";
    }
    this.unsubscribe = bus.subscribe(event => {
      if (/^(queue|session|node)\./.test(event.type) || event.type === "scope.sources_changed") this.changed();
    });
    if (this.selections.size) this.changed();
  }

  private key(selector: FollowingSelector): string { return JSON.stringify([selector.provider, selector.session ?? null, selector.view]); }
  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, selections: [...this.selections.values()] }) + "\n", { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }
  private deadline(key: string, at?: number): void {
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.delete(key);
    if (at === undefined || this.stopped) return;
    const timer = setTimeout(() => { this.timers.delete(key); this.changed(); }, Math.max(1, at - Date.now()));
    timer.unref?.(); this.timers.set(key, timer);
  }
  private async apply(selected: Selection, controls: FollowControls): Promise<OpenViewResult> {
    const result = await this.render(selected.selector, controls);
    const key = this.key(selected.selector);
    // A complete empty task has finished. Keep its provider workspace, but
    // retire automatic work and release the active-selector slot. Explicit
    // --follow can resume the same journaled workspace if work returns.
    if (selected.selector.view.startsWith("qitem:") && result.ok && result.following?.state === "empty") {
      this.selections.delete(key); selected.enabled = false;
      result.following.enabled = false;
      this.save();
    }
    this.latest.set(key, result);
    this.deadline(key, selected.enabled ? result.following?.nextAt : undefined);
    return result;
  }

  open(selector: FollowingSelector, controls: FollowControls): Promise<OpenViewResult> {
    return this.serial(async () => {
      if (this.stopped || this.loadError) return { provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0,
        code: "follow_unavailable", error: this.loadError ?? "Following is stopping." };
      const key = this.key(selector);
      if (controls.enabled && !this.selections.has(key) && this.selections.size >= 64) return { provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0,
        code: "follow_limit", error: "64 following selectors are retained. Disable/remove unused selectors before adding more." };
      const selected = { selector, enabled: controls.enabled };
      // Selection is durable before provider effects, so a lost HTTP response
      // cannot authorize a second workspace. The provider journals tile IDs.
      if (controls.enabled) this.selections.set(key, selected);
      else this.selections.delete(key);
      this.save();
      return this.apply(selected, controls);
    });
  }

  changed(): void {
    if (this.stopped || this.loadError || this.dirty || ![...this.selections.values()].some(s => s.enabled)) return;
    this.dirty = true;
    const timer = setTimeout(() => {
      this.timers.delete("changes");
      void this.serial(async () => {
        this.dirty = false;
        if (this.stopped) return;
        for (const selected of this.selections.values()) {
          if (!selected.enabled) continue;
          try { await this.apply(selected, { enabled: true }); }
          catch { /* Keep prior tiles and selector; a later Core event can reconcile. */ }
        }
      });
    }, 100);
    timer.unref?.(); this.timers.set("changes", timer);
  }
  list() { return [...this.selections].map(([key, selected]) => ({ ...selected.selector, enabled: selected.enabled,
    ...(this.latest.get(key)?.following ? { status: this.latest.get(key)!.following } : {}) })); }
  async stop(): Promise<void> {
    this.stopped = true; this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); await this.pending;
  }
}
