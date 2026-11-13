import { randomUUID } from "node:crypto";
import type { PiCompactionRecord, PiRunnerState } from "../adapters/pi-runner-protocol.js";
import type { SendOpts, SendResult } from "./session-transport.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { TerminalPolicyRefusal, type TerminalActor } from "./terminal-policy.js";
import type { PiCompactionRequest, PiCompactionRequestStore } from "./pi-compaction-request-store.js";

type PiSeat = { readonly nodeId: string; readonly sessionName: string; readonly runtime: string | null };

/**
 * A manual Pi compaction request. The attempt id is minted here, carried by the
 * reserved `/openrig-compact <id>` input into the runner's native compact
 * command, and reported back by the sidecar record it stamps. The requested
 * result is therefore always separable from an automatic run.
 */
export type PiCompactionOutcome =
  | { readonly triggered: true; readonly attemptId: string; readonly stage: "submitted_unconfirmed" | "uncertain"; readonly detail?: string }
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

type SendEffect = Pick<SendResult, "ok" | "sent" | "outcome" | "reason" | "inputPhase" | "error" | "warning">;
type PiCompactionSendOpts = Pick<SendOpts, "openrigNotice" | "beforeWrite" | "waitForIdleMs" | "allowUnknownWhileIdle">;
type PiCompactionDeps = {
  readonly readSidecar: (session: string) => PiRunnerState | null;
  /** The agent's ordinary guarded send path: session transport + delivery guard. */
  readonly send: (sessionName: string, text: string, opts: PiCompactionSendOpts) => Promise<SendEffect>;
  readonly terminalPolicies?: { check(nodeId: string, action: "compaction", actor: TerminalActor): unknown };
  readonly now?: () => number;
  readonly newAttemptId?: () => string;
  readonly requestStore?: Pick<PiCompactionRequestStore, "get" | "set" | "delete">;
};

type RequestedAttempt = PiCompactionRequest;

const UNSUPPORTED = /unknown command|unsupported|not supported/i;
/** The transport's own send-readiness window, as the Claude compaction send uses for its idle wait. */
const PI_COMPACTION_IDLE_WAIT_MS = 15_000;

