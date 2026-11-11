import { AGENT_RUNNER_PRESET, AGENT_RUNNER_HOSTED_PI_RPC } from "./session-registry.js";
import { ActivityGrantStore, type ActivityGrant, type RunGrantBinding } from "./activity-grants.js";
import { OutboxHandler, OutboxHandlerError, type RunnerAdmission, type RunnerReceipt } from "./outbox-handler.js";

/** Internal implementation kinds preserve the recorded 0/1/2 provenance codes. A plain builtin is not a runner. */
export function runnerChannelKind(binding: RunGrantBinding | null): "managed-pi" | "preset" | "hosted-pi-rpc" | null {
  if (binding?.runner === AGENT_RUNNER_PRESET) return "preset";
  if (binding?.runner === AGENT_RUNNER_HOSTED_PI_RPC) return "hosted-pi-rpc";
  return binding?.runner === 0 && binding.runtime === "pi" ? "managed-pi" : null;
}

export class RunnerChannelError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 409 | 503 = 409) { super(message); }
}
interface Capabilities { input: boolean; wake: boolean; cancel: false }

/** Run-filtered wire coordination only. Retained authority and custody belong to the grant and outbox stores. */
export class RunnerChannel {
  private readonly connections = new Map<string, number>();
  private readonly live = new Map<string, Capabilities>();
  private readonly listeners = new Set<() => void>();
  // Empty until actual consumers and their complete paths have passed their milestone review.
  constructor(private readonly grants: ActivityGrantStore, readonly outbox: OutboxHandler,
    private readonly implementedKinds: ReadonlySet<string> = new Set()) {}

  authenticate(token: string | undefined): ActivityGrant & { runId: string } {
    const grant = this.grants.authenticate(token);
    if (!grant?.runId) throw new RunnerChannelError("runner_grant_required", "A bound runner grant is required.", 401);
    const standing = this.grants.standing(grant.grantId);
    if (standing !== "current") throw new RunnerChannelError(`runner_grant_${standing}`, `Runner grant is ${standing}.`, standing === "revoked" ? 401 : 409);
    return grant as ActivityGrant & { runId: string };
  }

  capable(nodeId: string, kind: "input" | "wake"): boolean {
    const grant = this.grants.activeForNode(nodeId);
    return !!grant?.runId && this.grants.standing(grant.grantId) === "current" && (this.connections.get(grant.grantId) ?? 0) > 0 && this.live.get(grant.grantId)?.[kind] === true
      && !this.outbox.runnerReceipts(nodeId, grant.runId).some(receipt => receipt.reconciliation);
  }

  admit(nodeId: string, input: Omit<RunnerAdmission, "nodeId" | "runId">): RunnerReceipt {
    const grant = this.grants.activeForNode(nodeId);
    if (!grant?.runId || !this.capable(nodeId, input.kind))
      throw new RunnerChannelError("runner_unavailable", "No current capable native runner; input was not offered.");
    const receipt = this.outbox.admitRunner({ ...input, nodeId, runId: grant.runId });
    this.changed(); return receipt;
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
      const capabilities: Capabilities = { input: supported && declared.input === true, wake: supported && declared.wake === true, cancel: false };
      if (!body.retained) this.outbox.forgetRunnerMap(grant.nodeId, grant.runId);
      this.live.set(grant.grantId, capabilities);
      const receipts = this.outbox.runnerReceipts(grant.nodeId, grant.runId);
      this.changed();
      return { version: 1, runId: grant.runId, capabilities, minimumSequence: receipts[0]?.sequence ?? 0,
        maximumSequence: receipts.at(-1)?.sequence ?? 0, receipts, unresolved: receipts.filter(r => !r.erasedAt && !["completed", "rejected"].includes(r.stage)) };
    }
    if (!this.live.has(grant.grantId)) throw new RunnerChannelError("runner_hello_required", "Handshake required before receipts.");
    if (typeof body.requestId !== "string" || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1)
      throw new RunnerChannelError("invalid_runner_receipt", "Supply request ID and positive sequence.", 400);
    let stage: RunnerReceipt["stage"];
    if (body.type === "ack" && body.state === "accepted") stage = "accepted";
    else if (body.type === "submitted") stage = "submitted";
    else if (body.type === "result") stage = "completed";
    else if (body.type === "rejected") stage = "rejected";
    else throw new RunnerChannelError("invalid_runner_receipt", "Unknown channel receipt type.", 400);
    const evidence: Pick<RunnerReceipt, "acceptedTurnId" | "nativeTurnId" | "result"> = {};
    for (const key of ["acceptedTurnId", "nativeTurnId"] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== "string" || !body[key] || body[key].length > 1024) throw new RunnerChannelError("invalid_runner_receipt", `Invalid ${key}.`, 400);
        evidence[key] = body[key];
      }
    }
    if (stage === "completed" || stage === "rejected") {
      if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) throw new RunnerChannelError("invalid_runner_result", "Supply a native result.", 400);
      const receipt = this.outbox.runnerReceipt(body.requestId);
      const result = body.result as Record<string, unknown>;
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

  /** The cursor never acknowledges an offer. Retained accepted/results are reconciled through hello/lookup. */
  frames(token: string | undefined, cursor: number): RunnerReceipt[] {
    const grant = this.authenticate(token);
    if (!this.live.has(grant.grantId)) throw new RunnerChannelError("runner_hello_required", "Handshake required before subscription.");
    const receipts = this.outbox.runnerReceipts(grant.nodeId, grant.runId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > (receipts.at(-1)?.sequence ?? 0))
      throw new RunnerChannelError("invalid_runner_cursor", "Invalid run-local cursor.", 400);
    // Once custody is unknown, never automatically feed later saved prompts into that execution.
    if (receipts.some(receipt => receipt.reconciliation)) return [];
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
