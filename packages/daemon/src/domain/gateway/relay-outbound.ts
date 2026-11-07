import { createHash } from "node:crypto";
import path from "node:path";
import { DispatchBuffer } from "./dispatch-buffer.js";
import type { SubsystemDeliverFn, SubsystemDeliveryOutcome } from "./gateway-subsystem.js";
import { HANDLE_PATTERN, type HumanFragment, type LoadResult } from "./human-registry.js";
import type { OutboundDecision } from "./protocol.js";
import { validateRelayUrl } from "./relay-config.js";
import { redactSecrets } from "./slack/message.js";
import { OUTBOUND_OP, type OutboundPostPayload } from "./slack/outbound-driver.js";
import type { FetchImpl } from "./slack/slack-api.js";
import { SeenStore } from "./slack/state-store.js";
import type { QueueRepository } from "../queue-repository.js";

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_ATTEMPTED_DECISIONS_FILE = "relay-attempted-decisions.jsonl";
export const RELAY_DELIVERED_DECISIONS_FILE = "relay-delivered-decisions.jsonl";

export const RELAY_SUMMARY_MAX_CHARS = 1000;
export const RELAY_DEFAULT_TIMEOUT_MS = 15_000;

export type RelayQuestionMode = "ask" | "park";
export type RelayIntent = "decision" | "update";
export type RelayDeliveryOutcome = "interrupt" | "notify" | "digest";

export interface RelayReplyRefPayload {
  v: 1;
  qitemId: string;
  episodeKey: string;
  decisionRevision: string;
  decisionId: string;
  connectorRef: string;
  mode: RelayQuestionMode;
  digest?: boolean;
}

export interface RelayReplyRefToken {
  v: 1;
  payloadHash: string;
  connectorHash: string;
  mode: RelayQuestionMode;
  digest?: boolean;
}

export interface RelayDigestItem {
  qitemId: string;
  notificationKey: string;
  summary: string;
  body?: string;
  replyRef: string | null;
}

export interface RelayOutboundEnvelope {
  v: 1;
  deliveryId: string;
  recipient: {
    handle: string;
  };
  intent: RelayIntent;
  outcome: RelayDeliveryOutcome;
  summary: string;
  body: string;
  replyRef: string | null;
  items?: RelayDigestItem[];
}

export interface RelayPayloadCarry extends OutboundPostPayload {
  relayConnectorRef?: string;
  relayEnvelope?: RelayOutboundEnvelope;
  relayRevision?: string | null;
  relayReplyRefs?: Record<string, RelayReplyRefPayload>;
  deliveryDigestPost?: boolean;
  digestId?: string;
  memberReceipts?: Array<{
    qitemId: string;
    notificationKey: string;
    level: string;
    kind: string;
    summary?: string;
    body?: string;
  }>;
  quietRelease?: boolean;
  deliveryDeferralFire?: boolean;
}

function asRelayPayloadCarry(v: unknown): RelayPayloadCarry | null {
  if (!isObj(v)) return null;
  return v as unknown as RelayPayloadCarry;
}

const ALLOWED_REPLY_REF_TOKEN_KEYS = new Set([
  "v",
  "payloadHash",
  "connectorHash",
  "mode",
  "digest",
]);

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const ALLOWED_ENVELOPE_KEYS = new Set([
  "v",
  "deliveryId",
  "recipient",
  "intent",
  "outcome",
  "summary",
  "body",
  "replyRef",
  "items",
]);

const ALLOWED_RECIPIENT_KEYS = new Set(["handle"]);
const ALLOWED_DIGEST_ITEM_KEYS = new Set(["qitemId", "notificationKey", "summary", "body", "replyRef"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function unknownKey(obj: Record<string, unknown>, allowed: Set<string>): string | undefined {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return k;
  }
  return undefined;
}

function canonicalizeRelayReplyRefPayload(payload: RelayReplyRefPayload): RelayReplyRefPayload {
  return {
    v: RELAY_PROTOCOL_VERSION,
    qitemId: payload.qitemId,
    episodeKey: payload.episodeKey,
    decisionRevision: payload.decisionRevision,
    decisionId: payload.decisionId,
    connectorRef: payload.connectorRef,
    mode: payload.mode,
    ...(payload.digest === true ? { digest: true } : {}),
  };
}

/** Deterministic SHA-256 hex digest of the canonical frozen RelayReplyRefPayload. */
export function hashRelayReplyRefPayload(payload: RelayReplyRefPayload): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeRelayReplyRefPayload(payload)), "utf8")
    .digest("hex");
}

/** Deterministic SHA-256 hex digest of a relay connectorRef for bounded token binding. */
export function hashRelayConnectorRef(connectorRef: string): string {
  return createHash("sha256").update(connectorRef, "utf8").digest("hex");
}

