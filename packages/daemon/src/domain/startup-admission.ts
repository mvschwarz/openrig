import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { StartupMemory } from "./startup-memory.js";

export type AdmissionPhase = "queued" | "held" | "preparing" | "starting" | "settling" | "complete" | "cancelled" | "uncertain";
export interface StartupAdmissionSnapshot {
  attemptId: string;
  nodeId: string;
  kind: string;
  selection: string;
  requestKey?: string;
  phase: AdmissionPhase;
  reason: string;
  observedAt: number;
  dispatchedAt?: number;
  dispatchSeq?: number;
  nativeTarget?: string;
  nativeTargets?: string[];
  memory?: StartupMemory;
  protectionUnavailable?: boolean;
}

export interface StartupAdmissionOptions {
  concurrency: number;
  minimumAvailablePercent: number;
  settleMs: number;
  settleLimitMs: number;
  staleMs: number;
  strictTelemetry: boolean;
}

export function startupAdmissionOptions(env: NodeJS.ProcessEnv = process.env): StartupAdmissionOptions {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
    return n;
  };
  return {
    concurrency: number("OPENRIG_STARTUP_CONCURRENCY", 1, 1, 16),
    minimumAvailablePercent: number("OPENRIG_STARTUP_HEADROOM_PERCENT", 25, 0, 90),
    settleMs: number("OPENRIG_STARTUP_SETTLE_MS", 3000, 0, 60000),
    settleLimitMs: number("OPENRIG_STARTUP_SETTLE_LIMIT_MS", 15000, 0, 120000),
    staleMs: 5000,
    strictTelemetry: env.OPENRIG_STARTUP_STRICT_TELEMETRY === "1",
  };
}

export class StartupAdmissionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface Entry {
  snapshot: StartupAdmissionSnapshot;
  work: () => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  result: Promise<unknown>;
  continueOne: boolean;
  cancelled?: boolean;
  waitingForLifecycle?: boolean;
}

export interface StartupAdmissionDeps {
  observe: () => Promise<StartupMemory>;
  selection: (nodeId: string) => string;
  persist: (snapshot: StartupAdmissionSnapshot) => number | void;
  history: () => StartupAdmissionSnapshot[];
  /** Read only: a lost reply never authorizes another native launch. */
  reconcile: (snapshot: StartupAdmissionSnapshot) => Promise<"absent" | "ready" | "live" | "unknown">;
  /** Register/deduplicate first, then take the existing seat lease before consuming a global slot. */
  lifecycle?: <T>(nodeId: string, work: () => Promise<T>) => Promise<T>;
  ownsLifecycle?: (nodeId: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One owning daemon's managed native starts, not a host-wide scheduler or a resident-seat quota. */
export class StartupAdmission {
  private readonly scope = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private readonly unresolved = new Map<string, StartupAdmissionSnapshot>();
  private readonly latest = new Map<string, StartupAdmissionSnapshot>();
  private readonly lastPersistedAt = new Map<string, number>();
  private active = 0;
  private pumping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: StartupAdmissionDeps, readonly options: StartupAdmissionOptions = startupAdmissionOptions()) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (const snapshot of deps.history()) {
      this.latest.set(snapshot.nodeId, snapshot);
      if (["starting", "uncertain"].includes(snapshot.phase) || (snapshot.phase === "settling" && snapshot.dispatchedAt !== undefined)) this.unresolved.set(snapshot.nodeId, snapshot);
    }
  }

  owns(nodeId: string): boolean { return this.scope.getStore()?.has(nodeId) === true; }
  status(nodeId: string): StartupAdmissionSnapshot | null { return this.latest.get(nodeId) ?? null; }
  pending(nodeId: string): boolean { return this.entries.has(nodeId); }

