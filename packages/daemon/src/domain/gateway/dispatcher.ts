// M1 A4a — the gateway MODULE's core logic (the OS process's brain), transport-injected so
// it is unit-testable without a real socket. The thin spawn wrapper + the unix-socket
// transport wire this to the connector; here is the ruled behavior (contract a305310d):
//   - handshake: until a CapabilityDescriptor arrives, dispatch is refused.
//   - dispatch: an op MUST be advertised (proof-9: unadvertised = refused, NOT attempted);
//     durable-FIRST (enqueue to the dispatch buffer before send).
//   - ack: drains the decision from the buffer (ack-gated drain).
//   - replayPending: on (re)connect, re-send every un-Acked decision — connector-outage ->
//     no-loss; decisionId keeps the re-send a byte-identical dup, never a second record.

import { randomUUID } from "node:crypto";
import type { DispatchBuffer } from "./dispatch-buffer.js";
import { isAdvertisedOp, type CapabilityDescriptor, type OutboundDecision } from "./protocol.js";

export interface DispatcherDeps {
  buffer: DispatchBuffer;
  /** The transport write (a framed unix-socket send in prod; an in-memory sink in tests). */
  send: (decision: OutboundDecision) => void;
  /** Injectable id source (tests pin decisionIds; prod = a UUID). */
  newDecisionId?: () => string;
}

export type DispatchResult =
  | { ok: true; decisionId: string }
  | { ok: false; error: string };

export class GatewayDispatcher {
  private descriptor: CapabilityDescriptor | undefined;
  constructor(private readonly deps: DispatcherDeps) {}

  /** Handshake — record the connector's advertised capabilities. */
  onCapability(descriptor: CapabilityDescriptor): void {
    this.descriptor = descriptor;
  }

  get connectorId(): string | undefined {
    return this.descriptor?.connectorId;
  }

  /** Dispatch an outbound decision. proof-9: pre-handshake OR an unadvertised op is REFUSED,
   *  never attempted. Durable-first: persisted to the buffer BEFORE the transport send. */
  dispatch(op: string, entityBindingRef: string, payload: unknown): DispatchResult {
    if (!this.descriptor) {
      return { ok: false, error: "dispatch refused: no capability descriptor yet (handshake incomplete)" };
    }
    if (!isAdvertisedOp(this.descriptor, op)) {
      return { ok: false, error: `dispatch refused: op "${op}" is not advertised by connector ${this.descriptor.connectorId} (unadvertised ops are refused, not attempted)` };
    }
    const decisionId = (this.deps.newDecisionId ?? randomUUID)();
    const decision: OutboundDecision = { kind: "outbound_decision", decisionId, op, entityBindingRef, payload };
    this.deps.buffer.enqueue(decision); // durable BEFORE dispatch
    this.deps.send(decision);
    return { ok: true, decisionId };
  }

  /** The connector Acked a decision — drain it from the durable buffer. */
  onAck(decisionId: string): void {
    this.deps.buffer.ack(decisionId);
  }

  /** On (re)connect: re-send every un-Acked decision (no-loss across a connector outage). */
  replayPending(): void {
    for (const decision of this.deps.buffer.pending()) this.deps.send(decision);
  }
}