/** Encode structured correlation fields into a fixed-size opaque base64url replyRef token. */
export function encodeRelayReplyRef(payload: RelayReplyRefPayload): string {
  const canonical = canonicalizeRelayReplyRefPayload(payload);
  const token: RelayReplyRefToken = {
    v: RELAY_PROTOCOL_VERSION,
    payloadHash: hashRelayReplyRefPayload(canonical),
    connectorHash: hashRelayConnectorRef(canonical.connectorRef),
    mode: canonical.mode,
    ...(canonical.digest === true ? { digest: true } : {}),
  };
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

/** Decode and strictly validate a fixed-size opaque base64url replyRef token. */
export function decodeRelayReplyRef(
  raw: unknown,
): { ok: true; ref: RelayReplyRefToken } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return { ok: false, error: "replyRef must be a non-empty base64url string" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "replyRef is not valid base64url JSON" };
  }
  if (!isObj(parsed)) return { ok: false, error: "replyRef payload must be a JSON object" };
  const uk = unknownKey(parsed, ALLOWED_REPLY_REF_TOKEN_KEYS);
  if (uk) return { ok: false, error: `replyRef has unknown key "${uk}"` };
  if (parsed.v !== RELAY_PROTOCOL_VERSION) return { ok: false, error: `replyRef.v must be ${RELAY_PROTOCOL_VERSION}` };
  if (typeof parsed.payloadHash !== "string" || !SHA256_HEX_PATTERN.test(parsed.payloadHash)) {
    return { ok: false, error: "replyRef.payloadHash must be a 64-char lowercase hex sha256" };
  }
  if (typeof parsed.connectorHash !== "string" || !SHA256_HEX_PATTERN.test(parsed.connectorHash)) {
    return { ok: false, error: "replyRef.connectorHash must be a 64-char lowercase hex sha256" };
  }
  if (parsed.mode !== "ask" && parsed.mode !== "park") {
    return { ok: false, error: "replyRef.mode must be ask|park" };
  }
  if (parsed.digest !== undefined && typeof parsed.digest !== "boolean") {
    return { ok: false, error: "replyRef.digest must be a boolean when present" };
  }
  return {
    ok: true,
    ref: {
      v: RELAY_PROTOCOL_VERSION,
      payloadHash: parsed.payloadHash,
      connectorHash: parsed.connectorHash,
      mode: parsed.mode,
      ...(parsed.digest === true ? { digest: true } : {}),
    },
  };
}

/** Deterministic SHA-256 hex digest of an offered replyRef for transition-note evidence. */
export function hashRelayReplyRef(replyRef: string): string {
  return createHash("sha256").update(replyRef, "utf8").digest("hex");
}