  /** Called synchronously at the native-input / incumbent-stop boundary, under the owning lease. */
  beforeDispatch(nodeId: string, nativeTarget?: string): void {
    const entry = this.entries.get(nodeId);
    if (!entry || !this.owns(nodeId)) return;
    if (entry.cancelled) throw new StartupAdmissionError("startup_cancelled", "Cancelled before native dispatch; no session stopped.");
    const targets = entry.snapshot.nativeTargets ?? (entry.snapshot.nativeTarget ? [entry.snapshot.nativeTarget] : []);
    if (entry.snapshot.dispatchedAt !== undefined && (!nativeTarget || targets.includes(nativeTarget))) return;
    entry.snapshot.dispatchedAt ??= this.now();
    entry.snapshot.nativeTarget = nativeTarget ?? entry.snapshot.nativeTarget;
    entry.snapshot.nativeTargets = nativeTarget ? [...targets, nativeTarget] : targets;
    this.record(entry, "starting", "Native launch or incumbent stop is being dispatched");
  }

  run<T>(nodeId: string, kind: string, work: () => Promise<T>, requestKey = ""): Promise<T> {
    if (this.owns(nodeId)) return work();
    requestKey = createHash("sha256").update(requestKey).digest("hex");
    const selection = this.deps.selection(nodeId);
    const existing = this.entries.get(nodeId);
    if (existing) {
      // A different caller already holding the lease cannot join work waiting to acquire that lease.
      if (this.deps.ownsLifecycle?.(nodeId) || existing.snapshot.selection !== selection || existing.snapshot.kind !== kind || existing.snapshot.requestKey !== requestKey) {
        return Promise.reject(new StartupAdmissionError("startup_in_progress", "Another startup operation owns this seat; inspect its admission status."));
      }
      return existing.result as Promise<T>;
    }
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const entry: Entry = { snapshot: { attemptId: randomUUID(), nodeId, kind, selection, requestKey,
      phase: "queued", reason: "Waiting for startup admission", observedAt: this.now() }, work, resolve, reject, result, continueOne: false };
    this.entries.set(nodeId, entry);
    const enqueue = () => {
      if (entry.cancelled) throw new StartupAdmissionError("startup_cancelled", "Cancelled while waiting for the lifecycle lease; no native input sent.");
      entry.waitingForLifecycle = false;
      this.queue.push(entry);
      void this.pump();
      return result;
    };
    try {
      // Do not overwrite an interrupted native attempt with a seemingly harmless queued event.
      if (!this.unresolved.has(nodeId)) this.record(entry, "queued", this.active ? "Waiting behind another startup" : "Waiting for startup admission");
      if (this.deps.lifecycle) {
        entry.waitingForLifecycle = true;
        void this.deps.lifecycle(nodeId, enqueue).catch(error => {
          if (this.entries.get(nodeId) !== entry) return;
          this.entries.delete(nodeId);
          try { this.record(entry, entry.cancelled ? "cancelled" : "complete", "Startup stopped before acquiring admission; no native input sent"); } catch { /* Preserve the original lease/storage failure. */ }
          entry.reject(error);
        });
      } else enqueue();
    } catch (error) { this.entries.delete(nodeId); entry.reject(error); }
    return result as Promise<T>;
  }

  control(nodeId: string, action: "cancel" | "continue"): boolean {
    const entry = this.entries.get(nodeId);
    if (!entry || (!this.queue.includes(entry) && !(action === "cancel" && (entry.waitingForLifecycle || entry.snapshot.phase === "preparing")))) return false;
    if (action === "cancel") {
      if (!this.queue.includes(entry)) {
        entry.cancelled = true;
        this.record(entry, "cancelled", "Cancelled before native dispatch; no session stopped");
        if (entry.waitingForLifecycle) entry.reject(new StartupAdmissionError("startup_cancelled", "Cancelled while waiting for the lifecycle lease; no native input sent."));
        return true;
      }
      this.queue.splice(this.queue.indexOf(entry), 1);
      this.entries.delete(nodeId);
      // Keep an interrupted attempt's custody even when its waiting retry is cancelled.
      if (!this.unresolved.has(nodeId)) this.record(entry, "cancelled", "Cancelled before native dispatch; no session stopped");
      entry.reject(new StartupAdmissionError("startup_cancelled", "Startup cancelled before dispatch; no native input sent."));
    } else {
      if (this.unresolved.has(nodeId)) return false;
      entry.continueOne = true;
      this.record(entry, "held", "Continue one selected: memory protection may be insufficient; waiting for the concurrency slot");
    }
    void this.pump();
    return true;
  }

