import type { SessionProbe, TmuxResult } from "../adapters/tmux.js";
import type { AttachmentKind } from "./attachment-kind.js";
import type { ForkSource, HarnessLaunchResult, NodeBinding, ReadinessResult, RuntimeAdapter } from "./runtime-adapter.js";
import type { CaptureResult, SendOpts, SendResult } from "./session-transport.js";
import type { SessionRegistry } from "./session-registry.js";
import type { AgentActivity } from "./types.js";

// Seat kinds: what launches, reaches and observes a seat, keyed by `bindings.attachment_type`.
// The daemon's own kinds are built in: "tmux" (today's pane-driven code) and "external_cli"
// (outbound only: every inbound path refuses). An embedder may register further kinds through
// `createDaemon({ seatKinds })` for seats whose agent runs somewhere other than a tmux pane.
// No kind is registered by default, so every path below takes today's tmux code unchanged.

export type { AttachmentKind };

export const BUILT_IN_ATTACHMENT_KINDS: readonly string[] = ["tmux", "external_cli"];

/** The registry row a seat interface acts on, read once at entry. */
export interface SeatRef {
  nodeId: string | null;
  /** The seat's canonical name: the tmux session, or `bindings.external_session_name`. */
  sessionName: string;
  runtime: string | null;
  kind: AttachmentKind;
  /** tmux only. */
  pane: string | null;
  /** The occupant generation bound to the seat, when known. */
  occupant: string | null;
}

/** Make, start, check and stop the seat. */
export interface SeatHost {
  /** Make the seat's container before any DB write. The returned fields go in the binding row. */
  create(req: SeatCreateRequest): Promise<SeatCreateResult>;
  /** Start the agent. tmux: `adapter.launchHarness`. A resume is a launch with `resumeToken`. */
  launch(binding: NodeBinding, adapter: RuntimeAdapter,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult>;
  /** tmux: `adapter.checkReady`. */
  checkReady(binding: NodeBinding, adapter: RuntimeAdapter): Promise<ReadinessResult>;
  /** Positive absence only: `absent` must mean the seat is known to be gone. */
  probe(ref: SeatRef): Promise<SessionProbe>;
  /** `session_not_found` for a seat already gone, as tmux kill-session reports. */
  stop(ref: SeatRef): Promise<TmuxResult>;
}

export interface SeatCreateRequest {
  nodeId: string;
  rigName: string;
  sessionName: string;
  cwd?: string;
  env: Record<string, string>;
  /** A one-off `rig up --env` set: the names, and the env the seat would have without them. */
  oneOffEnv?: { names: string[]; baseline: Record<string, string> };
}

export type SeatCreateResult =
  /** `binding` is tmux's; a registered kind's seat is bound by its session name
   *  (`bindings.external_session_name`). */
  | { ok: true; binding: { tmuxSession?: string; tmuxPane?: string };
      /** tmux: the sole-pane observation the launch records with the binding. */
      paneObservation?: import("./pane-binding-observation.js").PaneBindingObservation;
      warnings: string[] }
  | { ok: false; code: string; message: string };

/** Reach the agent in the seat. Called by SessionTransport after target resolution, inside the
 *  delivery guard's lease, so a kind sees one write at a time per seat. */
export interface SeatInbound {
  /** Deliver one message, or answer why not. Honors the SendOpts it understands. */
  deliver(ref: SeatRef, text: string, opts: SendOpts): Promise<SendResult>;
  capture(ref: SeatRef, lines: number): Promise<CaptureResult>;
}

/** A one-shot activity reading (inventory, `rig ps`, wait-for-idle). Continuous activity for a
 *  seat without a pane arrives over the existing hook and self-report routes. */
export interface SeatActivityProbe {
  probe(ref: SeatRef, now: Date): Promise<AgentActivity>;
}

export interface SeatKind {
  readonly kind: AttachmentKind;
  readonly host: SeatHost;
  readonly inbound: SeatInbound;
  readonly activity: SeatActivityProbe;
}

export class SeatKindRegistry {
  private kinds = new Map<string, SeatKind>();

  constructor(kinds: readonly SeatKind[] = []) {
    for (const kind of kinds) this.register(kind);
  }

  register(kind: SeatKind): void {
    if (BUILT_IN_ATTACHMENT_KINDS.includes(kind.kind)) throw new Error(`Seat kind '${kind.kind}' is built in and cannot be replaced`);
    if (this.kinds.has(kind.kind)) throw new Error(`Seat kind '${kind.kind}' is already registered`);
    this.kinds.set(kind.kind, kind);
  }

  /** True when any kind beyond the built-ins is registered. Call sites check this first, so a
   *  daemon with none does no extra reads. */
  hasCustom(): boolean { return this.kinds.size > 0; }

  /** The registered kind for this attachment type; null for tmux, external_cli and unknown. */
  custom(kind: string | null | undefined): SeatKind | null {
    return kind ? this.kinds.get(kind) ?? null : null;
  }

  /** The registered kind whose binding names this node's session, with its ref; null when the
   *  session belongs to a built-in kind. */
  forNode(sessionRegistry: Pick<SessionRegistry, "getBindingForNode">, nodeId: string, sessionName: string,
    runtime: string | null = null): { kind: SeatKind; ref: SeatRef } | null {
    if (!this.hasCustom()) return null;
    const binding = sessionRegistry.getBindingForNode(nodeId);
    const kind = this.custom(binding?.attachmentType);
    if (!binding || !kind || binding.externalSessionName !== sessionName) return null;
    return { kind, ref: { nodeId, sessionName, runtime, kind: kind.kind, pane: null, occupant: null } };
  }
}
