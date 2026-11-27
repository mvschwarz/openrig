import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EventBus } from "./event-bus.js";
import type { SeatLifecycleService } from "./seat-lifecycle-service.js";
import type { SeatDeliveryGuard } from "./seat-delivery-guard.js";
import type { ResumeTokenDeriveResult } from "./resume-token-capture.js";
import type { NodeInventoryEntry } from "./types.js";
import { getNodeInventory } from "./node-inventory.js";
import { reapEligibility, type ReaperActivity } from "./seat-reaper-eligibility.js";
import { readSeatReaperSettings, type SeatReaperSettings } from "./seat-reaper-settings.js";
import { SeatReaperStore } from "./seat-reaper-store.js";
import { reapWorkspacePaths, probeReapWorkspace, type WorkspaceProbe } from "./seat-reaper-workspace.js";
import type { SeatReapedEvent } from "./seat-reaper-events.js";

/** The in-lease workspace re-check runs inside the seat's delivery lease, so it gets a
 * TOTAL deadline: each git call is bounded (10 s) but a rig with many repos could
 * otherwise hold the lease for minutes and delay that seat's queued work. */
const WORKSPACE_RECHECK_DEADLINE_MS = 20_000;

function settleWithin<T>(promise: Promise<T>, deadlineMs: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), deadlineMs);
    timer.unref?.();
    promise.then(value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); });
  });
}

export interface SeatReaperDeps {
  readonly db: Database.Database;
  readonly eventBus: EventBus;
  readonly lifecycle: Pick<SeatLifecycleService, "stopPrecondition" | "stopSeat">;
  readonly guard?: Pick<SeatDeliveryGuard, "lifecycle">;
  readonly activity: { getSeatStateBySession(name: string): ReaperActivity | null };
  readonly capture: (seat: NodeInventoryEntry) => Promise<ResumeTokenDeriveResult>;
  readonly settings?: () => SeatReaperSettings;
  readonly now?: () => number;
  readonly workspaceProbe?: (paths: readonly string[]) => Promise<WorkspaceProbe>;
  /** Test seam for the in-lease re-check deadline; production keeps the 20 s default. */
  readonly workspaceRecheckDeadlineMs?: number;
  /** #3836 review: a seat owing a post-compact restore stage can read idle-at-prompt while
   *  the stage is still owed — reap-proof it (checked both before the threshold and in-lease). */
  readonly postCompactStagePending?: (sessionName: string) => boolean;
}

