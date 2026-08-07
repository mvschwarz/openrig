// M1 A4a — the gateway<->connector WIRE: a CLOSED, minimal framed-JSON union over a local
// UNIX-domain socket (arch a8343a38 / contract a305310d). NOT a new interop protocol — an
// internal IPC seam. The gateway OUT-dials the socket the connector listens on; the wire
// carries OUTBOUND decisions + acks + the capability descriptor ONLY (inbound stays on the
// connector's existing platform socket for M1).
//
// Rails: unknown message kind = LOUD refuse; protocolVersion is ADDITIVE-ONLY; an
// OutboundDecision.op MUST be advertised in the connector's CapabilityDescriptor (an
// unadvertised op is REFUSED, never attempted — proof-9); decisionId is the end-to-end
// idempotency key (a gateway retry produces a BYTE-IDENTICAL dup at the connector).

export const GATEWAY_PROTOCOL_VERSION = 1;

export const GATEWAY_MESSAGE_KINDS = ["capability", "outbound_decision", "ack"] as const;
export type GatewayMessageKind = (typeof GATEWAY_MESSAGE_KINDS)[number];

/** connector -> gateway at connect: what this connector can do. `ops` is a CLOSED set;
 *  the gateway dispatches only advertised ops. */
export interface CapabilityDescriptor {
  kind: "capability";
  connectorId: string;
  platform: string;
  protocolVersion: number;
  ops: string[];
  limits?: Record<string, unknown>;
}

/** gateway -> connector: one outbound decision. `op` MUST be advertised; `decisionId` is
 *  the idempotency key. */
export interface OutboundDecision {
  kind: "outbound_decision";
  decisionId: string;
  op: string;
  entityBindingRef: string;
  payload: unknown;
}

/** connector -> gateway: the terminal ack for a decisionId (drives the dispatch buffer's
 *  ack-gated drain). */
export type Ack =
  | { kind: "ack"; decisionId: string; ok: true }
  | { kind: "ack"; decisionId: string; ok: false; failed: { class: string; detail?: string } };

export type GatewayMessage = CapabilityDescriptor | OutboundDecision | Ack;

export type DecodeResult =
  | { ok: true; message: GatewayMessage }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Decode + validate ONE framed JSON message. Unknown kind = LOUD refuse (proof-9);
 *  each kind's required fields are structurally validated (closed union, no partials). */
export function decodeGatewayMessage(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `gateway frame is not valid JSON: ${(err as Error).message}` };
  }
  if (!isObj(parsed)) return { ok: false, error: "gateway frame must be a JSON object" };
  const kind = parsed.kind;
  if (typeof kind !== "string" || !(GATEWAY_MESSAGE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `unknown gateway message kind "${String(kind)}" — refused (allowed: ${GATEWAY_MESSAGE_KINDS.join(", ")})` };
  }

  if (kind === "capability") {
    if (!nonEmptyStr(parsed.connectorId)) return { ok: false, error: "capability.connectorId must be a non-empty string" };
    if (!nonEmptyStr(parsed.platform)) return { ok: false, error: "capability.platform must be a non-empty string" };
    if (typeof parsed.protocolVersion !== "number") return { ok: false, error: "capability.protocolVersion must be a number" };
    if (!Array.isArray(parsed.ops) || !parsed.ops.every((o) => nonEmptyStr(o))) return { ok: false, error: "capability.ops must be a non-empty-string array" };
    const d: CapabilityDescriptor = { kind, connectorId: parsed.connectorId, platform: parsed.platform, protocolVersion: parsed.protocolVersion, ops: parsed.ops as string[] };
    if (parsed.limits !== undefined) { if (!isObj(parsed.limits)) return { ok: false, error: "capability.limits must be an object when present" }; d.limits = parsed.limits; }
    return { ok: true, message: d };
  }
  if (kind === "outbound_decision") {
    if (!nonEmptyStr(parsed.decisionId)) return { ok: false, error: "outbound_decision.decisionId must be a non-empty string" };
    if (!nonEmptyStr(parsed.op)) return { ok: false, error: "outbound_decision.op must be a non-empty string" };
    if (!nonEmptyStr(parsed.entityBindingRef)) return { ok: false, error: "outbound_decision.entityBindingRef must be a non-empty string" };
    return { ok: true, message: { kind, decisionId: parsed.decisionId, op: parsed.op, entityBindingRef: parsed.entityBindingRef, payload: parsed.payload } };
  }
  // ack
  if (!nonEmptyStr(parsed.decisionId)) return { ok: false, error: "ack.decisionId must be a non-empty string" };
  if (parsed.ok === true) return { ok: true, message: { kind: "ack", decisionId: parsed.decisionId, ok: true } };
  if (parsed.ok === false) {
    const failed = parsed.failed;
    if (!isObj(failed) || !nonEmptyStr(failed.class)) return { ok: false, error: "ack.failed must be { class, detail? } when ok is false" };
    return { ok: true, message: { kind: "ack", decisionId: parsed.decisionId, ok: false, failed: { class: failed.class, detail: typeof failed.detail === "string" ? failed.detail : undefined } } };
  }
  return { ok: false, error: "ack.ok must be a boolean" };
}

/** Encode a message to a framed JSON line (newline-delimited). */
export function encodeGatewayMessage(msg: GatewayMessage): string {
  return JSON.stringify(msg) + "\n";
}

/** proof-9 guard: an OutboundDecision op MUST be advertised by the connector's descriptor;
 *  an unadvertised op is REFUSED, never attempted. */
export function isAdvertisedOp(descriptor: CapabilityDescriptor, op: string): boolean {
  return descriptor.ops.includes(op);
}
