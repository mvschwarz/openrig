import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  HANDLE_PATTERN,
  loadHumanRegistry,
  resolveRelayHandle,
  type HumanFragment,
} from "./human-registry.js";
import {
  authenticateRelayInboundToken,
  loadRelayProfiles,
} from "./relay-config.js";
import {
  decodeRelayReplyRef,
  findPendingRelayReplyRef,
  hashRelayReplyRef,
  type RelayReplyRefPayload,
} from "./relay-outbound.js";
import { SeenStore, nodeStateFs, type StateFsOps } from "./slack/state-store.js";
import {
  parseRelayOwnerNotificationAccepted,
  type RelayOwnerNotificationReceipt,
} from "../queue-transition-log.js";
import type { QueueRepository } from "../queue-repository.js";
import {
  MissionControlWriteContractError,
  type MissionControlActionInput,
  type MissionControlWriteContract,
} from "../mission-control/mission-control-write-contract.js";
import type { MissionControlActionLog } from "../mission-control/mission-control-action-log.js";

export const RELAY_INBOUND_SEEN_FILE = "relay-inbound-seen.jsonl" as const;
export const RELAY_INBOUND_MAX_BODY_BYTES = 64 * 1024;

const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_REPLY_REF_CHARS = 4096;
const MAX_REPLY_TEXT_CHARS = 32_768;
const VALID_SEEN_STATUS_PATTERN = /^(received|processed):([0-9a-f]{64})$/;
const SUSPECT_SEEN_STATUS = "suspect";

export type RelayInboundOrdering = "after-question" | "uncertain";

export interface RelayInboundEnvelope {
  eventId: string;
  sender: { handle: string };
  replyRef: string;
  text: string;
  ordering: RelayInboundOrdering;
}

export interface RelayInboundRequestInput {
  authorizationHeader: string | undefined;
  rawBody: string;
}

export interface RelayInboundResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface RelayInboundHandlerDeps {
  home: string;
  queueRepo: QueueRepository;
  missionControlWriteContract: MissionControlWriteContract;
  missionControlActionLog?: MissionControlActionLog;
  stateFs?: StateFsOps;
  loadEntities?: () =>
    | { ok: true; entities: HumanFragment[] }
    | { ok: false; error: string };
}

export interface RelayInboundHandler {
  handle(input: RelayInboundRequestInput): Promise<RelayInboundResponse>;
}

/**
 * Verify that a TCP socket remoteAddress is a direct local loopback peer.
 * Never trusts HTTP Host or X-Forwarded-* headers.
 * Rejects missing/empty remoteAddress (e.g. in-memory app.request without a socket).
 */
export function isDirectLoopbackPeer(remoteAddress: string | undefined | null): boolean {
  if (typeof remoteAddress !== "string") return false;
  const trimmed = remoteAddress.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed === "::1") return true;
  const stripped = trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
  const ipv4Match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(stripped);
  if (!ipv4Match) return false;
  return [ipv4Match[1], ipv4Match[2], ipv4Match[3]].every((octet) => {
    const num = Number(octet);
    return Number.isInteger(num) && num >= 0 && num <= 255;
  });
}

/**
 * Deterministic SeenStore key for a relay inbound event, scoped globally across
 * the authenticated relay profile's questions so reusing an eventId on a
 * different question is detected as equivocation.
 */
export function computeRelayEventKey(connectorRef: string, eventId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([connectorRef, eventId]))
    .digest("hex");
}

/**
 * Deterministic metadata-only fingerprint of the canonical inbound envelope and
 * resolved responder identity. Never stores plaintext reply text.
 */
export function computeRelayEventFingerprint(input: {
  connectorRef: string;
  eventId: string;
  senderHandle: string;
  actorSession: string;
  replyRef: string;
  qitemId: string;
  episodeKey: string;
  decisionRevision: string;
  mode: "ask" | "park";
  ordering: RelayInboundOrdering;
  text: string;
}): string {
  const textHash = createHash("sha256").update(input.text).digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        connectorRef: input.connectorRef,
        eventId: input.eventId,
        senderHandle: input.senderHandle,
        actorSession: input.actorSession,
        replyRef: input.replyRef,
        qitemId: input.qitemId,
        episodeKey: input.episodeKey,
        decisionRevision: input.decisionRevision,
        mode: input.mode,
        ordering: input.ordering,
        textHash,
      }),
    )
    .digest("hex");
}