export class SeatReaperService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private shuttingDown = false;
  private activePass: Promise<void> | null = null;
  private activated = false;
  private failures = 0;
  private lastTick: number | null = null;
  private passId = "";
  private failed = false;
  private ended = false;
  private readonly store: SeatReaperStore;
  private readonly now: () => number;

  constructor(private readonly deps: SeatReaperDeps) {
    this.store = new SeatReaperStore(deps.db); this.now = deps.now ?? Date.now;
  }
  start(): void {
    if (this.timer || this.ended || this.shuttingDown) return;
    this.timer = setInterval(() => { void this.tick().catch(error => console.error("[seat-reaper] pass failed", error)); }, 60_000);
    this.timer.unref();
  }
  stop(): void {
    // Shutdown: no new passes start; a pass already in flight is awaited via drain()
    // (its capture persisted, so a stop it was about to make is skipped, not lost silently).
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
  }
  /** #3836 review: awaits the in-flight pass (capture / workspace check / stopSeat) so a
   *  daemon shutdown cannot exit with the pass's effect or uncertainty receipt unwritten. */
  drain(): Promise<void> { return this.activePass ?? Promise.resolve(); }

  async tick(): Promise<void> {
    if (this.running || this.ended || this.shuttingDown) return;
    this.running = true; this.failed = false; this.passId = randomUUID();
    const pass = this.runPass();
    this.activePass = pass;
    try { await pass; } finally { this.running = false; if (this.activePass === pass) this.activePass = null; }
  }

  private async runPass(): Promise<void> {
    try {
      const settings = (this.deps.settings ?? readSeatReaperSettings)();
      if (!settings.enabled) {
        if (this.activated) this.store.resetClocks();
        this.activated = false; this.lastTick = null; this.failures = 0; return;
      }
      if (this.store.terminalReason()) { this.ended = true; this.stop(); return; }
      const at = this.now();
      if (!this.activated || this.lastTick === null || at - this.lastTick > 120_000 || at < this.lastTick) this.store.resetClocks();
      this.activated = true; this.lastTick = at;
      if (this.store.recentEffects(at) >= settings.maxReapsPer24h) { this.terminate("reap-cap"); return; }
      const rigs = z.array(z.object({ id: z.string(), name: z.string(), workspace_json: z.string().nullable() }))
        .parse(this.deps.db.prepare("SELECT id,name,workspace_json FROM rigs WHERE archived_at IS NULL ORDER BY id").all());
      for (const rig of rigs) {
        const seats = getNodeInventory(this.deps.db, rig.id);
        if (rig.name === "coordination" || settings.protectedRigs.includes(rig.name) || !settings.optInRigs.includes(rig.name)) {
          for (const seat of seats) this.store.reset(seat.nodeId);
          continue;
        }
        let workspace: WorkspaceProbe;
        try {
          const paths = reapWorkspacePaths(rig.workspace_json, seats.flatMap(s => s.cwd ? [s.cwd] : []));
          workspace = await (this.deps.workspaceProbe ?? probeReapWorkspace)(paths);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          workspace = "defer-probe-failed";
        }
        if (workspace !== "clean") {
          for (const seat of seats) { this.store.reset(seat.nodeId); this.emitDecisionOnce(seat.nodeId, workspace, { rigId: rig.id }); }
          this.failed ||= workspace === "defer-probe-failed"; continue;
        }
        for (const seat of seats) {
          if (this.ended || this.shuttingDown) break;
          await this.consider(seat, settings, async () => {
            const currentRig = z.object({ workspace_json: z.string().nullable() }).parse(
              this.deps.db.prepare("SELECT workspace_json FROM rigs WHERE id=? AND archived_at IS NULL").get(rig.id));
            const probe = (this.deps.workspaceProbe ?? probeReapWorkspace)(reapWorkspacePaths(currentRig.workspace_json,
              getNodeInventory(this.deps.db, rig.id).flatMap(s => s.cwd ? [s.cwd] : [])));
            return settleWithin(probe, this.deps.workspaceRecheckDeadlineMs ?? WORKSPACE_RECHECK_DEADLINE_MS, "defer-probe-failed" as WorkspaceProbe);
          });
        }
        if (this.ended || this.shuttingDown) break;
      }
      this.failures = this.failed ? this.failures + 1 : 0;
      if (this.failures >= 3) this.terminate("failed-passes");
    } catch (error) {
      this.store.resetClocks();
      this.emit({ phase: "decision", decision: "defer-probe-failed" });
      if (++this.failures >= 3) this.terminate("failed-passes");
      if (!(error instanceof Error)) throw error;
      console.warn("[seat-reaper] defer-probe-failed", { passId: this.passId, error: error.name });
    }
  }

  /** Review finding (slice 2): a decision event per seat per tick flooded the ledger
   * (~72k rows/day on a 50-seat fleet). Emit a seat's decision when it CHANGES, and at
   * most once an hour while it stays the same — the receipt events are unaffected. */
  private readonly lastDecision = new Map<string, { decision: string; at: number }>();
  private emitDecisionOnce(nodeId: string, decision: string, extra: Record<string, unknown> = {}): void {
    const previous = this.lastDecision.get(nodeId);
    const now = this.now();
    if (previous && previous.decision === decision && now - previous.at < 3_600_000) return;
    this.lastDecision.set(nodeId, { decision, at: now });
    this.emit({ phase: "decision", nodeId, decision, ...extra });
  }

  private async consider(seat: NodeInventoryEntry, settings: SeatReaperSettings, workspaceCheck: () => Promise<WorkspaceProbe>): Promise<void> {
    const guard = this.deps.guard;
    if (!guard || !seat.canonicalSessionName) {
      this.store.reset(seat.nodeId);
      if (!guard) { this.failed = true; this.emitDecisionOnce(seat.nodeId, "defer-probe-failed"); }
      return;
    }
    let attempted = false;
    try {
      await guard.lifecycle([seat.nodeId], async () => {
        const current = getNodeInventory(this.deps.db, seat.rigId).find(s => s.nodeId === seat.nodeId);
        if (!current?.canonicalSessionName) { this.store.reset(seat.nodeId); return; }
        const proof = reapEligibility(this.deps.db, current, this.deps.activity.getSeatStateBySession(current.canonicalSessionName));
        if (!proof.eligible || !proof.session || !proof.generation) {
          this.store.reset(seat.nodeId);
          this.emitDecisionOnce(seat.nodeId,
            proof.snapshot.activity === "unknown" ? "defer-probe-failed" : proof.snapshot.inbox > 0 ? "pending-work" : "ineligible",
            { rigId: seat.rigId });
          return;
        }
        const since = this.store.observe({ nodeId: seat.nodeId, sessionId: proof.session.id, generation: proof.generation, activitySeq: proof.activitySeq }, this.now());
        if (since === null || Math.floor((this.now() - since) / 60_000) < settings.idleThresholdMinutes) return;
        // #3836 review: a seat owing a post-compact restore stage reads idle at the prompt
        // with an empty inbox; reaping it would stop the seat before its restore runs. The
        // idle clock keeps running (observe above) — the stage makes the seat not reapable-YET,
        // not not-idle — so it reaps on the first tick after the stage settles.
        if (this.deps.postCompactStagePending?.(current.canonicalSessionName)) {
          this.emitDecisionOnce(seat.nodeId, "post-compact-stage-owed", { rigId: seat.rigId });
          return;
        }
        if (since === null || Math.floor((this.now() - since) / 60_000) < settings.idleThresholdMinutes) return;
        const common = { rigId: seat.rigId, rigName: seat.rigName, nodeId: seat.nodeId, sessionName: current.canonicalSessionName,
          idleMinutes: Math.floor((this.now() - since) / 60_000), thresholdMinutes: settings.idleThresholdMinutes,
          eligibility: { ...proof.snapshot, workspace: "clean" as const, protectedRig: false as const, optedIn: true as const, deliveryLease: true as const } };
        if (settings.observe) { this.emitDecisionOnce(seat.nodeId, "would-reap-observe", common); return; }
        const liveSettings = (this.deps.settings ?? readSeatReaperSettings)();
        if (!liveSettings.enabled || liveSettings.observe || !liveSettings.optInRigs.includes(seat.rigName) || liveSettings.protectedRigs.includes(seat.rigName)) {
          this.store.reset(seat.nodeId); return;
        }
        if (this.store.recentEffects(this.now()) >= liveSettings.maxReapsPer24h) { this.terminate("reap-cap"); return; }
        const precondition = this.deps.lifecycle.stopPrecondition(current.canonicalSessionName);
        if ("code" in precondition || precondition.expected.nodeId !== seat.nodeId || precondition.expected.sessionId !== proof.session.id) {
          this.store.reset(seat.nodeId); this.failed = true; return;
        }
        const captured = await this.deps.capture(current);
        if (captured.outcome !== "captured" || captured.token !== proof.session.resume_token) {
          this.store.reset(seat.nodeId); this.failed = true;
          this.emitDecisionOnce(seat.nodeId, "defer-probe-failed", common); return;
        }
        const workspace = await workspaceCheck();
        if (workspace !== "clean") {
          for (const member of getNodeInventory(this.deps.db, seat.rigId)) this.store.reset(member.nodeId);
          this.failed ||= workspace === "defer-probe-failed";
          this.emitDecisionOnce(seat.nodeId, workspace, common); return;
        }
        const finalSettings = (this.deps.settings ?? readSeatReaperSettings)();
        if (!finalSettings.enabled || finalSettings.observe || !finalSettings.optInRigs.includes(seat.rigName)
          || finalSettings.protectedRigs.includes(seat.rigName) || Math.floor((this.now() - since) / 60_000) < finalSettings.idleThresholdMinutes) {
          this.store.reset(seat.nodeId); return;
        }
        if (this.store.recentEffects(this.now()) >= finalSettings.maxReapsPer24h) { this.terminate("reap-cap"); return; }
        const refreshed = getNodeInventory(this.deps.db, seat.rigId).find(s => s.nodeId === seat.nodeId);
        if (!refreshed) { this.store.reset(seat.nodeId); return; }
        const after = reapEligibility(this.deps.db, refreshed, this.deps.activity.getSeatStateBySession(current.canonicalSessionName));
        if (!after.eligible || after.activitySeq !== proof.activitySeq || after.session?.id !== proof.session.id || after.generation !== proof.generation) {
          this.store.reset(seat.nodeId); return;
        }
        if (this.shuttingDown) { this.store.reset(seat.nodeId); return; }
        if (this.deps.postCompactStagePending?.(current.canonicalSessionName)) {
          this.emitDecisionOnce(seat.nodeId, "post-compact-stage-owed", common); return;
        }
        this.emit({ ...common, phase: "capture", sessionId: proof.session.id, resumeToken: captured.token, resumeType: captured.resumeType });
        const finalProof = reapEligibility(this.deps.db, current, this.deps.activity.getSeatStateBySession(current.canonicalSessionName));
        if (!finalProof.eligible || finalProof.activitySeq !== proof.activitySeq) { this.store.reset(seat.nodeId); return; }
        attempted = true;
        const result = await this.deps.lifecycle.stopSeat({ seatRef: current.canonicalSessionName, expected: precondition.expected,
          reason: "idle_reap", operator: "daemon:seat-reaper" });
        const budgetConsumed = result.ok || !!result.partialEffect;
        const attentionRequired = !result.ok && (result.code === "stop_uncertain" || !!result.partialEffect);
        this.store.reset(seat.nodeId);
        if (attentionRequired) this.store.attention(seat.nodeId);
        this.emit({ ...common, phase: "effect", result, budgetConsumed, attentionRequired,
          stopPhase: result.ok ? "completed" : result.stopPhase ?? "none" });
        this.failed ||= !result.ok;
        if (attentionRequired) { this.terminate("stop_uncertain"); return; }
        if (this.store.recentEffects(this.now()) >= liveSettings.maxReapsPer24h) this.terminate("reap-cap");
      });
    } catch (error) {
      this.store.reset(seat.nodeId); this.failed = true;
      if (attempted) { this.store.attention(seat.nodeId); this.terminate("stop_uncertain"); }
      this.emitDecisionOnce(seat.nodeId, "defer-probe-failed", { rigId: seat.rigId });
      if (!(error instanceof Error)) throw error;
    }
  }

  private terminate(reason: string): void {
    this.store.terminate(reason); this.ended = true; this.stop();
    this.emit({ phase: "terminal", decision: reason });
  }
  private emit(event: Omit<SeatReapedEvent, "type" | "passId" | "timestampMs" | "operator" | "reason">): void {
    this.deps.eventBus.emit({ ...event, type: "seat.reaped", passId: this.passId, timestampMs: this.now(), operator: "daemon:seat-reaper", reason: "idle_reap" });
  }
}
