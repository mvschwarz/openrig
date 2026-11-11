import { randomUUID } from "node:crypto";
import type { PiRunnerState } from "../adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { createPiComposerInspector, type PiComposerInspector } from "./pi-composer-inspector.js";

type PiSeat = { readonly nodeId: string; readonly sessionName: string; readonly runtime: string | null };
type PiCompactionReason = "runtime_filter" | "already_in_progress" | "unsupported" | "session_missing"
  | "mid_work" | "live_state_unavailable" | "send_failed" | "submit_failed"
  | "draft_input_busy" | "draft_input_unknown" | "draft_input_changed";
export type PiCompactionOutcome = { readonly triggered: true; readonly stage: "submitted_unconfirmed" }
  | { readonly triggered: false; readonly reason: PiCompactionReason };
type PiCompactionDeps = {
  readonly readSidecar: (session: string) => PiRunnerState | null;
  readonly resolveTarget: (seat: PiSeat) => string | null;
  readonly tmux: Pick<TmuxAdapter, "sendText" | "sendKeys">;
  readonly inspectComposer?: PiComposerInspector;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export class PiCompactionService {
  private readonly pending = new Set<string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inspectComposer: PiComposerInspector;

  constructor(private readonly deps: PiCompactionDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.inspectComposer = deps.inspectComposer ?? createPiComposerInspector(deps);
  }

  async trigger(seat: PiSeat): Promise<PiCompactionOutcome> {
    if (seat.runtime !== "pi") return { triggered: false, reason: "runtime_filter" };
    if (this.pending.has(seat.sessionName)) return { triggered: false, reason: "already_in_progress" };
    const prior = this.deps.readSidecar(seat.sessionName);
    if (this.getState(seat.sessionName).status === "unsupported") return { triggered: false, reason: "unsupported" };
    if (prior?.compaction?.startedAt && !prior.compaction.endedAt) return { triggered: false, reason: "already_in_progress" };
    const target = this.deps.resolveTarget(seat);
    if (!target) return { triggered: false, reason: "session_missing" };
    this.pending.add(seat.sessionName);
    const deadline = this.now() + 2000;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PiCompactionOutcome>(resolve => {
      timer = setTimeout(() => {
        expired = true;
        resolve({ triggered: false, reason: "live_state_unavailable" });
      }, 2000);
    });
    const gate = { seat, target, launchId: prior?.launchId, deadline,
      expired: () => expired || this.now() >= deadline };
    const run = async (): Promise<PiCompactionOutcome> => {
      const probe = await this.probe(gate);
      if ("reason" in probe) return { triggered: false, reason: probe.reason };
      if (probe.live.isStreaming || probe.live.isCompacting) return { triggered: false, reason: "mid_work" };
      const current = this.getState(seat.sessionName);
      if (current.status === "in_progress") return { triggered: false, reason: "already_in_progress" };
      if (current.status === "unsupported") return { triggered: false, reason: "unsupported" };
      const reason = await this.submitControl({ ...gate, text: "/openrig-compact" });
      return reason ? { triggered: false, reason } : { triggered: true, stage: "submitted_unconfirmed" };
    };
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      expired = true;
      clearTimeout(timer);
      this.pending.delete(seat.sessionName);
    }
  }

  getState(session: string) {
    const compaction = this.deps.readSidecar(session)?.compaction ?? null;
    const completionKey = compaction?.endedAt
      ? compaction.requestId ?? `${compaction.reason ?? "unknown"}:${compaction.endedAt}` : null;
    const status = !compaction ? "unknown"
      : compaction.errorMessage && /unknown command|unsupported|not supported/i.test(compaction.errorMessage) ? "unsupported"
      : compaction.endedAt ? compaction.errorMessage ? "failed" : compaction.aborted ? "aborted" : "completed"
      : compaction.startedAt ? "in_progress" : "unknown";
    return { status, compaction, completionKey };
  }

  private async submitControl(input: { readonly seat: PiSeat; readonly target: string; readonly text: string;
    readonly expired: () => boolean }): Promise<PiCompactionReason | null> {
    const inspect = { sessionName: input.seat.sessionName, target: input.target, expected: input.text };
    const before = await this.inspectComposer(inspect);
    if (input.expired()) return "live_state_unavailable";
    if (before === "unknown") return "draft_input_unknown";
    if (before !== "empty") return "draft_input_busy";
    const sent = await this.deps.tmux.sendText(input.target, input.text);
    if (input.expired()) return "live_state_unavailable";
    if (!sent.ok) return "send_failed";
    const after = await this.inspectComposer(inspect);
    if (input.expired()) return "live_state_unavailable";
    if (after === "unknown") return "draft_input_unknown";
    if (after !== "matched") return "draft_input_changed";
    const submitted = await this.deps.tmux.sendKeys(input.target, ["Enter"]);
    if (input.expired()) return "live_state_unavailable";
    return submitted.ok ? null : "submit_failed";
  }

  private async probe(input: { readonly seat: PiSeat; readonly target: string; readonly launchId: string | undefined;
    readonly deadline: number; readonly expired: () => boolean }): Promise<
      { readonly live: NonNullable<PiRunnerState["liveState"]> } | { readonly reason: PiCompactionReason }> {
    const sentAt = this.now();
    const probeId = randomUUID();
    const refusal = await this.submitControl({ ...input, text: `/openrig-state ${probeId}` });
    if (refusal) return { reason: refusal };
    while (!input.expired()) {
      const state = this.deps.readSidecar(input.seat.sessionName);
      if (state?.launchId !== input.launchId || state?.exited) return { reason: "live_state_unavailable" };
      const live = state?.liveState;
      if (live?.probeId === probeId && Date.parse(live.updatedAt) > sentAt && Date.parse(live.updatedAt) <= input.deadline) {
        if (state?.ready !== true || typeof live.isStreaming !== "boolean" || typeof live.isCompacting !== "boolean") return { reason: "live_state_unavailable" };
        return { live };
      }
      await this.sleep(Math.min(25, input.deadline - this.now()));
    }
    return { reason: "live_state_unavailable" };
  }
}