/** Validate a closed protocol v1 RelayOutboundEnvelope. */
export function validateRelayOutboundEnvelope(
  raw: unknown,
): { ok: true; envelope: RelayOutboundEnvelope } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "relay envelope must be an object" };
  const uk = unknownKey(raw, ALLOWED_ENVELOPE_KEYS);
  if (uk) return { ok: false, error: `relay envelope has unknown key "${uk}"` };
  if (raw.v !== RELAY_PROTOCOL_VERSION) return { ok: false, error: `relay envelope.v must be ${RELAY_PROTOCOL_VERSION}` };
  if (!nonEmptyStr(raw.deliveryId)) return { ok: false, error: "relay envelope.deliveryId must be a non-empty string" };
  if (!isObj(raw.recipient)) return { ok: false, error: "relay envelope.recipient must be an object" };
  const ruk = unknownKey(raw.recipient, ALLOWED_RECIPIENT_KEYS);
  if (ruk) return { ok: false, error: `relay envelope.recipient has unknown key "${ruk}"` };
  if (!nonEmptyStr(raw.recipient.handle) || !HANDLE_PATTERN.test(raw.recipient.handle)) {
    return { ok: false, error: "relay envelope.recipient.handle must match HANDLE_PATTERN" };
  }
  if (raw.intent !== "decision" && raw.intent !== "update") {
    return { ok: false, error: "relay envelope.intent must be decision|update" };
  }
  if (raw.outcome !== "interrupt" && raw.outcome !== "notify" && raw.outcome !== "digest") {
    return { ok: false, error: "relay envelope.outcome must be interrupt|notify|digest" };
  }
  if (typeof raw.summary !== "string") return { ok: false, error: "relay envelope.summary must be a string" };
  if (typeof raw.body !== "string") return { ok: false, error: "relay envelope.body must be a string" };
  if (raw.replyRef !== null && typeof raw.replyRef !== "string") {
    return { ok: false, error: "relay envelope.replyRef must be string or null" };
  }
  if (raw.intent === "update" && raw.replyRef !== null) {
    return { ok: false, error: "relay envelope.replyRef must be null when intent is update" };
  }
  if (raw.replyRef !== null) {
    const decoded = decodeRelayReplyRef(raw.replyRef);
    if (!decoded.ok) return { ok: false, error: `relay envelope.replyRef invalid: ${decoded.error}` };
  }
  let items: RelayDigestItem[] | undefined;
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) return { ok: false, error: "relay envelope.items must be an array when present" };
    items = [];
    for (const [i, item] of raw.items.entries()) {
      if (!isObj(item)) return { ok: false, error: `relay envelope.items[${i}] must be an object` };
      const iuk = unknownKey(item, ALLOWED_DIGEST_ITEM_KEYS);
      if (iuk) return { ok: false, error: `relay envelope.items[${i}] has unknown key "${iuk}"` };
      if (!nonEmptyStr(item.qitemId) || !nonEmptyStr(item.notificationKey) || typeof item.summary !== "string") {
        return { ok: false, error: `relay envelope.items[${i}] missing required fields` };
      }
      if (item.body !== undefined && typeof item.body !== "string") {
        return { ok: false, error: `relay envelope.items[${i}].body must be a string when present` };
      }
      if (item.replyRef !== null && typeof item.replyRef !== "string") {
        return { ok: false, error: `relay envelope.items[${i}].replyRef must be string or null` };
      }
      if (typeof item.replyRef === "string") {
        const dec = decodeRelayReplyRef(item.replyRef);
        if (!dec.ok) return { ok: false, error: `relay envelope.items[${i}].replyRef invalid: ${dec.error}` };
      }
      items.push({
        qitemId: item.qitemId,
        notificationKey: item.notificationKey,
        summary: item.summary,
        ...(typeof item.body === "string" ? { body: item.body } : {}),
        replyRef: item.replyRef,
      });
    }
  }
  return {
    ok: true,
    envelope: {
      v: RELAY_PROTOCOL_VERSION,
      deliveryId: raw.deliveryId,
      recipient: { handle: raw.recipient.handle },
      intent: raw.intent,
      outcome: raw.outcome,
      summary: raw.summary,
      body: raw.body,
      replyRef: raw.replyRef,
      ...(items !== undefined ? { items } : {}),
    },
  };
}

/** Snap a UTF-16 index so it never splits a surrogate pair (`0xD800..0xDBFF` followed by `0xDC00..0xDFFF`). */
function snapCodePointIndex(str: string, idx: number): number {
  if (idx <= 0) return 0;
  if (idx >= str.length) return str.length;
  const prev = str.charCodeAt(idx - 1);
  const curr = str.charCodeAt(idx);
  if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
    return idx - 1;
  }
  return idx;
}

export interface RelayQuestionState {
  qitemId: string;
  mode: RelayQuestionMode;
  episodeKey: string;
  decisionRevision: string;
  humanIntent?: "decision" | "update" | null;
  summary?: string | null;
  body?: string | null;
}

export interface PrepareRelayDecisionOpts {
  loadHumanRegistry: () => LoadResult | { ok: boolean; entities?: readonly HumanFragment[] };
  queueRepo?: Pick<QueueRepository, "getById" | "decisionRevision" | "currentHumanRequiredEpisode">;
  lookupQuestionState?: (qitemId: string, fallbackKey?: string | null) => RelayQuestionState | null;
  resolveOutcome?: (payload: OutboundPostPayload) => RelayDeliveryOutcome;
}

/** Look up actual current question state from QueueRepository. Never mints synthetic state when row or current episode is missing. */
function defaultLookupQuestionState(
  queueRepo: Pick<QueueRepository, "getById" | "decisionRevision" | "currentHumanRequiredEpisode"> | undefined,
  qitemId: string,
  expectedEpisodeKey?: string | null,
): RelayQuestionState | null {
  if (!queueRepo) return null;
  const row = queueRepo.getById(qitemId);
  if (!row || (row.state !== "pending" && row.state !== "blocked")) return null;
  const ep = queueRepo.currentHumanRequiredEpisode(qitemId);
  if (!ep) return null;
  if (expectedEpisodeKey && expectedEpisodeKey !== ep.key) return null;
  const decisionRevision = queueRepo.decisionRevision(row);
  const mode: RelayQuestionMode = row.state === "blocked" ? "park" : "ask";
  return {
    qitemId,
    mode,
    episodeKey: ep.key,
    decisionRevision,
    humanIntent: row.humanIntent ?? null,
    summary: row.summary ?? null,
  };
}

