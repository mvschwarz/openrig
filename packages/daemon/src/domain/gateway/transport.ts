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
        dispatcher.onAck(msg.decisionId);
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
