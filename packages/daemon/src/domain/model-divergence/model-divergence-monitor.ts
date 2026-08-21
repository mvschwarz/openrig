// B8 / slice-07 A3 — MODEL-DIVERGENCE DETECTOR + four-channel proclamation (founder-ruled).
//
// DETECT THE DIVERGENCE, NOT THE CAUSES (pm-ruled): the trigger is one comparison — the runtime's
// EFFECTIVE model vs the seat's PINNED model — at the earliest reliable read. No cause enumeration:
// specimen #1 was model-invalid (400 silently degraded), specimen #2 was environment-invalid (a
// missing --add-dir degraded the tier); a 400-handler catches one and misses the other, this
// comparison catches both. The cause string, when known, rides the proclamation as DIAGNOSIS only.
//
// "AT READINESS", operationally: the check ARMS when a pinned seat's occupant generation appears
// and FIRES at the first reliable effective-model read. A claude seat has no assistant turn at
// readiness (the effective signal does not exist yet), so the monitor polls and each generation
// stays PENDING until its runtime produces the signal — then exactly ONE verdict per generation.
// Every-occurrence semantics live at the generation grain: every new occupant of a diverged seat
// proclaims again (founder-classed every-occurrence, not digest), while one generation never spams.
//
// FOUR CHANNELS, per the desk's target ruling (2026-08-21): orchestrator = the seat's own rig's
// orch.* seats; operator = the seat resolved from the workspace operator config (derived, never
// hardcoded — may be cross-host); oversight = the fleet oversight judgment seat (cross-host via the
// registered route); human-via-Slack = NAMED DEFERRAL ("deferred: M1 not landed") until the M1
// gateway contract lands — no shadow path. Every channel's delivery OUTCOME is recorded on the
// proclamation event; an unreachable channel is a named failure/deferral, never a silence.

export interface PinnedSeat {
  nodeId: string;
  sessionName: string;
  rigId: string;
  rigName: string;
  runtime: string | null;
  pinnedModel: string;
  /** Occupant generation (null = unknown; falls back to sessionName grain). */
  generation: string | null;
}

export interface ChannelOutcome {
  channel: "orchestrator" | "operator" | "oversight" | "slack";
  target: string | null;
  status: "delivered" | "failed" | "deferred";
  detail?: string;
}

export interface ModelDivergenceProclamation {
  nodeId: string;
  sessionName: string;
  rigId: string;
  rigName: string;
  runtime: string | null;
  pinnedModel: string;
  effectiveModel: string;
  diagnosis: string | null;
  detectedAt: string;
  channels: ChannelOutcome[];
}

/** D-a — the effective read carries a NAMED reason on every no-answer outcome, and may be async
 *  (the current-generation join reads the live process table). */
export type EffectiveModelRead = { ok: true; model: string } | { ok: false; reason: string };

export interface ModelDivergenceMonitorDeps {
  /** Every running canonical seat carrying a model pin (the detector's whole population). */
  listPinnedSeats: () => PinnedSeat[];
  /** Per-runtime effective read via the CURRENT GENERATION's own record (D-a: never a name/token
   *  lookup that can silently cross a generation boundary). No-answer = named reason = pending. */
  readEffectiveModel: (seat: PinnedSeat) => Promise<EffectiveModelRead> | EffectiveModelRead;
  /** In-daemon send to a session (the watchdog delivery seam). */
  sendToSession: (sessionName: string, message: string) => Promise<{ ok: boolean; error?: string }>;
  /** The seat's own rig's orchestrator seats (session names). */
  resolveOrchSeats: (rigName: string) => string[];
  /** The configured operator seat (derived from config, never hardcoded). Null = unconfigured. */
  resolveOperatorSeat: () => string | null;
  /** The fleet oversight judgment seat (cross-host target), or null when unroutable. */
  resolveOversightSeat: () => string | null;
  /** Durable record of the proclamation + its per-channel outcomes. */
  recordProclamation: (p: ModelDivergenceProclamation) => void;
  /** Optional cause string when a rejection signal is known (diagnosis, NEVER the trigger). */
  diagnose?: (seat: PinnedSeat) => string | null;
  now?: () => Date;
  warn?: (message: string) => void;
}

export const SLACK_DEFERRAL_LINE = "human-via-Slack: deferred: M1 not landed";

/** Polls a pinned generation may stay signal-less before it is loudly named as unchecked. */
export const PENDING_VISIBILITY_POLLS = 10;

export function formatProclamation(p: Omit<ModelDivergenceProclamation, "channels">): string {
  return [
    `MODEL DIVERGENCE on ${p.sessionName}: pinned=${p.pinnedModel} effective=${p.effectiveModel}`,
    `The seat is RUNNING (graceful degrade held) but on a model nobody chose.`,
    p.diagnosis ? `Diagnosis (informational): ${p.diagnosis}` : `Diagnosis: none captured — the divergence itself is the trigger.`,
    `Detected ${p.detectedAt} (runtime ${p.runtime ?? "unknown"}, node ${p.nodeId}).`,
  ].join("\n");
}

