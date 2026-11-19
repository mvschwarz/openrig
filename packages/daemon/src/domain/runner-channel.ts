import { EventBus } from "./event-bus.js";
import { AGENT_RUNNER_PRESET, AGENT_RUNNER_HOSTED_PI_RPC } from "./session-registry.js";
import { ActivityGrantStore, type ActivityGrant, type RunGrantBinding } from "./activity-grants.js";
import { OutboxHandler, OutboxHandlerError, type RunnerAdmission, type RunnerReceipt } from "./outbox-handler.js";

/** Internal implementation kinds preserve the recorded 0/1/2 provenance codes. A plain builtin is not a runner. */
export function runnerChannelKind(binding: RunGrantBinding | null): "managed-pi" | "preset" | "hosted-pi-rpc" | null {
  if (binding?.runner === AGENT_RUNNER_PRESET) return "preset";
  if (binding?.runner === AGENT_RUNNER_HOSTED_PI_RPC) return "hosted-pi-rpc";
  return binding?.runner === 0 && (binding.runtime === "pi" || binding.runtime === "omp") ? "managed-pi" : null;
}

export class RunnerChannelError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 409 | 503 = 409, readonly retryable = false) { super(message); }
}
interface Capabilities { input: boolean; wake: boolean; cancel: boolean }

/** Run-filtered wire coordination only. Retained authority and custody belong to the grant and outbox stores. */
export class RunnerChannel {
  private readonly connections = new Map<string, number>();
  private readonly live = new Map<string, Capabilities>();
  private readonly listeners = new Set<() => void>();
  // Implemented contract families, not program names or inferred qualification of compatible forks.
  constructor(private readonly grants: ActivityGrantStore, readonly outbox: OutboxHandler,
    private readonly implementedKinds: ReadonlySet<string> = new Set(["managed-pi", "preset", "hosted-pi-rpc"]),
    private readonly events = new EventBus(outbox.db)) {}

  /** A failed standing read cannot establish replacement or revoke retained custody. */
  private standing(grantId: string): ReturnType<ActivityGrantStore["standing"]> {
    try { return this.grants.standing(grantId); } catch { return "unverified"; }
  }

  authenticate(token: string | undefined): ActivityGrant & { runId: string } {
    const grant = this.grants.authenticate(token);
    if (!grant?.runId) throw new RunnerChannelError("runner_grant_required", "A bound runner grant is required.", 401);
    const standing = this.standing(grant.grantId);
    if (standing !== "current") throw new RunnerChannelError(`runner_grant_${standing}`, `Runner grant is ${standing}.`, standing === "revoked" ? 401 : 409);
    return grant as ActivityGrant & { runId: string };
  }

  capable(nodeId: string, kind: "input" | "wake" | "cancel"): boolean {
    const grant = this.grants.activeForNode(nodeId);
    return !!grant?.runId && this.standing(grant.grantId) === "current" && (this.connections.get(grant.grantId) ?? 0) > 0 && this.live.get(grant.grantId)?.[kind] === true
      && !this.outbox.hasRunnerReconciliation(nodeId, grant.runId);
  }

  admit(nodeId: string, input: Omit<RunnerAdmission, "nodeId" | "runId">): RunnerReceipt {
    const grant = this.grants.activeForNode(nodeId);
    if (!grant?.runId || !this.capable(nodeId, input.kind))
      throw new RunnerChannelError("runner_unavailable", "No current capable native runner; input was not offered.");
    const receipt = this.outbox.admitRunner({ ...input, nodeId, runId: grant.runId });
    this.changed(); return receipt;
  }