  private record(entry: Entry, phase: AdmissionPhase, reason: string, memory?: StartupMemory): void {
    const unchanged = entry.snapshot.phase === phase && entry.snapshot.reason === reason;
    entry.snapshot = { ...entry.snapshot, phase, reason, observedAt: this.now(), ...(memory ? { memory } : {}) };
    if (memory) entry.snapshot.protectionUnavailable = this.unavailable(memory);
    this.latest.set(entry.snapshot.nodeId, entry.snapshot);
    // Status reads retain each fresh sample; a prolonged hold need not append an event every second.
    if (phase === "held" && unchanged && this.now() - (this.lastPersistedAt.get(entry.snapshot.nodeId) ?? 0) < 5000) return;
    const seq = this.deps.persist(entry.snapshot);
    this.lastPersistedAt.set(entry.snapshot.nodeId, this.now());
    if (phase === "starting" && typeof seq === "number") entry.snapshot.dispatchSeq = seq;
  }

  private async sample(): Promise<StartupMemory> {
    try { return await this.deps.observe(); }
    catch (error) { return { observedAt: this.now(), source: "unavailable", availableBytes: null, totalBytes: null,
      pressure: "unknown", error: error instanceof Error ? error.message : String(error) }; }
  }

  private invalidHeadroom(sample: StartupMemory): boolean {
    return this.now() - sample.observedAt > this.options.staleMs || sample.observedAt > this.now()
      || sample.availableBytes === null || sample.totalBytes === null || !Number.isFinite(sample.availableBytes)
      || !Number.isFinite(sample.totalBytes) || sample.totalBytes <= 0 || sample.availableBytes < 0;
  }

  private unavailable(sample: StartupMemory): boolean {
    return this.invalidHeadroom(sample) || sample.pressure === "unknown";
  }

  private shortage(sample: StartupMemory): boolean {
    // A known pressure warning still holds even if headroom telemetry is incomplete.
    const fresh = this.now() - sample.observedAt <= this.options.staleMs && sample.observedAt <= this.now();
    return (fresh && sample.pressure === "high") || (!this.invalidHeadroom(sample)
      && sample.availableBytes! < sample.totalBytes! * this.options.minimumAvailablePercent / 100);
  }