export class PiCompactionService {
  private readonly requested = new Map<string, RequestedAttempt>();
  /** One send per seat: a second caller before the first send resolves gets its attempt id. */
  private readonly inFlight = new Map<string, Promise<PiCompactionOutcome>>();
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
    // A request already awaiting its send holds another call; two callers share one send and its id.
    const running = this.inFlight.get(seat.sessionName);
    if (running) return running;
    const attempt = this.request(seat);
    this.inFlight.set(seat.sessionName, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(seat.sessionName);
    }
  }

  private async request(seat: PiSeat): Promise<PiCompactionOutcome> {
    const prior = this.deps.readSidecar(seat.sessionName);
    if (UNSUPPORTED.test(prior?.compaction?.errorMessage ?? "") || UNSUPPORTED.test(prior?.requestedCompaction?.errorMessage ?? "")) {
      return { triggered: false, reason: "unsupported" };
    }
    // Runner-confirmed RPCs and open runs are in flight. A draft-only or otherwise
    // unconfirmed attempt reads uncertain without holding later requests.
    if (prior?.compaction?.startedAt && !prior.compaction.endedAt) return { triggered: false, reason: "already_in_progress" };
    if (prior?.pendingCompaction && !prior.exited) return { triggered: false, reason: "already_in_progress" };

    const attemptId = this.newAttemptId();
    const launchId = prior?.launchId ?? null;
    const saved = this.savedRequest(seat.sessionName);
    const previous = this.requested.get(seat.sessionName) ?? (saved && this.sameLaunch(saved.launchId, prior) ? saved : null);
    // Record the pending attempt BEFORE awaiting the send: a second caller sees it
    // in flight, and a refusal before any input restores what was current before it.
    this.remember(seat, attemptId, launchId);
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
      result = await this.deps.send(seat.sessionName, `/openrig-compact ${attemptId}`, {
        openrigNotice: true,
        beforeWrite,
        // The transport's bounded idle wait, as the Claude compaction send uses:
        // a working agent is waited for, an unknown reading still sends, and an
        // over-budget wait returns the transport's own not-idle reason.
        waitForIdleMs: PI_COMPACTION_IDLE_WAIT_MS,
        allowUnknownWhileIdle: true,
      });
    } catch (error) {
      // The guarded send throws once a write may have been issued. A guard refusal
      // before any write is a refusal; anything later is an uncertain attempt.
      const tagged = error as { inputWritten?: boolean; inputAttempted?: boolean; message?: string };
      if (tagged?.inputWritten === true || tagged?.inputAttempted === true) {
        return { triggered: true, attemptId, stage: "uncertain" };
      }
      this.restore(seat.sessionName, previous);
      if (error instanceof DeliveryGuardError) return { triggered: false, reason: error.code, detail: error.message };
      return { triggered: false, reason: "send_failed", ...(tagged?.message ? { detail: tagged.message } : {}) };
    }
    if (result.ok && result.outcome !== "retained") {
      return { triggered: true, attemptId, stage: "submitted_unconfirmed" };
    }
    // Text or Enter may have reached the seat. Report the attempt as uncertain:
    // never "was not started" once submission is possible.
    if (result.inputPhase === "written" || result.inputPhase === "attempted" || result.sent === true) {
      const detail = result.error ?? result.warning;
      return { triggered: true, attemptId, stage: "uncertain", ...(detail ? { detail } : {}) };
    }
    if (result.outcome === "retained") {
      this.restore(seat.sessionName, previous);
      return { triggered: false, reason: "held", detail: "The seat's delivery guard held the request; no compaction input was written." };
    }
    if (result.inputPhase === "not_reached" || result.sent === false) {
      this.restore(seat.sessionName, previous);
      return { triggered: false, reason: result.reason ?? "send_failed", ...(result.error ? { detail: result.error } : {}) };
    }
    // No positive pre-input result: the write outcome is unknown, so the request
    // may have been submitted. Keep it as an uncertain attempt rather than deny it.
    return { triggered: true, attemptId, stage: "uncertain" };
  }

  /**
   * The requested attempt's status, scoped to its launch. A record from an
   * automatic run, or from an earlier request, never answers a newer one: with
   * no matching record the attempt reads `uncertain`, not completed.
   */
  getState(session: string, nodeId?: string): PiCompactionState {
    const sidecar = this.deps.readSidecar(session);
    const saved = this.savedRequest(session);
    const requested = this.requested.get(session) ?? (saved && this.sameLaunch(saved.launchId, sidecar) ? saved : null);
    return this.attemptState(requested && (nodeId === undefined || requested.nodeId === nodeId) ? requested : null, sidecar);
  }

  private remember(seat: PiSeat, attemptId: string, launchId: string | null): void {
    const request = { nodeId: seat.nodeId, attemptId, launchId, submittedAt: new Date(this.now()).toISOString() };
    this.requested.set(seat.sessionName, request);
    this.persist(seat.sessionName, request);
  }

  private savedRequest(session: string): RequestedAttempt | null {
    try {
      return this.deps.requestStore?.get(session) ?? null;
    } catch {
      return null;
    }
  }

  private persist(session: string, request: RequestedAttempt): void {
    try {
      this.deps.requestStore?.set(session, request);
    } catch {
      return;
    }
  }

  private forget(session: string): void {
    this.requested.delete(session);
    try {
      this.deps.requestStore?.delete(session);
    } catch {
      return;
    }
  }

  private restore(session: string, request: RequestedAttempt | null): void {
    if (request === null) {
      this.forget(session);
      return;
    }
    this.requested.set(session, request);
    this.persist(session, request);
  }

  private sameLaunch(launchId: string | null, sidecar: PiRunnerState | null): boolean {
    return launchId == null || sidecar == null || sidecar.launchId === launchId;
  }

  private attemptState(requested: RequestedAttempt | null, sidecar: PiRunnerState | null): PiCompactionState {
    const latest = sidecar?.compaction ?? null;
    const automatic = latest && !latest.attemptId ? latest : null;
    // The attempt-stamped records: `requestedCompaction` keeps the last requested
    // result beside a later automatic run that replaced `compaction`, and
    // `pendingCompaction` names the newest input the runner took before its RPC.
    // After a daemon restart the in-memory request is gone, but these still name
    // the newest run, so an older completion never answers it.
    const latestAttempt = latest?.attemptId ? latest : null;
    const priorAttempt = sidecar?.requestedCompaction ?? null;
    const pending = sidecar?.pendingCompaction ?? null;
    const attemptId = requested?.attemptId ?? pending?.attemptId ?? latestAttempt?.attemptId ?? priorAttempt?.attemptId ?? null;
    if (!attemptId) return { status: "not_requested", attemptId: null, automatic };
    // Scoped to the launch that received the request: a record from another runner
    // launch never answers it, even if it somehow names the same attempt id.
    const sameLaunch = this.sameLaunch(requested?.launchId ?? null, sidecar);
    const record = latestAttempt?.attemptId === attemptId ? latestAttempt
      : priorAttempt?.attemptId === attemptId ? priorAttempt : null;
    const scoped = sameLaunch ? record : null;
    const requestedAt = requested?.submittedAt ?? pending?.requestedAt;
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
    // A request this daemon made, a pending input the runner recorded, or a record
    // that named an attempt, with no matching result yet: submission (or its
    // start) is possible, so uncertain.
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