function renderPlainTextBody(p: OutboundPostPayload): string {
  const sections: string[] = [];
  const cleanedSummary = redactSecrets(String(p.summary ?? "")).replace(/\s+/g, " ").trim();
  const mainBody = redactSecrets(String(p.body ?? "")).trim();
  if (cleanedSummary.length > RELAY_SUMMARY_MAX_CHARS && !mainBody.includes(cleanedSummary)) {
    sections.push(cleanedSummary);
  }
  if (mainBody) sections.push(mainBody);
  const detail = redactSecrets(String(p.humanDetail ?? "")).trim();
  if (detail) sections.push(detail);
  if (Array.isArray(p.humanQuestions) && p.humanQuestions.length > 0) {
    const qLines: string[] = [];
    for (const q of p.humanQuestions) {
      const header = redactSecrets(String((q as { header?: string }).header ?? "")).trim();
      if (header) qLines.push(`[${header}]`);
      qLines.push(redactSecrets(String(q.question ?? "")).trim());
      for (const opt of q.options ?? []) {
        const desc = redactSecrets(String((opt as { description?: string }).description ?? "")).trim();
        const descSuffix = desc ? ` — ${desc}` : "";
        qLines.push(`- ${redactSecrets(String(opt.label ?? "")).trim()}${opt.recommended ? " (recommended)" : ""}${descSuffix}`);
      }
    }
    if (qLines.length > 0) sections.push(qLines.join("\n"));
  }
  return sections.join("\n\n");
}

function renderPlainTextSummary(summary: string | null | undefined, fallback: string): string {
  const cleaned = redactSecrets(String(summary ?? fallback)).replace(/\s+/g, " ").trim() || fallback;
  return cleaned.length > RELAY_SUMMARY_MAX_CHARS
    ? cleaned.slice(0, snapCodePointIndex(cleaned, RELAY_SUMMARY_MAX_CHARS))
    : cleaned;
}

/** Resolve the recipient human's primary binding when it is a `relay` binding.
 *  Requires exact registered human address or exact bare entityId (no broad localpart/domain splitting). */
export function resolvePrimaryRelayBinding(
  destinationOrRef: string | null | undefined,
  reg: LoadResult | { ok: boolean; entities?: readonly HumanFragment[] },
): { entity: HumanFragment; connectorRef: string; handle: string; secretsRef: string } | null {
  if (!reg.ok || !reg.entities) return null;
  const raw = String(destinationOrRef ?? "").trim();
  if (!raw) return null;
  const human = reg.entities.find((e) => e.address === raw || e.entityId === raw);
  if (!human) return null;
  const primary = human.connectorBindings.find((b) => b.role === "primary");
  if (!primary || (primary.kind as string) !== "relay") return null;
  return {
    entity: human,
    connectorRef: primary.connectorRef,
    handle: primary.handle ?? human.entityId,
    secretsRef: primary.secretsRef,
  };
}

/** Synchronous pre-enqueue preparation hook: freezes the protocol v1 relay envelope and replyRef(s)
 *  onto the decision payload when the recipient's primary binding is `relay`. */
