// ── RETIRED IN PLACE (S10, OPR.0.5.5.10) ────────────────────────────────────────────────
// The process-split gateway shape retired under the amended M1 §3 (desk head-amendment,
// founder R2): the gateway runs as an IN-DAEMON SUBSYSTEM (gateway-subsystem.ts) — no spawned
// gateway process, no gateway↔connector socket wire. This module keeps compiling and its
// tests keep passing as a historical component, but it MUST NOT gain a production caller:
// the second-deployable ABSENCE proof pins that (any spawned gateway process or open
// connector wire is the red). Kept in place rather than deleted per the spec-level ruling
// (delete-or-mark is builder discretion).
// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 A4a — the gateway-side UNIX-SOCKET transport: the gateway OUT-dials the local socket
// the connector listens on, exchanges newline-framed JSON (protocol.ts codec), and wires
// the stream to a GatewayDispatcher (contract a305310d). No inbound network listener — a
// unix-domain socket is local filesystem-perm IPC, not network attack surface.
//
// Framing: newline-delimited JSON frames (encodeGatewayMessage appends "\n"). Incoming
// bytes are buffered and split on "\n"; each complete frame is decoded (unknown kind /
// partial = LOUD refuse, surfaced via onProtocolError, never silently dropped).
//
// NOTE (sun_path ~104-byte cap): the caller MUST pass a socketPath in a SHORT runtime dir,
// never a deep scratchpad path.

import { createConnection, type Socket } from "node:net";
import type { DispatchBuffer } from "./dispatch-buffer.js";
import { GatewayDispatcher } from "./dispatcher.js";
import { decodeGatewayMessage, encodeGatewayMessage } from "./protocol.js";

export interface GatewayConnection {
  dispatcher: GatewayDispatcher;
  close(): void;
}

export interface ConnectOpts {
  socketPath: string;
  buffer: DispatchBuffer;
  /** LOUD surface for a refused/malformed frame (never a silent drop). */
  onProtocolError?: (error: string) => void;
  /** Socket-level error (connector down / dropped). A handler is ALWAYS attached so an
   *  ECONNREFUSED/EPIPE never crashes the daemon — the durable buffer already guarantees
   *  no-loss and the spawn wrapper drives reconnect; this is only the observability surface. */
  onError?: (error: Error) => void;
  /** The socket closed (connector went away). The spawn wrapper uses this to re-dial. */
  onClose?: () => void;
  newDecisionId?: () => string;
}

/** Out-dial the connector socket + wire it to a GatewayDispatcher. On the CapabilityDescriptor
 *  handshake the dispatcher becomes ready and replays any un-Acked decisions (reconnect no-loss);
 *  Ack frames drain the buffer. Returns the dispatcher so the daemon can dispatch decisions. */
export function connectGateway(opts: ConnectOpts): GatewayConnection {
  const socket: Socket = createConnection(opts.socketPath);
  const dispatcher = new GatewayDispatcher({
    buffer: opts.buffer,
    send: (decision) => socket.write(encodeGatewayMessage(decision)),
    newDecisionId: opts.newDecisionId,
  });

  let acc = "";
  socket.setEncoding("utf8");
  // Always-attached error handler: a down/dropped connector must not throw uncaught.
  socket.on("error", (err: Error) => opts.onError?.(err));
  socket.on("close", () => opts.onClose?.());
  socket.on("data", (chunk: string) => {
    acc += chunk;
    let nl: number;
    while ((nl = acc.indexOf("\n")) >= 0) {
      const frame = acc.slice(0, nl);
      acc = acc.slice(nl + 1);
      if (frame.length === 0) continue;
      const decoded = decodeGatewayMessage(frame);
      if (!decoded.ok) { opts.onProtocolError?.(decoded.error); continue; }
      const msg = decoded.message;
      if (msg.kind === "capability") {
        dispatcher.onCapability(msg);
        dispatcher.replayPending(); // reconnect no-loss: re-send un-Acked decisions
      } else if (msg.kind === "ack") {
        if (msg.ok) {
          dispatcher.onAck(msg.decisionId); // delivered -> drain the durable row
        } else {
          // ok:false = the connector RECEIVED the decision but delivery FAILED and it did NOT
          // record it (its contract: the gateway retains + replays). We must NOT drain here — a
          // drain would silently DROP the notification (invariant-2 no-loss). Leave the row pending
          // so replayPending re-sends it on the next (re)connect; the connector's decisionId dedup
          // makes the eventual re-delivery a no-double-post. Surface the failure for observability.
          opts.onError?.(new Error(
            `connector reported delivery failure for decision ${msg.decisionId} (${msg.failed.class}${msg.failed.detail ? ": " + msg.failed.detail : ""}) — retained for replay`,
          ));
        }
      }
      // outbound_decision is gateway->connector only; receiving one is a protocol error
      else if (msg.kind === "outbound_decision") {
        opts.onProtocolError?.(`unexpected outbound_decision frame from the connector (decisionId ${msg.decisionId})`);
      }
    }
  });

  return {
    dispatcher,
    close: () => { try { socket.end(); socket.destroy(); } catch { /* best-effort */ } },
  };
}