function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match || !match[1]) return null;
  return match[1];
}

function parseInboundEnvelope(
  rawBody: string,
): { ok: true; envelope: RelayInboundEnvelope } | { ok: false; status: number; code: string; message: string } {
  if (Buffer.byteLength(rawBody, "utf8") > RELAY_INBOUND_MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "payload_too_large",
      message: `relay inbound payload exceeds ${RELAY_INBOUND_MAX_BODY_BYTES} bytes`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_json",
      message: "request body must be valid JSON",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_envelope",
      message: "relay inbound payload must be a JSON object",
    };
  }

  const obj = parsed as Record<string, unknown>;
  const { eventId, sender, replyRef, text, ordering } = obj;
  if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_envelope",
      message: "eventId must be a non-empty identifier (1..256 chars, [A-Za-z0-9._:-])",
    };
  }

  if (!sender || typeof sender !== "object" || Array.isArray(sender)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_envelope",
      message: "sender must be an object with a handle field",
    };
  }
  const senderObj = sender as Record<string, unknown>;
  if (typeof senderObj.handle !== "string" || !HANDLE_PATTERN.test(senderObj.handle)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_envelope",
      message: "sender.handle must be a valid non-empty handle",
    };
  }

  if (typeof replyRef !== "string" || replyRef.length === 0 || replyRef.length > MAX_REPLY_REF_CHARS) {
    return {
      ok: false,
      status: 400,
      code: "invalid_envelope",
      message: "replyRef must be a non-empty string",
    };
  }

  if (
    typeof text !== "string" ||
    text.includes("\0") ||
    text.length > MAX_REPLY_TEXT_CHARS ||
    text.trim().length === 0
  ) {
    return {
      ok: false,
      status: 400,
      code: "invalid_envelope",
      message: "text must be a non-empty string without NUL bytes",
    };
  }

  let normalizedOrdering: RelayInboundOrdering = "uncertain";
  if (ordering !== undefined) {
    if (ordering !== "after-question" && ordering !== "uncertain") {
      return {
        ok: false,
        status: 400,
        code: "invalid_envelope",
        message: "ordering must be 'after-question' or 'uncertain' when provided",
      };
    }
    normalizedOrdering = ordering;
  }

  return {
    ok: true,
    envelope: {
      eventId,
      sender: { handle: senderObj.handle },
      replyRef,
      text: text.trim(),
      ordering: normalizedOrdering,
    },
  };
}

function receiptMatchesReplyRef(
  receipt: RelayOwnerNotificationReceipt,
  replyRef: string,
  ref: RelayReplyRefPayload,
): boolean {
  if (receipt.kind === "human-update") return false;
  if (receipt.notificationKey !== ref.episodeKey && receipt.episodeKey !== ref.episodeKey) {
    return false;
  }
  if (receipt.connectorRef && receipt.connectorRef !== ref.connectorRef) {
    return false;
  }
  if (receipt.revision && receipt.revision !== ref.decisionRevision) {
    return false;
  }
  if (receipt.deliveryId && !ref.digest && receipt.deliveryId !== ref.decisionId) {
    return false;
  }
  if (receipt.replyRef !== null) {
    return receipt.replyRef === replyRef;
  }
  const fullHash = hashRelayReplyRef(replyRef);
  if (receipt.replyRefHash === fullHash) return true;
  return false;
}