export function prepareRelayDecision(decision: OutboundDecision, opts: PrepareRelayDecisionOpts): OutboundDecision {
  if (decision.op !== OUTBOUND_OP) return decision;
  const p = asRelayPayloadCarry(decision.payload);
  if (!p) return decision;
  // Already frozen on an earlier pass: never recompute refs.
  if (p.relayEnvelope && p.relayConnectorRef) return decision;

  const reg = opts.loadHumanRegistry();
  const binding = resolvePrimaryRelayBinding(p.destinationSession ?? decision.entityBindingRef, reg);
  if (!binding) return decision;

  const outcome: RelayDeliveryOutcome = p.deliveryDigestPost
    ? "digest"
    : p.quietRelease
      ? "notify"
      : p.deliveryDeferralFire
        ? "interrupt"
        : opts.resolveOutcome?.(p) ?? "notify";

  const lookup = (qitemId: string, fallbackKey?: string | null): RelayQuestionState | null =>
    opts.lookupQuestionState
      ? opts.lookupQuestionState(qitemId, fallbackKey)
      : defaultLookupQuestionState(opts.queueRepo, qitemId, fallbackKey);

  const memberReceipts = Array.isArray(p.memberReceipts) ? p.memberReceipts : undefined;
  let intent: RelayIntent;
  let replyRef: string | null = null;
  let items: RelayDigestItem[] | undefined;
  let relayRevision: string | null = null;
  const relayReplyRefs: Record<string, RelayReplyRefPayload> = {};

  if (memberReceipts && memberReceipts.length > 0) {
    items = memberReceipts.map((m) => {
      const qState = lookup(m.qitemId, m.notificationKey);
      const isDecisionMember = m.kind === "human-required" && qState !== null && qState.humanIntent !== "update";
      let memberRef: string | null = null;
      if (isDecisionMember) {
        const memberPayload: RelayReplyRefPayload = {
          v: RELAY_PROTOCOL_VERSION,
          qitemId: m.qitemId,
          episodeKey: qState.episodeKey,
          decisionRevision: qState.decisionRevision,
          decisionId: decision.decisionId,
          connectorRef: binding.connectorRef,
          mode: qState.mode,
          digest: true,
        };
        memberRef = encodeRelayReplyRef(memberPayload);
        relayReplyRefs[memberRef] = memberPayload;
      }
      const rawItemSummary = qState?.summary ?? m.summary;
      const rawItemBody = qState?.body ?? m.body;
      const cleanedItemSummary =
        typeof rawItemSummary === "string" ? redactSecrets(rawItemSummary).replace(/\s+/g, " ").trim() : "";
      let cleanedItemBody = typeof rawItemBody === "string" ? redactSecrets(rawItemBody).trim() : "";
      if (cleanedItemSummary.length > RELAY_SUMMARY_MAX_CHARS && !cleanedItemBody.includes(cleanedItemSummary)) {
        cleanedItemBody = cleanedItemBody ? `${cleanedItemSummary}\n\n${cleanedItemBody}` : cleanedItemSummary;
      }
      return {
        qitemId: m.qitemId,
        notificationKey: m.notificationKey,
        summary: renderPlainTextSummary(rawItemSummary, m.qitemId),
        ...(cleanedItemBody ? { body: cleanedItemBody } : {}),
        replyRef: memberRef,
      };
    });
    const anyDecision = items.some((it) => it.replyRef !== null);
    intent = anyDecision ? "decision" : "update";
    // Multi-item digests must have top-level replyRef = null so one reply cannot resolve several questions.
    replyRef = items.length === 1 ? items[0]!.replyRef : null;
  } else {
    const isDecision =
      p.humanIntent !== "update" &&
      (p.ownerNotificationKind === "human-required" ||
        (p.humanIntent === "decision" && p.ownerNotificationKind !== "human-decision-resolved"));
    intent = isDecision ? "decision" : "update";
    if (isDecision && p.qitemId) {
      const qState = lookup(p.qitemId, p.notificationKey);
      if (qState) {
        relayRevision = qState.decisionRevision;
        const askPayload: RelayReplyRefPayload = {
          v: RELAY_PROTOCOL_VERSION,
          qitemId: p.qitemId,
          episodeKey: qState.episodeKey,
          decisionRevision: qState.decisionRevision,
          decisionId: decision.decisionId,
          connectorRef: binding.connectorRef,
          mode: qState.mode,
          ...(outcome === "digest" ? { digest: true } : {}),
        };
        replyRef = encodeRelayReplyRef(askPayload);
        relayReplyRefs[replyRef] = askPayload;
      }
    }
  }

  const envelope: RelayOutboundEnvelope = {
    v: RELAY_PROTOCOL_VERSION,
    deliveryId: decision.decisionId,
    recipient: { handle: binding.handle },
    intent,
    outcome,
    summary: renderPlainTextSummary(p.summary, p.qitemId || decision.decisionId),
    body: renderPlainTextBody(p),
    replyRef,
    ...(items ? { items } : {}),
  };

  return {
    ...decision,
    payload: {
      ...p,
      relayConnectorRef: binding.connectorRef,
      relayEnvelope: envelope,
      ...(relayRevision ? { relayRevision } : {}),
      ...(Object.keys(relayReplyRefs).length > 0 ? { relayReplyRefs } : {}),
    } satisfies RelayPayloadCarry,
  };
}

export interface PendingRelayReplyRefMatch {
  found: boolean;
  decisionId?: string;
  connectorRef?: string;
  qitemId?: string;
  episodeKey?: string;
  decisionRevision?: string;
  mode?: RelayQuestionMode;
  digest?: boolean;
}

