import { randomUUID } from "node:crypto";
import type { PiRunnerState } from "../adapters/pi-runner-protocol.js";
import type { SendOpts, SendResult } from "./session-transport.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { TerminalPolicyRefusal, type TerminalActor } from "./terminal-policy.js";

type PiSeat = { readonly nodeId: string; readonly sessionName: string; readonly runtime: string | null };
type PiCompactionRecord = NonNullable<PiRunnerState["compaction"]>;

/**
 * A manual Pi compaction request. The attempt id is minted here, carried by the
 * reserved `/openrig-compact <id>` input into the runner's native compact
 * command, and reported back by the sidecar record it stamps. The requested
 * result is therefore always separable from an automatic run.
 */
export type PiCompactionOutcome =
  | { readonly triggered: true; readonly attemptId: string; readonly stage: "submitted_unconfirmed" | "uncertain" }
  | { readonly triggered: false; readonly reason: string; readonly detail?: string };

/** Statuses of the REQUESTED attempt only; an automatic run is reported separately. */
export type PiCompactionStatus = "not_requested" | "uncertain" | "completed" | "failed" | "aborted" | "unsupported";
export type PiCompactionState = {
  readonly status: PiCompactionStatus;
  readonly attemptId: string | null;
  readonly requestedAt?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** How an uncertain attempt is uncertain: it may have been submitted, or it started without an end. */
  readonly phase?: "submitted_no_result" | "started_no_end";
  readonly result?: PiCompactionRecord["result"];
  readonly errorMessage?: string;
  readonly aborted?: boolean;
  readonly willRetry?: boolean;
  /** A run that isn't this request, normally an automatic threshold/overflow one. Never this request's answer. */
  readonly automatic: PiCompactionRecord | null;
};

type SendEffect = Pick<SendResult, "ok" | "sent" | "outcome" | "reason" | "inputPhase" | "error">;
type PiCompactionDeps = {
  readonly readSidecar: (session: string) => PiRunnerState | null;
  /** The agent's ordinary guarded send path: session transport + delivery guard. */
  readonly send: (sessionName: string, text: string, opts: Pick<SendOpts, "openrigNotice" | "beforeWrite">) => Promise<SendEffect>;
  readonly terminalPolicies?: { check(nodeId: string, action: "compaction", actor: TerminalActor): unknown };
  readonly now?: () => number;
  readonly newAttemptId?: () => string;
};

type RequestedAttempt = { readonly attemptId: string; readonly launchId: string | null; readonly submittedAt: string };

const UNSUPPORTED = /unknown command|unsupported|not supported/i;

export class PiCompactionService {
  private readonly requested = new Map<string, RequestedAttempt>();
  private readonly now: () => number;
  private readonly newAttemptId: () => string;

  constructor(private readonly deps: PiCompactionDeps) {
    this.now = deps.now ?? Date.now;
    this.newAttemptId = deps.newAttemptId ?? randomUUID;
  }

  async trigger(seat: PiSeat, actor: TerminalActor = { source: "caller", session: null }): Promise<PiCompactionOutcome> {
    if (seat.runtime !== "pi") return { triggered: false, reason: "runtime_filter" };
    // The same actor policy the Claude path applies: caller attribution, unchanged self/peer/unattributed handling.
    const refusal = this.policyRefusal(seat.nodeId, actor);
    if (refusal) return { triggered: false, ...refusal };
    const prior = this.deps.readSidecar(seat.sessionName);
    if (UNSUPPORTED.test(prior?.compaction?.errorMessage ?? "")) return { triggered: false, reason: "unsupported" };
    if (this.getState(seat.sessionName).status === "uncertain") return { triggered: false, reason: "already_in_progress" };
    if (prior?.compaction?.startedAt && !prior.compaction.endedAt) return { triggered: false, reason: "already_in_progress" };

    const attemptId = this.newAttemptId();
    const launchId = prior?.launchId ?? null;
    // The guard re-checks node, session, occupant and pane at the write and at
    // Enter. This bound launch check runs at those same two moments, so a
    // request cannot reach a replacement occupant or a rebound runner.
    const beforeWrite = () => {
      if (launchId === null) return;
      if (this.deps.readSidecar(seat.sessionName)?.launchId !== launchId) {
        throw new DeliveryGuardError("launch_changed", "The runner launch changed; no OpenRig compaction input was written.");
      }
    };
    let result: SendEffect;
    try {
      result = await this.deps.send(seat.sessionName, `/openrig-compact ${attemptId}`, { openrigNotice: true, beforeWrite });
    } catch (error) {
      // The guarded send throws once a write may have been issued. A guard refusal
      // before any write is a refusal; anything later is an uncertain attempt.
      const tagged = error as { inputWritten?: boolean; inputAttempted?: boolean; message?: string };
      if (tagged?.inputWritten === true || tagged?.inputAttempted === true) {
        this.remember(seat.sessionName, attemptId, launchId);
        return { triggered: true, attemptId, stage: "uncertain" };
      }
      if (error instanceof DeliveryGuardError) return { triggered: false, reason: error.code, detail: error.message };
      return { triggered: false, reason: "send_failed", ...(tagged?.message ? { detail: tagged.message } : {}) };
    }
    if (result.ok && result.outcome !== "retained") {
      this.remember(seat.sessionName, attemptId, launchId);
      return { triggered: true, attemptId, stage: "submitted_unconfirmed" };
    }
    // Text or Enter may have reached the seat. Report the attempt as uncertain:
    // never "was not started" once submission is possible.
    if (result.inputPhase === "written" || result.inputPhase === "attempted" || result.sent === true) {
      this.remember(seat.sessionName, attemptId, launchId);
      return { triggered: true, attemptId, stage: "uncertain" };
    }
    if (result.outcome === "retained") {
      return { triggered: false, reason: "held", detail: "The seat's delivery guard held the request; no compaction input was written." };
    }
    if (result.inputPhase === "not_reached" || result.sent === false) {
      return { triggered: false, reason: result.reason ?? "send_failed", ...(result.error ? { detail: result.error } : {}) };
    }
    // No positive pre-input result: the write outcome is unknown, so the request
    // may have been submitted. Keep it as an uncertain attempt rather than deny it.
    this.remember(seat.sessionName, attemptId, launchId);
    return { triggered: true, attemptId, stage: "uncertain" };
  }