  private retryLater(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, 1000);
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.active < this.options.concurrency) {
        const entry = this.queue[0]!;
        for (const [nodeId, snapshot] of this.unresolved) {
          const state = await this.deps.reconcile(snapshot).catch(() => "unknown" as const);
          if (state === "absent" || state === "ready") {
            this.unresolved.delete(nodeId);
            if (state === "ready" && nodeId === entry.snapshot.nodeId) {
              this.queue.shift(); this.entries.delete(nodeId);
              entry.reject(new StartupAdmissionError("startup_already_observed", "The earlier launch is now ready. No second launch was sent; inspect the seat."));
              this.retryLater();
              return;
            }
          }
        }
        if (!this.entries.has(entry.snapshot.nodeId)) continue;
        // Even continue-one cannot authorize a duplicate of a live/unknown interrupted attempt.
        if (this.unresolved.has(entry.snapshot.nodeId)) {
          this.queue.shift(); this.entries.delete(entry.snapshot.nodeId);
          entry.reject(new StartupAdmissionError("startup_unreconciled", "An earlier native launch is live or unknown. Reconcile its original session before retrying; no second launch was sent."));
          continue;
        }
        const memory = await this.sample();
        // A cancellation may arrive during an OS read.
        if (!this.queue.includes(entry)) continue;
        const unavailable = this.unavailable(memory);
        entry.snapshot.protectionUnavailable = unavailable;
        if (!entry.continueOne && (this.unresolved.size || this.shortage(memory) || (unavailable && this.options.strictTelemetry))) {
          const reason = this.unresolved.size ? "An earlier launch is unresolved"
            : unavailable && this.options.strictTelemetry ? "Memory telemetry unavailable; strict telemetry wait selected"
            : this.active ? "Memory headroom held behind another startup" : "One-seat memory deficit: no other startup holds a slot";
          this.record(entry, "held", `${reason}. Cancel before dispatch or deliberately continue one.`, memory);
          this.retryLater(); break;
        }
        // Missing observations always serialize, even when healthy concurrency was configured higher.
        if (unavailable && this.active) { this.record(entry, "held", "Memory protection unavailable: serial readiness and pacing only", memory); break; }
        if (this.deps.selection(entry.snapshot.nodeId) !== entry.snapshot.selection) {
          this.queue.shift(); this.entries.delete(entry.snapshot.nodeId);
          this.record(entry, "cancelled", "Seat selection changed before dispatch; refresh rather than start another occupant");
          entry.reject(new StartupAdmissionError("startup_selection_changed", "The seat selection changed while waiting; refresh before starting it."));
          continue;
        }
        this.record(entry, "preparing", unavailable ? "Memory protection unavailable: serialized startup with bounded pacing"
          : entry.continueOne ? "Continuing one with the observed memory risk" : "Startup admitted", memory);
        this.queue.shift(); this.active++;
        void this.execute(entry);
      }
    } catch (error) {
      const entry = this.queue.shift();
      if (entry) { this.entries.delete(entry.snapshot.nodeId); entry.reject(error); }
      if (this.queue.length) this.retryLater();
    } finally { this.pumping = false; }
  }

  private async execute(entry: Entry): Promise<void> {
    try {
      const result = await this.scope.run(new Set([entry.snapshot.nodeId]), entry.work);
      if (entry.cancelled && entry.snapshot.dispatchedAt === undefined) throw new StartupAdmissionError("startup_cancelled", "Cancelled before native dispatch; no session stopped.");
      this.record(entry, "settling", "Native operation returned; readiness alone does not prove memory settling");
      const started = this.now();
      // Bounded pacing also applies with missing telemetry. No fake claim of a measured peak end.
      await this.sleep(Math.min(this.options.settleMs, this.options.settleLimitMs));
      let memory = await this.sample();
      while (this.shortage(memory) && this.now() - started < this.options.settleLimitMs) {
        this.record(entry, "settling", "Waiting for observed memory recovery after native readiness", memory);
        await this.sleep(Math.min(1000, Math.max(0, this.options.settleLimitMs - (this.now() - started))));
        memory = await this.sample();
      }
      const failed = typeof result === "object" && result !== null
        && ((result as { ok?: boolean }).ok === false || ["failed", "attention_required", "awaiting-decision"].includes((result as { status?: string }).status ?? ""));
      if (failed && entry.snapshot.dispatchedAt !== undefined) {
        const state = await this.deps.reconcile(entry.snapshot).catch(() => "unknown" as const);
        if (state === "live" || state === "unknown") {
          this.record(entry, "uncertain", "Native startup did not confirm success; reconcile the live/unknown attempt before retrying", memory);
          this.unresolved.set(entry.snapshot.nodeId, entry.snapshot);
        } else this.record(entry, "complete", "Startup returned a refusal; no unresolved native process observed", memory);
      } else this.record(entry, "complete", "Startup finished; bounded pacing completed, not a guarantee against a later memory peak", memory);
      entry.resolve(result);
    } catch (error) {
      const dispatched = entry.snapshot.dispatchedAt !== undefined;
      try { this.record(entry, dispatched ? "uncertain" : entry.cancelled ? "cancelled" : "complete",
        dispatched ? "Startup outcome is unknown; reconcile before retrying" : "Startup stopped before native dispatch; no native input sent"); } catch { /* Preserve the original failure if event storage itself failed. */ }
      if (dispatched) this.unresolved.set(entry.snapshot.nodeId, entry.snapshot);
      entry.reject(error);
    } finally {
      this.active--; this.entries.delete(entry.snapshot.nodeId);
      void this.pump();
    }
  }
}