export class ModelDivergenceMonitor {
  /** Generations already given their one verdict (match or proclaimed divergence). */
  private readonly settled = new Set<string>();
  /** r1 B8 finding — OBSERVABLE PENDING: consecutive no-signal polls per generation. Detection
   *  silence is the failure class one layer under channel silence: a seat whose effective model
   *  never reads must be VISIBLE as never-checked, not skipped by a bare continue forever. */
  private readonly pendingPolls = new Map<string, number>();
  private readonly pendingReasons = new Map<string, string>();
  private readonly pendingWarned = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: ModelDivergenceMonitorDeps) {
    this.warn = deps.warn ?? ((m) => console.warn(m));
  }

  startPolling(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkOnce().catch((err) => this.warn(`[model-divergence] check failed: ${err instanceof Error ? err.message : String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Pinned generations currently pending (no effective read yet) with their poll counts — the
   *  observable face of detection-pending (tests + any future status surface). */
  pendingSeats(): Array<{ key: string; polls: number; reason: string | null }> {
    return [...this.pendingPolls.entries()].map(([key, polls]) => ({ key, polls, reason: this.pendingReasons.get(key) ?? null }));
  }

  /** One pass over the pinned population. Returns the proclamations fired this pass (for tests). */
  async checkOnce(): Promise<ModelDivergenceProclamation[]> {
    const fired: ModelDivergenceProclamation[] = [];
    for (const seat of this.deps.listPinnedSeats()) {
      const key = `${seat.nodeId}:${seat.generation ?? seat.sessionName}`;
      if (this.settled.has(key)) continue;
      const read = await this.deps.readEffectiveModel(seat);
      if (!read.ok) {
        // PENDING, never assumed — and never invisible: past the threshold this generation is
        // named ONCE as never-checked (r1 measured real codex rollouts whose signal sat outside
        // the bounded read; without this line such a seat would be skipped silently forever).
        const polls = (this.pendingPolls.get(key) ?? 0) + 1;
        this.pendingPolls.set(key, polls);
        this.pendingReasons.set(key, read.reason);
        if (polls >= PENDING_VISIBILITY_POLLS && !this.pendingWarned.has(key)) {
          this.pendingWarned.add(key);
          this.warn(
            `[model-divergence] ${seat.sessionName} (pin ${seat.pinnedModel}) has NO effective-model ` +
            `read after ${polls} polls — this seat is pinned but UNCHECKED (${read.reason}). ` +
            `A divergence here would currently be invisible.`,
          );
        }
        continue;
      }
      this.pendingPolls.delete(key);
      this.pendingReasons.delete(key);
      if (modelsMatch(seat.pinnedModel, read.model)) {
        this.settled.add(key);
        continue;
      }
      const proclamation = await this.proclaim(seat, read.model);
      this.settled.add(key);
      fired.push(proclamation);
    }
    return fired;
  }

  private async proclaim(seat: PinnedSeat, effectiveModel: string): Promise<ModelDivergenceProclamation> {
    const detectedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const base = {
      nodeId: seat.nodeId,
      sessionName: seat.sessionName,
      rigId: seat.rigId,
      rigName: seat.rigName,
      runtime: seat.runtime,
      pinnedModel: seat.pinnedModel,
      effectiveModel,
      diagnosis: this.deps.diagnose?.(seat) ?? null,
      detectedAt,
    };
    const message = formatProclamation(base);
    const channels: ChannelOutcome[] = [];

    const orchSeats = this.deps.resolveOrchSeats(seat.rigName);
    if (orchSeats.length === 0) {
      channels.push({ channel: "orchestrator", target: null, status: "failed", detail: `no orch seats found in rig ${seat.rigName}` });
    } else {
      for (const target of orchSeats) channels.push(await this.deliver("orchestrator", target, message));
    }

    const operator = this.deps.resolveOperatorSeat();
    channels.push(operator
      ? await this.deliver("operator", operator, message)
      : { channel: "operator", target: null, status: "failed", detail: "no operator seat configured" });

    const oversight = this.deps.resolveOversightSeat();
    channels.push(oversight
      ? await this.deliver("oversight", oversight, message)
      : { channel: "oversight", target: null, status: "deferred", detail: "deferred: no oversight route registered from this host" });

    // DS2 (founder-locked transport): Slack rides ONLY the M1 gateway contract. Until M1 lands this
    // channel refuses loudly with its named deferral — never an improvised shadow path.
    channels.push({ channel: "slack", target: null, status: "deferred", detail: SLACK_DEFERRAL_LINE });

    const proclamation: ModelDivergenceProclamation = { ...base, channels };
    try {
      this.deps.recordProclamation(proclamation);
    } catch (err) {
      this.warn(`[model-divergence] proclamation record failed for ${seat.sessionName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return proclamation;
  }

  private async deliver(channel: ChannelOutcome["channel"], target: string, message: string): Promise<ChannelOutcome> {
    try {
      const res = await this.deps.sendToSession(target, message);
      return res.ok
        ? { channel, target, status: "delivered" }
        : { channel, target, status: "failed", detail: res.error ?? "send failed" };
    } catch (err) {
      return { channel, target, status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Pin comparison: exact case-insensitive match, OR the pin as a WHOLE HYPHEN-TOKEN of the
 *  effective id. ~~"Deliberately NO prefix/alias fuzziness"~~ — REVERSED on live data (D-a): the
 *  fleet's real pins are SPEC aliases (nodes.model carries "fable"; the adapter passes the alias to
 *  the runtime, which accepts it and then reports the full id "claude-fable-5"). Under exact-match
 *  the detector would proclaim divergence on every healthy pinned claude seat — a false-positive
 *  storm the moment the claude leg works. Token containment keeps the comparison narrow: "fable"
 *  matches claude-fable-5; "opus" matches claude-opus-5; full-id pins (gpt-5.1-codex-mini) still
 *  require the exact id; a pin like "5" cannot match (numeric-only tokens are excluded). */
export function modelsMatch(pinned: string, effective: string): boolean {
  const pin = pinned.trim().toLowerCase();
  const eff = effective.trim().toLowerCase();
  if (pin === eff) return true;
  if (/^\d+(\.\d+)*$/.test(pin)) return false; // a bare version number is not an alias
  return eff.split("-").includes(pin);
}