  /**
   * The requested attempt's status, scoped to its launch. A record from an
   * automatic run, or from an earlier request, never answers a newer one: with
   * no matching record the attempt reads `uncertain`, not completed.
   */
  getState(session: string): PiCompactionState {
    const sidecar = this.deps.readSidecar(session);
    return this.attemptState(this.requested.get(session) ?? null, sidecar);
  }

  private remember(session: string, attemptId: string, launchId: string | null): void {
    this.requested.set(session, { attemptId, launchId, submittedAt: new Date(this.now()).toISOString() });
  }

  private attemptState(requested: RequestedAttempt | null, sidecar: PiRunnerState | null): PiCompactionState {
    const record = sidecar?.compaction ?? null;
    const automatic = record && !record.attemptId ? record : null;
    // After a daemon restart the in-memory request is gone, but the sidecar's
    // attempt id still names the run the runner carried.
    const attemptId = requested?.attemptId ?? record?.attemptId ?? null;
    if (!attemptId) return { status: "not_requested", attemptId: null, automatic };
    // Scoped to the launch that received the request: a record from another runner
    // launch never answers it, even if it somehow names the same attempt id.
    const sameLaunch = requested?.launchId == null || sidecar == null || sidecar.launchId === requested.launchId;
    const scoped = record?.attemptId === attemptId && sameLaunch ? record : null;
    const requestedAt = requested?.submittedAt;
    if (scoped?.endedAt) {
      const status: PiCompactionStatus = UNSUPPORTED.test(scoped.errorMessage ?? "") ? "unsupported"
        : scoped.aborted ? "aborted" : scoped.errorMessage ? "failed" : "completed";
      return {
        status, attemptId, ...(requestedAt ? { requestedAt } : {}),
        ...(scoped.startedAt ? { startedAt: scoped.startedAt } : {}), endedAt: scoped.endedAt,
        ...(scoped.result !== undefined ? { result: scoped.result } : {}),
        ...(scoped.errorMessage ? { errorMessage: scoped.errorMessage } : {}),
        ...(scoped.aborted !== undefined ? { aborted: scoped.aborted } : {}),
        ...(scoped.willRetry !== undefined ? { willRetry: scoped.willRetry } : {}),
        automatic,
      };
    }
    if (scoped?.startedAt) {
      return { status: "uncertain", phase: "started_no_end", attemptId, ...(requestedAt ? { requestedAt } : {}),
        startedAt: scoped.startedAt, automatic };
    }
    // A request this daemon made, or a record that named an attempt, with no
    // matching result yet: submission (or its start) is possible, so uncertain.
    return { status: "uncertain", phase: "submitted_no_result", attemptId,
      ...(requestedAt ? { requestedAt } : {}), automatic };
  }

  private policyRefusal(nodeId: string, actor: TerminalActor): { reason: "terminal_policy_refused" | "terminal_policy_unavailable"; detail?: string } | null {
    if (!this.deps.terminalPolicies) return null;
    try {
      this.deps.terminalPolicies.check(nodeId, "compaction", actor);
      return null;
    } catch (error) {
      if (error instanceof TerminalPolicyRefusal) return { reason: "terminal_policy_refused", detail: error.message };
      return actor.source === "openrig" ? null : { reason: "terminal_policy_unavailable" };
    }
  }
}
