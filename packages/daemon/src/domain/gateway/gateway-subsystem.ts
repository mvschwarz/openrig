// S10 (OPR.0.5.5.10) — the gateway as an IN-DAEMON SUBSYSTEM. M1 §3 as amended 2026-08-26
// (desk head-amendment under founder R2): the gateway runs in-process at daemon boot — the
// shipped components (GatewayDispatcher + DispatchBuffer) reused verbatim, NO child process,
// NO gateway↔connector socket wire. spawn-gateway.ts / gateway-process*.ts / transport.ts are
// the retired process-split shape and must not gain callers (second-deployable ABSENCE is a
// proof-contract red).
//
// Durability is the shipped contract, unchanged by the re-homing: a decision is persisted to
// the durable buffer BEFORE delivery is attempted (dispatcher enqueues first), drained ONLY
// after the delivery layer reports success (the in-process ack), and un-Acked decisions replay
// on every subsystem (re)start — a delivery failure is retained, never dropped.
//
// Failure honesty (mini-req 1): a wiring failure at start() surfaces as state=failed with the
// cause named, visible on the health surface — it never throws into daemon boot (a broken
// gateway must not take the daemon down) and never reads as silently active.

import { DispatchBuffer } from "./dispatch-buffer.js";
import { GatewayDispatcher, type DispatchResult } from "./dispatcher.js";
import type { OutboundDecision } from "./protocol.js";

/** The in-process delivery outcome (mirrors the retired connector's DeliveryOutcome shape so
 *  the slice-11 delivery semantics carry over verbatim at cutover). */
export type SubsystemDeliveryOutcome = { ok: true } | { ok: false; class: string; detail?: string };
export type SubsystemDeliverFn = (decision: OutboundDecision) => Promise<SubsystemDeliveryOutcome>;

/** What a wiring step yields: the live dispatcher plus its teardown. */
export interface GatewayWire {
  dispatcher: GatewayDispatcher;
  stop(): void;
}

export interface InProcessWireOpts {
  home: string;
  /** The platform delivery seam. Until the relay cutover wires Slack, startup passes an
   *  honest unwired refusal — dispatches are retained durably, never silently dropped. */
  deliver: SubsystemDeliverFn;
  /** Ops the delivery layer advertises. The shipped proof-9 rail holds in-process: an
   *  unadvertised op is refused, never attempted. Empty = nothing dispatchable yet. */
  ops?: string[];
  connectorId?: string;
  platform?: string;
  log?: (msg: string) => void;
}

/** Compose the SHIPPED dispatcher + durable buffer in-process. The capability handshake
 *  becomes a local declaration by the delivery layer (same closed contract, no socket);
 *  ack-after-delivery becomes deliver() resolving ok. replayPending() at build time is the
 *  restart no-loss leg: un-Acked decisions from a prior run re-enter delivery. */
export function buildInProcessWire(opts: InProcessWireOpts): GatewayWire {
  const log = opts.log ?? (() => {});
  const buffer = new DispatchBuffer(opts.home);
  const deliverAndAck = async (decision: OutboundDecision): Promise<void> => {
    let outcome: SubsystemDeliveryOutcome;
    try {
      outcome = await opts.deliver(decision);
    } catch (e) {
      outcome = { ok: false, class: "delivery-threw", detail: (e as Error).message };
    }
    if (outcome.ok) {
      dispatcher.onAck(decision.decisionId); // drain only after delivered
    } else {
      log(`delivery failed ${decision.decisionId} (${outcome.class}${outcome.detail ? ": " + outcome.detail : ""}) — retained for replay`);
    }
  };
  const dispatcher: GatewayDispatcher = new GatewayDispatcher({
    buffer,
    send: (decision) => { void deliverAndAck(decision); },
  });
  dispatcher.onCapability({
    kind: "capability",
    connectorId: opts.connectorId ?? "slack-subsystem",
    platform: opts.platform ?? "slack",
    protocolVersion: 1,
    ops: opts.ops ?? [],
  });
  dispatcher.replayPending();
  return { dispatcher, stop: () => { /* no socket, no timer — nothing to tear down yet */ } };
}

export type GatewaySubsystemState = "inactive" | "active" | "failed" | "stopped";

export interface GatewaySubsystemStatus {
  state: GatewaySubsystemState;
  /** Present iff state=failed: the named cause (honest failure, never a silent dead gateway). */
  reason?: string;
  activatedAt?: string;
  /** Durable un-delivered decisions awaiting delivery/replay (undefined until first start). */
  pendingDispatches?: number;
}

export interface GatewaySubsystemDeps {
  home: string;
  /** The wiring step. Production: () => buildInProcessWire({...}). Injectable so tests can
   *  induce a wiring failure and pin the honest-failure contract. */
  wire: () => GatewayWire;
  log?: (msg: string) => void;
  now?: () => Date;
}

export class GatewaySubsystem {
  private state: GatewaySubsystemState = "inactive";
  private reason: string | undefined;
  private activatedAt: string | undefined;
  private wireHandle: GatewayWire | undefined;

  constructor(private readonly deps: GatewaySubsystemDeps) {}

  /** Activate in-process. NEVER throws: a wiring failure records state=failed with the cause
   *  and returns — daemon boot proceeds and the health surface tells the truth. */
  start(): void {
    if (this.state === "active") return;
    try {
      this.wireHandle = this.deps.wire();
      this.state = "active";
      this.reason = undefined;
      this.activatedAt = (this.deps.now?.() ?? new Date()).toISOString();
      this.deps.log?.("gateway subsystem active (in-process)");
    } catch (e) {
      this.state = "failed";
      this.reason = (e as Error).message;
      this.wireHandle = undefined;
      this.deps.log?.(`gateway subsystem FAILED to activate: ${this.reason}`);
    }
  }

  /** Dispatch through the live wire (refused honestly when not active). */
  dispatch(op: string, entityBindingRef: string, payload: unknown): DispatchResult {
    if (this.state !== "active" || !this.wireHandle) {
      return { ok: false, error: `dispatch refused: gateway subsystem is ${this.state}${this.reason ? ` (${this.reason})` : ""}` };
    }
    return this.wireHandle.dispatcher.dispatch(op, entityBindingRef, payload);
  }

  status(): GatewaySubsystemStatus {
    const s: GatewaySubsystemStatus = { state: this.state };
    if (this.reason !== undefined) s.reason = this.reason;
    if (this.activatedAt !== undefined) s.activatedAt = this.activatedAt;
    if (this.state === "active" || this.state === "failed") {
      try {
        s.pendingDispatches = new DispatchBuffer(this.deps.home).pending().length;
      } catch { /* buffer unreadable — omit rather than lie */ }
    }
    return s;
  }

  /** Recovery half of recovers-or-reports: tear down and re-run the wiring. */
  restart(): void {
    this.stop();
    this.state = "inactive";
    this.start();
  }

  stop(): void {
    try { this.wireHandle?.stop(); } catch { /* best-effort */ }
    this.wireHandle = undefined;
    if (this.state !== "failed") this.state = "stopped";
    this.deps.log?.("gateway subsystem stopped");
  }
}