function verifyOfferedReplyRef(
  home: string,
  queueRepo: QueueRepository,
  replyRef: string,
  ref: RelayReplyRefPayload,
): { ok: true } | { ok: false; code: string; message: string } {
  const item = queueRepo.getById(ref.qitemId);
  if (!item) {
    return {
      ok: false,
      code: "qitem_not_found",
      message: `qitem ${ref.qitemId} not found`,
    };
  }

  if (item.humanIntent === "update") {
    return {
      ok: false,
      code: "reply_not_allowed_for_update",
      message: `qitem ${ref.qitemId} is an informational update and cannot be answered`,
    };
  }

  const transitions = queueRepo.listTransitions(ref.qitemId);
  const episodeIdPart = Number(ref.episodeKey.slice(`${ref.qitemId}:`.length));
  const episodeTransition = transitions.find((t) => t.transitionId === episodeIdPart);
  if (episodeTransition?.ownerNotificationKind === "human-update") {
    return {
      ok: false,
      code: "reply_not_allowed_for_update",
      message: `episode ${ref.episodeKey} is an informational update and cannot be answered`,
    };
  }

  // 1. Check durable accepted receipts via QueueRepository / transition log
  const receipts =
    typeof queueRepo.listRelayOwnerNotificationReceipts === "function"
      ? queueRepo.listRelayOwnerNotificationReceipts(ref.qitemId)
      : transitions
          .map((t) => parseRelayOwnerNotificationAccepted(t.transitionNote))
          .filter((r): r is RelayOwnerNotificationReceipt => r !== null);
  for (const receipt of receipts) {
    if (receiptMatchesReplyRef(receipt, replyRef, ref)) {
      return { ok: true };
    }
  }

  // 2. Check pending DispatchBuffer (when outbound relay HTTP POST returned 2xx and inbound reply arrives before ack drain)
  try {
    const pending = findPendingRelayReplyRef(home, replyRef);
    if (
      pending.found &&
      pending.connectorRef === ref.connectorRef &&
      pending.qitemId === ref.qitemId &&
      pending.episodeKey === ref.episodeKey &&
      pending.decisionRevision === ref.decisionRevision
    ) {
      return { ok: true };
    }
  } catch {
    // Unreadable dispatch buffer cannot prove an un-receipted ref; fall through to rejection
  }

  return {
    ok: false,
    code: "unrecognized_reply_ref",
    message: "replyRef does not match any active or accepted outbound relay decision",
  };
}

function formatDecisionText(text: string, ordering: RelayInboundOrdering): string {
  if (ordering === "after-question") return text;
  return `${text} [relay ordering=uncertain: timing relative to question was not verified by relay]`;
}

/**
 * Wrap StateFsOps so SeenStore.statuses() fails closed (503) when history is
 * unreadable or contains unparseable/unkeyable lines, while scoping keyed
 * suspect records (missing/invalid status or conflicting fingerprints) to only
 * their own eventKey so unrelated keys remain available and unvouched history
 * never counts as unseen. Diagnostic fields such as `ts` or extra metadata are
 * ignored when `id` and `status` vouch for the event.
 */
function strictRelayStateFs(base: StateFsOps = nodeStateFs): StateFsOps {
  return {
    ...base,
    readFileSync(p: string): string {
      const raw = base.readFileSync(p);
      const suspectIds = new Set<string>();
      const seenFingerprints = new Map<string, string>();
      const normalizedLines: string[] = [];

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new Error("corrupt relay inbound seen-store JSONL line");
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          typeof (parsed as { id?: unknown }).id !== "string" ||
          !(parsed as { id: string }).id.trim()
        ) {
          throw new Error("unkeyable relay inbound seen-store record");
        }
        const rec = parsed as { id: string; status?: unknown };
        const id = rec.id;
        const statusStr = typeof rec.status === "string" ? rec.status : "";
        const match = VALID_SEEN_STATUS_PATTERN.exec(statusStr);
        const priorFp = seenFingerprints.get(id);
        if (
          !match ||
          suspectIds.has(id) ||
          (priorFp !== undefined && priorFp !== match[2])
        ) {
          suspectIds.add(id);
          normalizedLines.push(JSON.stringify({ id, status: SUSPECT_SEEN_STATUS }));
        } else {
          seenFingerprints.set(id, match[2]!);
          normalizedLines.push(trimmed);
        }
      }
      return normalizedLines.join("\n");
    },
  };
}