/** Check the durable DispatchBuffer for an un-Acked decision that offered the exact `replyRef`. */
export function findPendingRelayReplyRef(home: string, replyRef: string): PendingRelayReplyRefMatch {
  const decoded = decodeRelayReplyRef(replyRef);
  if (!decoded.ok) return { found: false };
  const pending = new DispatchBuffer(home).pendingStrict();
  for (const decision of pending) {
    const p = asRelayPayloadCarry(decision.payload);
    if (!p) continue;
    const env = p.relayEnvelope;
    if (!env) continue;
    const matchedTop = env.replyRef === replyRef;
    const matchedItem = env.items?.some((it) => it.replyRef === replyRef) ?? false;
    if (!matchedTop && !matchedItem) continue;
    const frozen = p.relayReplyRefs?.[replyRef];
    if (
      !isObj(frozen) ||
      frozen.v !== RELAY_PROTOCOL_VERSION ||
      !nonEmptyStr(frozen.qitemId) ||
      !nonEmptyStr(frozen.episodeKey) ||
      !nonEmptyStr(frozen.decisionRevision) ||
      !nonEmptyStr(frozen.decisionId) ||
      !nonEmptyStr(frozen.connectorRef) ||
      (frozen.mode !== "ask" && frozen.mode !== "park") ||
      (frozen.digest !== undefined && typeof frozen.digest !== "boolean")
    ) {
      continue;
    }
    const candidate: RelayReplyRefPayload = {
      v: RELAY_PROTOCOL_VERSION,
      qitemId: frozen.qitemId,
      episodeKey: frozen.episodeKey,
      decisionRevision: frozen.decisionRevision,
      decisionId: frozen.decisionId,
      connectorRef: frozen.connectorRef,
      mode: frozen.mode,
      ...(frozen.digest === true ? { digest: true } : {}),
    };
    if (encodeRelayReplyRef(candidate) !== replyRef) continue;
    if (decision.decisionId !== candidate.decisionId) continue;
    if (p.relayConnectorRef && p.relayConnectorRef !== candidate.connectorRef) continue;
    return {
      found: true,
      decisionId: decision.decisionId,
      connectorRef: candidate.connectorRef,
      qitemId: candidate.qitemId,
      episodeKey: candidate.episodeKey,
      decisionRevision: candidate.decisionRevision,
      mode: candidate.mode,
      ...(candidate.digest ? { digest: true } : {}),
    };
  }
  return { found: false };
}

export interface PostRelayEnvelopeInput {
  url: string;
  outboundToken: string;
  envelope: RelayOutboundEnvelope;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  stopSignal?: AbortSignal;
}

export type RelayHttpResult =
  | { ok: true; status: number }
  | { ok: false; status: number; class: string; detail: string };

/** Loopback HTTP POST to the operator's relay bridge.
 *  - Validates loopback HTTP URL via `validateRelayUrl`.
 *  - Rejects redirects (`redirect: "error"`).
 *  - Does not buffer or log arbitrary bridge response bodies (status is sufficient for custody). */