  cancel(nodeId: string, input: { requestId: string; sender: string; destination: string; target: { runId: string; nativeTurnId: string } }): RunnerReceipt {
    const { target } = input;
    const admitted = { outboxId: input.requestId, senderSession: input.sender, destinationSession: input.destination,
      body: `cancel ${target.runId} ${target.nativeTurnId}`, nodeId, runId: target.runId, kind: "cancel" as const,
      inputRoute: "native" as const, payload: { target } };
    const prior = this.outbox.runnerReceipt(input.requestId);
    if (prior) return this.outbox.admitRunner(admitted);
    const current = this.currentTurn(nodeId, true);
    const matching = current?.runId === target.runId && current.nativeTurnId === target.nativeTurnId;
    let unsupported = false;
    if (matching) {
      const grant = this.grants.activeForNode(nodeId), standing = grant ? this.standing(grant.grantId) : null;
      if (!grant?.runId || grant.runId !== target.runId || standing !== "current")
        throw new RunnerChannelError("runner_unavailable", "Current runner authority could not be verified; retry this ID after recovery.", 409, true);
      const kind = runnerChannelKind(grant.binding);
      unsupported = kind === null || !this.implementedKinds.has(kind) || this.live.get(grant.grantId)?.cancel === false;
      if (!unsupported && !this.capable(nodeId, "cancel"))
        throw new RunnerChannelError("runner_unavailable", "No live verified cancellation connection; retry this ID after recovery.", 409, true);
    }
    let receipt = this.outbox.admitRunner(admitted);
    if (!matching || unsupported) {
      receipt = this.outbox.updateRunner(nodeId, target.runId, input.requestId, receipt.sequence, "offered");
      receipt = this.outbox.updateRunner(nodeId, target.runId, input.requestId, receipt.sequence, "accepted");
      receipt = this.outbox.updateRunner(nodeId, target.runId, input.requestId, receipt.sequence, "completed",
        { result: { kind: "cancel", outcome: matching ? "not-supported" : "not-this-turn", confirmed: false } });
    }
    this.changed(); return receipt;
  }

  prepareCancellation(token: string | undefined, body: Record<string, unknown>,
    withdraw: (grant: ActivityGrant & { runId: string }, target: { runId: string; nativeTurnId: string }) => { confirmed: boolean; pendingSubmissions: number; withdrawn: number }): Record<string, unknown> {
    const grant = this.authenticate(token), receipt = typeof body.requestId === "string" ? this.outbox.runnerReceipt(body.requestId) : null;
    if (!receipt || receipt.kind !== "cancel" || receipt.runId !== grant.runId || body.runId !== grant.runId || receipt.nodeId !== grant.nodeId
      || receipt.sequence !== body.sequence || receipt.stage !== "accepted" || receipt.erasedAt || receipt.reconciliation)
      throw new RunnerChannelError("runner_request_mismatch", "Preparation requires this run's accepted cancellation receipt.");
    const target = receipt.payload.target as { runId: string; nativeTurnId: string };
    const current = this.currentTurn(grant.nodeId, true);
    if (current?.runId !== target.runId || current.nativeTurnId !== target.nativeTurnId)
      return { receipt, withdrawal: { confirmed: false, pendingSubmissions: 0, notThisTurn: true } };
    if (receipt.withdrawal?.stage === "confirmed") return { receipt, withdrawal: { confirmed: true, pendingSubmissions: 0, withdrawn: receipt.withdrawal.withdrawn } };
    // Retain the start before calling an owner that may withdraw some asks and then fail.
    this.outbox.recordRunnerWithdrawal(grant.nodeId, grant.runId, receipt.requestId, receipt.sequence, { confirmed: false, pendingSubmissions: 0, withdrawn: receipt.withdrawal?.withdrawn ?? 0 });
    const evidence = withdraw(grant, target);
    const updated = this.outbox.recordRunnerWithdrawal(grant.nodeId, grant.runId, receipt.requestId, receipt.sequence, evidence);
    this.changed(); return { receipt: updated, withdrawal: evidence };
  }