export function createRelayInboundHandler(deps: RelayInboundHandlerDeps): RelayInboundHandler {
  const seenPath = join(deps.home, "state", RELAY_INBOUND_SEEN_FILE);
  const seenStore = new SeenStore(seenPath, strictRelayStateFs(deps.stateFs ?? nodeStateFs));
  const inFlightByKey = new Map<string, Promise<RelayInboundResponse>>();

  const loadEntities =
    deps.loadEntities ??
    (() => {
      const loaded = loadHumanRegistry(deps.home, { readOnly: true });
      if (!loaded.ok) return { ok: false as const, error: loaded.error };
      return { ok: true as const, entities: loaded.entities };
    });

  const runSerialized = async (
    eventKey: string,
    fn: () => Promise<RelayInboundResponse>,
  ): Promise<RelayInboundResponse> => {
    const prior = inFlightByKey.get(eventKey) ?? Promise.resolve({ status: 200, body: {} });
    const next = prior.then(
      () => fn(),
      () => fn(),
    );
    inFlightByKey.set(eventKey, next);
    try {
      return await next;
    } finally {
      if (inFlightByKey.get(eventKey) === next) {
        inFlightByKey.delete(eventKey);
      }
    }
  };

  return {
    async handle(input: RelayInboundRequestInput): Promise<RelayInboundResponse> {
      // 1. Require explicit Bearer token; missing/unready never bypasses authentication
      const bearerToken = extractBearerToken(input.authorizationHeader);
      if (!bearerToken) {
        return {
          status: 401,
          body: {
            error: "unauthorized",
            message: "Missing or malformed Authorization: Bearer token for relay inbound",
          },
        };
      }

      const registry = loadEntities();
      if (!registry.ok) {
        return {
          status: 401,
          body: {
            error: "unauthorized",
            message: "Relay inbound authentication is unavailable because human registry cannot be read",
          },
        };
      }

      const profiles = loadRelayProfiles(deps.home, { entities: registry.entities });
      const auth = authenticateRelayInboundToken(profiles, bearerToken);
      if (!auth.ok) {
        return {
          status: 401,
          body: {
            error: "unauthorized",
            reason: auth.reason,
            message: "Invalid or unready relay inbound bearer token",
          },
        };
      }

      const authenticatedConnectorRef = auth.profile.connectorRef;

      // 2. Parse and validate closed JSON envelope
      const parsedEnv = parseInboundEnvelope(input.rawBody);
      if (!parsedEnv.ok) {
        return {
          status: parsedEnv.status,
          body: {
            error: parsedEnv.code,
            message: parsedEnv.message,
          },
        };
      }
      const { envelope } = parsedEnv;

      // 3. Decode replyRef and enforce profile match + sender handle resolution
      const decodedRef = decodeRelayReplyRef(envelope.replyRef);
      if (!decodedRef.ok) {
        return {
          status: 400,
          body: {
            error: "invalid_reply_ref",
            message: decodedRef.error,
          },
        };
      }
      const ref = decodedRef.ref;

      if (ref.connectorRef !== authenticatedConnectorRef) {
        return {
          status: 403,
          body: {
            error: "connector_ref_mismatch",
            message: "replyRef connectorRef does not match the authenticated relay profile",
          },
        };
      }

      const senderResolution = resolveRelayHandle(
        authenticatedConnectorRef,
        envelope.sender.handle,
        registry.entities,
      );
      if (senderResolution.kind !== "registered") {
        return {
          status: 403,
          body: {
            error: "sender_not_bound",
            message: senderResolution.error,
          },
        };
      }

      const actorSession = senderResolution.address;
      const eventKey = computeRelayEventKey(authenticatedConnectorRef, envelope.eventId);
      const fingerprint = computeRelayEventFingerprint({
        connectorRef: authenticatedConnectorRef,
        eventId: envelope.eventId,
        senderHandle: envelope.sender.handle,
        actorSession,
        replyRef: envelope.replyRef,
        qitemId: ref.qitemId,
        episodeKey: ref.episodeKey,
        decisionRevision: ref.decisionRevision,
        mode: ref.mode,
        ordering: envelope.ordering,
        text: envelope.text,
      });

      return runSerialized(eventKey, async () => {
        // 4. Strict SeenStore read path: fail closed (503) if corrupt/unreadable
        let statuses: Map<string, string>;
        try {
          statuses = seenStore.statuses();
        } catch {
          return {
            status: 503,
            body: {
              error: "seen_store_unavailable",
              message: "Relay inbound seen-store is unreadable; refusing to process or acknowledge",
            },
          };
        }

        const receivedTag = `received:${fingerprint}`;
        const processedTag = `processed:${fingerprint}`;
        const existingStatus = statuses.get(eventKey);
        const verb = ref.mode === "ask" ? ("answer" as const) : ("resolve" as const);

        if (existingStatus !== undefined) {
          const match = VALID_SEEN_STATUS_PATTERN.exec(existingStatus);
          if (!match) {
            return {
              status: 503,
              body: {
                error: "seen_store_unavailable",
                message: "Relay inbound seen-store record for this eventId is corrupt or unvouched; refusing to process or acknowledge",
              },
            };
          }
          const existingFp = match[2];
          if (existingFp !== fingerprint) {
            return {
              status: 409,
              body: {
                error: "event_conflict",
                message: "eventId was already used with a different payload, sender, or target",
              },
            };
          }
          if (existingStatus === processedTag) {
            return {
              status: 200,
              body: {
                ok: true,
                deduplicated: true,
                qitemId: ref.qitemId,
                verb,
                actorSession,
              },
            };
          }
        }

        // 5. Verify offered replyRef & non-update target before first reservation
        if (existingStatus === undefined) {
          const verified = verifyOfferedReplyRef(
            deps.home,
            deps.queueRepo,
            envelope.replyRef,
            ref,
          );
          if (!verified.ok) {
            return {
              status: verified.code === "qitem_not_found" ? 404 : 409,
              body: {
                error: verified.code,
                message: verified.message,
              },
            };
          }

          try {
            seenStore.mark(eventKey, receivedTag);
          } catch {
            return {
              status: 503,
              body: {
                error: "seen_store_unavailable",
                message: "Failed to reserve relay inbound event in seen-store",
              },
            };
          }
        }

        const operationId = `relay:${eventKey}:${fingerprint}`;
        const decision = formatDecisionText(envelope.text, envelope.ordering);
        const actionInput: MissionControlActionInput = {
          verb,
          qitemId: ref.qitemId,
          actorSession,
          identityProvenance: "transport:v1",
          decision,
          ...(verb === "resolve" && envelope.ordering === "after-question"
            ? { answerText: envelope.text }
            : {}),
          expectedRevision: ref.decisionRevision,
          auditNotes: {
            operationId,
            connectorRef: authenticatedConnectorRef,
            eventId: envelope.eventId,
            senderHandle: envelope.sender.handle,
            episodeKey: ref.episodeKey,
            ordering: envelope.ordering,
          },
        };

        try {
          const result = await deps.missionControlWriteContract.act(actionInput);
          try {
            seenStore.mark(eventKey, processedTag);
          } catch {
            return {
              status: 503,
              body: {
                error: "seen_store_unavailable",
                message: "Action committed but seen-store processed mark failed; retry safely with same eventId",
              },
            };
          }

          return {
            status: 200,
            body: {
              ok: true,
              deduplicated: Boolean(result.reconciled),
              reconciled: Boolean(result.reconciled),
              qitemId: ref.qitemId,
              verb,
              actorSession,
              actionId: result.actionId,
            },
          };
        } catch (err) {
          if (err instanceof MissionControlWriteContractError) {
            // If this event was already reserved as `received:<fingerprint>` and its own
            // committed action changed the item's revision before `processed:<fingerprint>`
            // was marked (e.g. a resolve that committed and was later re-parked), check
            // whether the audit log already holds this exact operationId and reconcile
            // without any new mutation.
            if (
              existingStatus === receivedTag &&
              err.code === "decision_revision_changed" &&
              deps.missionControlActionLog
            ) {
              const priorAudit = deps.missionControlActionLog
                .listForQitem(ref.qitemId, 50)
                .find((entry) => entry.auditNotes?.operationId === operationId);
              if (priorAudit) {
                try {
                  seenStore.mark(eventKey, processedTag);
                } catch {
                  return {
                    status: 503,
                    body: {
                      error: "seen_store_unavailable",
                      message: "Action reconciled but seen-store processed mark failed",
                    },
                  };
                }
                return {
                  status: 200,
                  body: {
                    ok: true,
                    deduplicated: true,
                    reconciled: true,
                    qitemId: ref.qitemId,
                    verb,
                    actorSession,
                    actionId: priorAudit.actionId,
                  },
                };
              }
            }

            const status =
              err.code === "qitem_not_found"
                ? 404
                : err.code === "decision_revision_changed" ||
                    err.code === "qitem_already_terminal" ||
                    err.code === "qitem_not_leg1_parked" ||
                    err.code === "answer_not_recorded" ||
                    err.code === "answer_not_closed"
                  ? 409
                  : 400;
            return {
              status,
              body: {
                error: err.code,
                message: err.message,
              },
            };
          }

          return {
            status: 500,
            body: {
              error: "internal_error",
              message: "Relay inbound action failed before completion",
            },
          };
        }
      });
    },
  };
}
