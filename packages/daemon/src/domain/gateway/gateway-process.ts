// ── RETIRED IN PLACE (S10, OPR.0.5.5.10) ────────────────────────────────────────────────
// The process-split gateway shape retired under the amended M1 §3 (desk head-amendment,
// founder R2): the gateway runs as an IN-DAEMON SUBSYSTEM (gateway-subsystem.ts) — no spawned
// gateway process, no gateway↔connector socket wire. This module keeps compiling and its
// tests keep passing as a historical component, but it MUST NOT gain a production caller:
// the second-deployable ABSENCE proof pins that (any spawned gateway process or open
// connector wire is the red). Kept in place rather than deleted per the spec-level ruling
// (delete-or-mark is builder discretion).
// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 A4a — the gateway OS PROCESS runner: the long-lived brain the daemon spawns. It out-dials
// the connector socket (transport.ts), and — critically — STAYS ALIVE across a connector outage.
//
// Liveness (lesson idle-process-needs-refd-handle): a connected socket is a ref'd libuv handle,
// but during an outage there is NO open socket, so the event loop would empty and the process
// would SILENTLY EXIT. A ref'd heartbeat interval is the keepalive AND the re-dial driver: while
// disconnected it re-dials every reconnectMs; while connected it is a cheap no-op. We never park
// on `new Promise(() => {})` (no ref'd handle -> silent exit) — the interval is the anchor.

import { DispatchBuffer } from "./dispatch-buffer.js";
import { connectGateway, type GatewayConnection } from "./transport.js";

export interface GatewayProcessOpts {
  socketPath: string;
  home?: string;
  /** Re-dial cadence while disconnected (also the heartbeat/keepalive tick). */
  reconnectMs?: number;
  onError?: (error: Error) => void;
  onProtocolError?: (error: string) => void;
}

export interface GatewayProcessHandle {
  /** The live connection (undefined between a drop and the next successful re-dial). */
  connection(): GatewayConnection | undefined;
  connected(): boolean;
  /** Tear down: clears the heartbeat and closes the socket (lets the process exit). */
  stop(): void;
}

/** Start the gateway process brain. Returns a handle for lifecycle/tests. Idempotent re-dials are
 *  safe: the durable buffer replays un-Acked decisions on every (re)connect (no-loss). */
export function runGatewayProcess(opts: GatewayProcessOpts): GatewayProcessHandle {
  const reconnectMs = opts.reconnectMs ?? 1000;
  const buffer = new DispatchBuffer(opts.home);
  let conn: GatewayConnection | undefined;
  let connected = false;
  let stopped = false;

  const dial = (): void => {
    if (stopped || connected) return;
    connected = true; // optimistic: onClose flips it back if the dial fails/drops
    conn = connectGateway({
      socketPath: opts.socketPath,
      buffer,
      onError: opts.onError,
      onProtocolError: opts.onProtocolError,
      onClose: () => { connected = false; conn = undefined; }, // heartbeat re-dials next tick
    });
  };

  dial();
  // Ref'd heartbeat: keeps the event loop alive during an outage AND drives re-dial. NOT unref'd —
  // the whole point is that the process does not exit while it owes the connector delivery.
  const heartbeat = setInterval(() => { if (!connected) dial(); }, reconnectMs);

  return {
    connection: () => conn,
    connected: () => connected,
    stop: () => {
      stopped = true;
      clearInterval(heartbeat);
      try { conn?.close(); } catch { /* best-effort */ }
      conn = undefined;
      connected = false;
    },
  };
}