  post(token: string | undefined, raw: unknown): Record<string, unknown> {
    const grant = this.authenticate(token);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RunnerChannelError("invalid_runner_post", "Supply a channel object.", 400);
    const body = raw as Record<string, unknown>;
    if (body.runId !== grant.runId) throw new RunnerChannelError("runner_run_mismatch", "Post names another run.");
    if (body.type === "hello") {
      const declared = body.capabilities as Record<string, unknown> | undefined;
      if (body.version !== 1 || typeof body.retained !== "boolean" || !declared
        || ["input", "wake", "cancel"].some(key => typeof declared[key] !== "boolean"))
        throw new RunnerChannelError("invalid_runner_hello", "Supply version 1, retained state and explicit capabilities.", 400);
      // The contract is generic across apps. Recorded runner kind/version and a live declaration bound to this
      // actual run authorize an optional operation; neither a wrapper nor hello establishes program qualification.
      const kind = runnerChannelKind(grant.binding);
      const supported = kind !== null && this.implementedKinds.has(kind);
      // The shared hosted RPC path implements input for OMP/forks, not Pi's invocation mapping.
      const mappedInvocation = kind === "preset" || grant.binding?.runtime === "pi" && grant.binding.runner === 0;
      const capabilities: Capabilities = { input: supported && declared.input === true,
        wake: supported && mappedInvocation && declared.wake === true, cancel: supported && mappedInvocation && declared.cancel === true };
      if (!body.retained) {
        this.outbox.forgetRunnerMap(grant.nodeId, grant.runId);
        // Person turns and completed input may have no unresolved receipt. A not-retained report invalidates prior
        // epoch evidence; a fresh run's first empty hello, or a temporary SSE disconnect, has no such meaning.
        if (!this.runnerMapLost(grant.nodeId, grant.runId) && this.outbox.db.prepare(`SELECT 1 FROM events
          WHERE node_id=? AND type='agent.runner_turn' AND json_extract(payload,'$.runId')=? LIMIT 1`).get(grant.nodeId, grant.runId))
          this.events.emit({ type: "agent.runner_map_lost", nodeId: grant.nodeId, runId: grant.runId });
      }
      this.live.set(grant.grantId, capabilities);
      const receipts = this.outbox.runnerReceipts(grant.nodeId, grant.runId);
      this.changed();
      return { version: 1, runId: grant.runId, capabilities, minimumSequence: receipts[0]?.sequence ?? 0,
        maximumSequence: receipts.at(-1)?.sequence ?? 0, receipts, unresolved: receipts.filter(r => !r.erasedAt && !["completed", "rejected"].includes(r.stage)) };
    }
    if (!this.live.has(grant.grantId)) throw new RunnerChannelError("runner_hello_required", "Handshake required before receipts.");
    if (body.type === "turn") return this.recordTurn(grant, body);
    if (typeof body.requestId !== "string" || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1)
      throw new RunnerChannelError("invalid_runner_receipt", "Supply request ID and positive sequence.", 400);
    let stage: RunnerReceipt["stage"];
    if (body.type === "ack" && body.state === "accepted") stage = "accepted";
    else if (body.type === "submitted") stage = "submitted";
    else if (body.type === "result") stage = "completed";
    else if (body.type === "rejected") stage = "rejected";
    else throw new RunnerChannelError("invalid_runner_receipt", "Unknown channel receipt type.", 400);
    const pending = this.outbox.runnerReceipt(body.requestId);
    if (pending?.kind === "cancel" && stage === "submitted" && (pending.withdrawal?.stage !== "confirmed" || body.result === undefined))
      throw new RunnerChannelError("runner_withdrawal_unconfirmed", "Native cancellation submission requires confirmed permission withdrawal.");
    const evidence: Pick<RunnerReceipt, "acceptedTurnId" | "nativeTurnId" | "result"> = {};
    for (const key of ["acceptedTurnId", "nativeTurnId"] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== "string" || !body[key] || body[key].length > 1024) throw new RunnerChannelError("invalid_runner_receipt", `Invalid ${key}.`, 400);
        evidence[key] = body[key];
      }
    }
    if (stage === "completed" || stage === "rejected" || stage === "submitted" && body.result !== undefined) {
      if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) throw new RunnerChannelError("invalid_runner_result", "Supply a native result.", 400);
      const receipt = this.outbox.runnerReceipt(body.requestId);
      const result = body.result as Record<string, unknown>;
      if (result.continuation !== undefined) {
        const continuation = result.continuation as Record<string, unknown> | null;
        const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100
          && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 1024) && new Set(value).size === value.length;
        if (receipt?.kind !== "cancel" || stage !== "completed" || result.outcome !== "requested" || result.confirmed !== false
          || !continuation || typeof continuation !== "object" || Array.isArray(continuation)
          || !ids(continuation.inputRequestIds) || !ids(continuation.pendingRequestIds)
          || !Number.isSafeInteger(continuation.unmatchedCount) || Number(continuation.unmatchedCount) < 0
          || Object.keys(continuation).some(key => !["inputRequestIds", "pendingRequestIds", "unmatchedCount"].includes(key)))
          throw new RunnerChannelError("invalid_runner_result", "Invalid native continuation evidence.", 400);
      }
      const retiredBeforeWrite = receipt?.kind === "cancel" && stage === "rejected" && result.kind === "cancel"
        && result.applied === false && typeof result.reason === "string" && result.reason.trim().length > 0
        && result.outcome === undefined && (result.confirmed === undefined || result.confirmed === false) && (result.operationAccepted === undefined || result.operationAccepted === false);
      if (receipt?.kind === "cancel" && !retiredBeforeWrite && (result.kind !== "cancel" || !["requested", "cancelled", "not-this-turn", "not-supported"].includes(String(result.outcome))
        || typeof result.confirmed !== "boolean" || stage === "submitted" && result.outcome !== "requested"
        || result.confirmed !== (result.outcome === "cancelled") || result.operationAccepted !== undefined && typeof result.operationAccepted !== "boolean")) throw new RunnerChannelError("invalid_runner_result", "Invalid cancellation outcome.", 400);
      if (receipt?.kind !== "cancel" && result.kind === "cancel") throw new RunnerChannelError("invalid_runner_result", "Cancellation result belongs to another operation.", 400);
      if (result.ownershipUnknown !== undefined && (result.ownershipUnknown !== true || receipt?.kind !== "wake" || stage !== "completed"
        || result.kind !== "wake" || result.completion !== "unknown" || result.answer !== null))
        throw new RunnerChannelError("invalid_runner_result", "Unknown native ownership requires an unknown wake with no answer.", 400);
      if (result.submissionUnknown !== undefined && (result.submissionUnknown !== true || result.completion !== "unknown" || result.accepted === true))
        throw new RunnerChannelError("invalid_runner_result", "Submission uncertainty cannot claim native acceptance or a completed answer.", 400);
      if (receipt?.kind === "wake" && stage === "completed" && (result.kind !== "wake"
        || !["completed", "interrupted", "failed", "unknown"].includes(String(result.completion))
        || !(typeof result.answer === "string" || result.answer === null)
        || result.completion !== "completed" && result.answer !== null))
        throw new RunnerChannelError("invalid_runner_result", "Invalid attributed wake result.", 400);
      evidence.result = result;
    }
    try {
      const receipt = this.outbox.updateRunner(grant.nodeId, grant.runId, body.requestId, Number(body.sequence), stage, evidence);
      this.changed(); return { receipt };
    } catch (error) {
      if (error instanceof OutboxHandlerError) throw new RunnerChannelError(error.code, error.message);
      throw error;
    }
  }

  /** Receipt evidence across runs; history is not a claim that all later input is blocked. */
  unresolved(nodeId: string): Record<string, unknown>[] {
    const runId = this.grants.activeForNode(nodeId)?.runId;
    return this.outbox.runnerRecovery(nodeId).map(receipt => ({ ...receipt, inCurrentRun: receipt.runId === runId }));
  }

  /** Current authenticated invocation evidence, never a claim that absence means idle. */
  currentTurn(nodeId: string, requireKnown = false): { runId: string; nativeTurnId: string; acceptedTurnIds: string[] } | null {
    const grant = this.grants.activeForNode(nodeId);
    if (!grant?.runId) {
      if (requireKnown) throw new RunnerChannelError("runner_unavailable", "Native turn ownership is unknown; no cancellation outcome was inferred.");
      return null;
    }
    const standing = this.standing(grant.grantId);
    if (standing === "unverified" || standing === "pending") {
      if (requireKnown) throw new RunnerChannelError(`runner_grant_${standing}`, `Runner grant is ${standing}.`, 409, true);
      return null;
    }
    if (standing !== "current") {
      if (requireKnown) throw new RunnerChannelError("runner_unavailable", "Native turn ownership is unknown; no cancellation outcome was inferred.");
      return null;
    }
    if (this.runnerMapLost(nodeId, grant.runId)) {
      if (requireKnown) throw new RunnerChannelError("runner_unavailable", `Native turn ownership is unknown for the rest of run ${grant.runId}; only a new run clears this cancellation-target refusal.`);
      return null;
    }
    if (this.outbox.hasRunnerReconciliation(nodeId, grant.runId)) {
      if (requireKnown) throw new RunnerChannelError("runner_unavailable", "Native turn ownership is unknown; no cancellation outcome was inferred.");
      return null;
    }
    const row = this.outbox.db.prepare(`SELECT payload FROM events WHERE node_id=? AND type='agent.runner_turn'
      AND json_extract(payload,'$.runId')=? ORDER BY json_extract(payload,'$.sequence') DESC LIMIT 1`).get(nodeId, grant.runId) as { payload: string } | undefined;
    if (!row) {
      if (requireKnown) throw new RunnerChannelError("runner_unavailable", "Native turn ownership is unknown; no cancellation outcome was inferred.");
      return null;
    }
    const report = JSON.parse(row.payload);
    return report.state === "opened" ? { runId: grant.runId, nativeTurnId: report.nativeTurnId, acceptedTurnIds: report.acceptedTurnIds } : null;
  }

  private runnerMapLost(nodeId: string, runId: string): boolean {
    return !!this.outbox.db.prepare(`SELECT 1 FROM events WHERE node_id=? AND type='agent.runner_map_lost'
      AND json_extract(payload,'$.runId')=? LIMIT 1`).get(nodeId, runId);
  }

  private recordTurn(grant: ActivityGrant & { runId: string }, body: Record<string, unknown>): Record<string, unknown> {
    const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 1024;
    if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1 || !validId(body.nativeTurnId)
      || !["opened", "closed"].includes(String(body.state)) || !Array.isArray(body.acceptedTurnIds)
      || body.acceptedTurnIds.length > 10000 || !body.acceptedTurnIds.every(validId)
      || new Set(body.acceptedTurnIds).size !== body.acceptedTurnIds.length)
      throw new RunnerChannelError("invalid_runner_turn", "Supply epoch, state, positive family sequence and distinct accepted turn IDs.", 400);
    const report = { type: "agent.runner_turn" as const, nodeId: grant.nodeId, runId: grant.runId, sequence: Number(body.sequence),
      nativeTurnId: body.nativeTurnId, state: body.state as "opened" | "closed", acceptedTurnIds: body.acceptedTurnIds as string[] };
    const rows = this.outbox.db.prepare(`SELECT payload FROM events WHERE node_id=? AND type='agent.runner_turn'
      AND json_extract(payload,'$.runId')=? ORDER BY json_extract(payload,'$.sequence') DESC`).all(grant.nodeId, grant.runId) as { payload: string }[];
    const prior = rows.map(row => JSON.parse(row.payload));
    const duplicate = prior.find(row => row.sequence === report.sequence);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(report)) throw new RunnerChannelError("runner_turn_conflict", "Turn sequence reused with different evidence.");
      return { accepted: true };
    }
    if (prior[0] && report.sequence <= prior[0].sequence) throw new RunnerChannelError("runner_turn_stale", "Turn sequence regressed.");
    // A closed epoch cannot reopen; later report updates to an open epoch may only add accepted IDs.
    const same = prior.find(row => row.nativeTurnId === report.nativeTurnId);
    if (!same && report.state === "closed") throw new RunnerChannelError("runner_turn_conflict", "Epoch was never opened.");
    if (same && (same.state === "closed" || same.acceptedTurnIds.some((id: string) => !report.acceptedTurnIds.includes(id))))
      throw new RunnerChannelError("runner_turn_conflict", "Epoch closed or accepted mapping regressed.");
    if (prior[0]?.state === "opened" && prior[0].nativeTurnId !== report.nativeTurnId)
      throw new RunnerChannelError("runner_turn_conflict", "Another native epoch remains open.");
    this.events.emit(report); this.changed(); return { accepted: true };
  }

  /** The cursor never acknowledges an offer. Retained accepted/results are reconciled through hello/lookup. */
  frames(token: string | undefined, cursor: number): RunnerReceipt[] {
    const grant = this.authenticate(token);
    if (!this.live.has(grant.grantId)) throw new RunnerChannelError("runner_hello_required", "Handshake required before subscription.");
    const receipts = this.outbox.runnerReceipts(grant.nodeId, grant.runId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > (receipts.at(-1)?.sequence ?? 0))
      throw new RunnerChannelError("invalid_runner_cursor", "Invalid run-local cursor.", 400);
    // Once custody is unknown, never automatically feed later saved prompts into that execution.
    if (receipts.some(receipt => receipt.kind !== "cancel" && receipt.reconciliation)) return [];
    const control = receipts.find(r => r.kind === "cancel" && ["pending", "offered"].includes(r.stage) && !r.erasedAt && !r.reconciliation);
    if (control) return [control.stage === "offered" ? control : this.outbox.updateRunner(grant.nodeId, grant.runId, control.requestId, control.sequence, "offered")];
    const offered = receipts.find(r => r.stage === "offered" && !r.reconciliation && !r.erasedAt);
    if (offered) return [offered];
    const pending = receipts.find(r => r.stage === "pending" && !r.reconciliation && !r.erasedAt);
    return pending ? [this.outbox.updateRunner(grant.nodeId, grant.runId, pending.requestId, pending.sequence, "offered")] : [];
  }

  connect(token: string | undefined): () => void {
    const grant = this.authenticate(token);
    if (!this.live.has(grant.grantId)) throw new RunnerChannelError("runner_hello_required", "Handshake required before subscription.");
    this.connections.set(grant.grantId, (this.connections.get(grant.grantId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      const count = (this.connections.get(grant.grantId) ?? 1) - 1;
      if (count > 0) this.connections.set(grant.grantId, count); else this.connections.delete(grant.grantId);
    };
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }
}
