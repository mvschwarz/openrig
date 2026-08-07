// M1 A5 — the Slack CONNECTOR as a unix-socket SERVER. The hardened slice-11 relay evolves:
// the gateway (daemon-spawned) now OWNS the outbound decision (queue poll + entity-admission)
// and DIALS this connector; the connector owns platform delivery (Slack) and acks AFTER it.
//
// Ack-after-delivery (proof-1): a decision is delivered on the SHIPPED postWebhook path, and an
// ok:true ack is sent ONLY after a 2xx — the decisionId is recorded delivered BEFORE the ack, so
// a gateway replay of an already-delivered decision is de-duplicated and RE-ACKED without a
// double-post. A failed delivery sends ok:false{class} and is NOT recorded → the gateway retains
// it in its dispatch buffer and replays (no loss). This is the connector-side mirror of the
// gateway dispatch buffer — the two stores are DISTINCT and never merged.
//
// The wire codec is the ONE canonical daemon definition (lane rule: import via the narrow
// @openrig/daemon/gateway-protocol subpath; runtime codec is lazy-imported per house precedent).

import { createServer, type Server, type Socket } from "node:net";
import type { SeenStore } from "./state-store.js";
import type {
  CapabilityDescriptor,
  OutboundDecision,
  GatewayMessage,
  Ack,
} from "@openrig/daemon/gateway-protocol";

/** The platform delivery outcome for one decision. */
export type DeliveryOutcome = { ok: true } | { ok: false; class: string; detail?: string };
export type DeliverFn = (decision: OutboundDecision) => Promise<DeliveryOutcome>;

export interface ConnectorServerDeps {
  socketPath: string;
  /** Advertised in the CapabilityDescriptor — the gateway refuses any op not listed here (proof-9). */
  connectorId: string;
  platform: string;
  ops: string[];
  deliver: DeliverFn;
  /** decisionId dedup (SeenStore keyed by decisionId) — idempotent redelivery. */
  delivered: SeenStore;
  log?: (msg: string) => void;
}

export interface ConnectorServer {
  server: Server;
  close(): Promise<void>;
}

type Codec = {
  decodeGatewayMessage: (raw: string) => { ok: true; message: GatewayMessage } | { ok: false; error: string };
  encodeGatewayMessage: (msg: GatewayMessage) => string;
};

/** Start the connector socket server. Each dialing gateway is greeted with the CapabilityDescriptor,
 *  then its OutboundDecision frames are delivered + acked (ack-after-delivery). Returns a handle. */
export async function startConnectorServer(deps: ConnectorServerDeps): Promise<ConnectorServer> {
  const log = deps.log ?? (() => {});
  const { decodeGatewayMessage, encodeGatewayMessage } = (await import(
    "@openrig/daemon/gateway-protocol"
  )) as Codec;

  const descriptor: CapabilityDescriptor = {
    kind: "capability",
    connectorId: deps.connectorId,
    platform: deps.platform,
    protocolVersion: 1,
    ops: deps.ops,
  };

  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding("utf8");
    sock.on("error", () => { /* client teardown races — the gateway re-dials */ });
    sock.on("close", () => sockets.delete(sock));
    sock.write(encodeGatewayMessage(descriptor)); // greet: advertise capabilities

    let acc = "";
    sock.on("data", (chunk: string) => {
      acc += chunk;
      let nl: number;
      while ((nl = acc.indexOf("\n")) >= 0) {
        const frame = acc.slice(0, nl);
        acc = acc.slice(nl + 1);
        if (frame.length === 0) continue;
        const decoded = decodeGatewayMessage(frame);
        if (!decoded.ok) { log(`connector: refused frame: ${decoded.error}`); continue; } // LOUD, no partials
        const msg = decoded.message;
        if (msg.kind === "outbound_decision") {
          void handleDecision(msg, sock, deps, encodeGatewayMessage, log);
        }
        // capability/ack are gateway-inbound only; the connector ignores them.
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(deps.socketPath, () => resolve());
  });
  log(`connector ${deps.connectorId} listening on ${deps.socketPath}`);

  return {
    server,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch { /* best-effort */ } }
      server.close(() => resolve());
    }),
  };
}

async function handleDecision(
  decision: OutboundDecision,
  sock: Socket,
  deps: ConnectorServerDeps,
  encode: Codec["encodeGatewayMessage"],
  log: (m: string) => void,
): Promise<void> {
  const ackOk: Ack = { kind: "ack", decisionId: decision.decisionId, ok: true };

  // Idempotent redelivery: an already-delivered decisionId is RE-ACKED without re-posting.
  if (deps.delivered.load().has(decision.decisionId)) {
    log(`connector: decision ${decision.decisionId} already delivered — re-ack, no re-post`);
    safeWrite(sock, encode(ackOk));
    return;
  }

  let outcome: DeliveryOutcome;
  try {
    outcome = await deps.deliver(decision);
  } catch (e) {
    outcome = { ok: false, class: "delivery-threw", detail: (e as Error).message };
  }

  if (outcome.ok) {
    // Record delivered BEFORE the ack: a crash after this point re-acks via dedup (no double-post);
    // a crash before it replays + re-delivers (at-least-once, byte-identical dup) — never a drop.
    deps.delivered.mark(decision.decisionId, "delivered");
    safeWrite(sock, encode(ackOk));
    log(`connector: delivered + acked ${decision.decisionId}`);
  } else {
    const ackFail: Ack = { kind: "ack", decisionId: decision.decisionId, ok: false, failed: { class: outcome.class, detail: outcome.detail } };
    safeWrite(sock, encode(ackFail)); // NOT recorded → gateway retains + replays
    log(`connector: delivery FAILED ${decision.decisionId} (${outcome.class}) — ack ok:false, gateway will replay`);
  }
}

function safeWrite(sock: Socket, data: string): void {
  try { sock.write(data); } catch { /* the gateway re-dials + replays on a dropped socket */ }
}