export async function postRelayEnvelope(input: PostRelayEnvelopeInput): Promise<RelayHttpResult> {
  const urlCheck = validateRelayUrl(input.url);
  if (!urlCheck.ok) {
    return {
      ok: false,
      status: 0,
      class: "invalid-endpoint",
      detail: urlCheck.reason,
    };
  }
  const token = input.outboundToken.trim();
  if (!token) {
    return {
      ok: false,
      status: 0,
      class: "missing-credential",
      detail: "relay outbound token is empty",
    };
  }
  const valid = validateRelayOutboundEnvelope(input.envelope);
  if (!valid.ok) {
    return {
      ok: false,
      status: 0,
      class: "invalid-envelope",
      detail: valid.error,
    };
  }
  const bodyJson = JSON.stringify(valid.envelope);

  if (input.stopSignal?.aborted) {
    return {
      ok: false,
      status: 0,
      class: "stopped",
      detail: "relay transport stopped",
    };
  }

  const timeoutMs = input.timeoutMs ?? RELAY_DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const signal = input.stopSignal ? AbortSignal.any([ctrl.signal, input.stopSignal]) : ctrl.signal;

  try {
    const fetchFn = input.fetchImpl ?? fetch;
    const res = await fetchFn(urlCheck.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: bodyJson,
      redirect: "error",
      signal,
    });
    void res.body?.cancel?.().catch(() => {});
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        status: res.status,
        class: "redirect-refused",
        detail: `relay redirect (${res.status}) is refused`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        class: `http-${res.status}`,
        detail: `http ${res.status}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (error) {
    if (input.stopSignal?.aborted) {
      return {
        ok: false,
        status: 0,
        class: "stopped",
        detail: "relay transport stopped",
      };
    }
    const rawMsg = (error as Error)?.message || "";
    const isRedirect = /redirect/i.test(rawMsg);
    const isTimeout = ctrl.signal.aborted || /timeout|abort/i.test(rawMsg);
    return {
      ok: false,
      status: 0,
      class: isRedirect ? "redirect-refused" : isTimeout ? "timeout" : "transport",
      detail: isRedirect
        ? "relay redirect is refused"
        : isTimeout
          ? `relay request timed out after ${timeoutMs}ms`
          : "relay transport request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RelayAcceptedReceiptInfo {
  qitemId: string;
  notificationKey: string;
  connectorRef: string;
  deliveryId: string;
  replyRef: string | null;
  refHash: string | null;
  revision: string | null;
  episodeKey: string | null;
  level: string;
  kind: string;
  humanIntent?: "decision" | "update" | null;
  digestId?: string | null;
}

export type ResolvedRelayOutboundProfile =
  | { ok: true; connectorRef: string; url: string; outboundToken: string }
  | { ok: false; reason: string };

export interface RelayOutboundTransportOpts {
  attempted: SeenStore;
  delivered: SeenStore;
  outboundSeen: SeenStore;
  resolveProfile: (connectorRef: string) => ResolvedRelayOutboundProfile;
  onAccepted: (info: RelayAcceptedReceiptInfo) => void;
  hasAcceptedReceipt?: (info: { qitemId: string; notificationKey: string }) => boolean;
  onTransportFailed?: (payload: OutboundPostPayload, failureClass: string, detail: string) => void;
  release?: (notificationKey: string) => void;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  stopSignal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface RelayOutboundTransport {
  deliver: SubsystemDeliverFn;
  wasAttempted: (decision: OutboundDecision) => boolean;
}

function buildExpectedReceipts(decision: OutboundDecision, p: RelayPayloadCarry, connectorRef: string, envelope: RelayOutboundEnvelope): RelayAcceptedReceiptInfo[] {
  if (p.deliveryDigestPost && Array.isArray(p.memberReceipts) && p.memberReceipts.length > 0) {
    return p.memberReceipts.map((m) => {
      const itemEntry = envelope.items?.find((it) => it.qitemId === m.qitemId && it.notificationKey === m.notificationKey);
      const itemRef = itemEntry?.replyRef ?? (p.memberReceipts!.length === 1 ? envelope.replyRef : null);
      const frozenItemRef = itemRef ? p.relayReplyRefs?.[itemRef] : undefined;
      return {
        qitemId: m.qitemId,
        notificationKey: m.notificationKey,
        connectorRef,
        deliveryId: decision.decisionId,
        replyRef: itemRef,
        refHash: itemRef ? hashRelayReplyRef(itemRef) : null,
        revision: frozenItemRef?.decisionRevision ?? null,
        episodeKey: frozenItemRef?.episodeKey ?? m.notificationKey,
        level: m.level,
        kind: m.kind,
        humanIntent: m.kind === "human-required" ? "decision" : "update",
        digestId: p.digestId ?? "unknown",
      };
    });
  }
  if (p.qitemId) {
    const key = p.notificationKey ?? p.qitemId;
    const frozenRef = envelope.replyRef ? p.relayReplyRefs?.[envelope.replyRef] : undefined;
    return [
      {
        qitemId: p.qitemId,
        notificationKey: key,
        connectorRef,
        deliveryId: decision.decisionId,
        replyRef: envelope.replyRef,
        refHash: envelope.replyRef ? hashRelayReplyRef(envelope.replyRef) : null,
        revision: frozenRef?.decisionRevision ?? (p.relayRevision ?? null),
        episodeKey: frozenRef?.episodeKey ?? key,
        level: p.ownerNotificationLevel ?? "RECORD",
        kind: p.ownerNotificationKind ?? "unclassified",
        humanIntent: p.humanIntent ?? null,
      },
    ];
  }
  return [];
}

/** SeenStore-backed outbound relay transport.
 *  - Strict SeenStore reads (`statuses()`): unreadable state retains the decision in DispatchBuffer.
 *  - Persists attempt metadata BEFORE the first HTTP request (no secrets/answers in metadata).
 *  - Replays the exact frozen `relayEnvelope` with the same `deliveryId`.
 *  - Marks `outboundSeen` and releases poll guard BEFORE marking `delivered`; reconciles from durable receipt on retry without reposting. */
export function createRelayOutboundTransport(opts: RelayOutboundTransportOpts): RelayOutboundTransport {
  const log = opts.log ?? (() => {});

  const wasAttempted = (decision: OutboundDecision): boolean => {
    const map = opts.attempted.statuses();
    return map.has(decision.decisionId);
  };

  const completeLocalGuards = (
    decision: OutboundDecision,
    p: RelayPayloadCarry,
    outboundSeenMap: Map<string, string>,
    deliveredMap: Map<string, string>,
  ): SubsystemDeliveryOutcome => {
    try {
      if (p.qitemId && !p.deliveryDigestPost) {
        const key = p.notificationKey ?? p.qitemId;
        if (!outboundSeenMap.has(key)) {
          opts.outboundSeen.mark(key, "relay-accepted");
        }
        opts.release?.(key);
      }
      if (!deliveredMap.has(decision.decisionId)) {
        opts.delivered.mark(decision.decisionId, "delivered");
      }
      return { ok: true };
    } catch (error) {
      const detail = (error as Error).message || "relay state write failed";
      log(`relay local state mark FAILED for ${decision.decisionId}: ${detail} — retained for replay`);
      return { ok: false, class: "relay-state-write-failed", detail };
    }
  };

  const deliver: SubsystemDeliverFn = async (decision: OutboundDecision): Promise<SubsystemDeliveryOutcome> => {
    let deliveredMap: Map<string, string>;
    let attemptedMap: Map<string, string>;
    let outboundSeenMap: Map<string, string>;
    try {
      deliveredMap = opts.delivered.statuses();
      attemptedMap = opts.attempted.statuses();
      outboundSeenMap = opts.outboundSeen.statuses();
    } catch (error) {
      const detail = (error as Error).message || "relay SeenStore unreadable";
      log(`relay state unreadable for ${decision.decisionId}: ${detail} — retained`);
      return { ok: false, class: "relay-state-unreadable", detail };
    }

    const p = (decision.payload ?? {}) as RelayPayloadCarry;
    const connectorRef = p.relayConnectorRef;
    const envelope = p.relayEnvelope;
    if (!connectorRef || !envelope) {
      const detail = "relay decision is missing frozen relayEnvelope or relayConnectorRef";
      log(`relay delivery ${decision.decisionId} refused: ${detail}`);
      return { ok: false, class: "relay-envelope-missing", detail };
    }

    const expectedReceipts = buildExpectedReceipts(decision, p, connectorRef, envelope);
    const alreadyReceipted =
      expectedReceipts.length > 0 &&
      opts.hasAcceptedReceipt !== undefined &&
      expectedReceipts.every((r) => opts.hasAcceptedReceipt!({ qitemId: r.qitemId, notificationKey: r.notificationKey }));

    if (deliveredMap.has(decision.decisionId) || alreadyReceipted) {
      log(`relay delivery: decision ${decision.decisionId} already accepted — reconciling local guards without repost`);
      return completeLocalGuards(decision, p, outboundSeenMap, deliveredMap);
    }

    const profile = opts.resolveProfile(connectorRef);
    if (!profile.ok) {
      log(`relay profile "${connectorRef}" unready for ${decision.decisionId}: ${profile.reason} — retained`);
      try {
        opts.onTransportFailed?.(p, "relay-profile-unready", profile.reason);
      } catch (e) {
        log(`relay transport-failed receipt write FAILED for ${p.qitemId ?? decision.decisionId}: ${(e as Error).message}`);
      }
      return { ok: false, class: "relay-profile-unready", detail: profile.reason };
    }

    if (opts.stopSignal?.aborted) {
      return { ok: false, class: "stopped", detail: "relay transport stopped" };
    }

    if (!attemptedMap.has(decision.decisionId)) {
      try {
        opts.attempted.mark(decision.decisionId, `attempted:${connectorRef}:${envelope.outcome}`);
      } catch (error) {
        const detail = (error as Error).message || "failed to record relay attempt";
        log(`relay attempt record FAILED for ${decision.decisionId}: ${detail} — retained`);
        return { ok: false, class: "relay-attempt-unrecorded", detail };
      }
    }

    const res = await postRelayEnvelope({
      url: profile.url,
      outboundToken: profile.outboundToken,
      envelope,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
      stopSignal: opts.stopSignal,
    });

    if (!res.ok) {
      if (res.class !== "stopped") {
        try {
          opts.onTransportFailed?.(p, res.class, res.detail);
        } catch (e) {
          log(`relay transport-failed receipt write FAILED for ${p.qitemId ?? decision.decisionId}: ${(e as Error).message}`);
          return { ok: false, class: "receipt-failed", detail: (e as Error).message };
        }
      }
      return { ok: false, class: res.class, detail: res.detail };
    }

    try {
      for (const receipt of expectedReceipts) {
        if (opts.hasAcceptedReceipt?.({ qitemId: receipt.qitemId, notificationKey: receipt.notificationKey })) {
          continue;
        }
        opts.onAccepted(receipt);
      }
    } catch (error) {
      const detail = (error as Error).message || "relay acceptance receipt write failed";
      log(`relay acceptance receipt write FAILED for ${p.qitemId ?? decision.decisionId}: ${detail} — retained for replay`);
      return { ok: false, class: "receipt-failed", detail };
    }

    const finalized = completeLocalGuards(decision, p, outboundSeenMap, deliveredMap);
    if (!finalized.ok) return finalized;

    log(`relay delivered ${decision.decisionId}${p.qitemId ? ` (qitem ${p.qitemId})` : ""} via ${connectorRef}`);
    return { ok: true };
  };

  return {
    deliver,
    wasAttempted,
  };
}

export function relayStatePaths(home: string): { attemptedPath: string; deliveredPath: string } {
  const dir = path.join(home, "state");
  return {
    attemptedPath: path.join(dir, RELAY_ATTEMPTED_DECISIONS_FILE),
    deliveredPath: path.join(dir, RELAY_DELIVERED_DECISIONS_FILE),
  };
}
