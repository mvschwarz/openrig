/**
 * Test-only recording local HTTP bridge fixture (`recording-relay.ts`).
 *
 * NOTE: This is a local test recording bridge for verifying OpenRig's loopback
 * HTTP relay contract in integration tests and the private environment validator.
 * It is NOT an installed or production messaging platform backend.
 *
 * Strictly zero `vitest` runtime imports so standalone `tsx` scripts can reuse it.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type {
  RelayDigestItem,
  RelayOutboundEnvelope,
} from "../../src/domain/gateway/relay-outbound.js";
import type { RelayInboundOrdering } from "../../src/domain/gateway/relay-inbound.js";

export type { RelayDigestItem, RelayOutboundEnvelope, RelayInboundOrdering };

export interface BridgeCustodyRecord {
  deliveryId: string;
  payloadSha256: string;
  rawBytesSha256: string;
  receivedAt: string;
  envelope: RelayOutboundEnvelope;
}

export interface BridgeSanitizedStats {
  relayPostCount: number;
  acceptedCount: number;
  deduplicatedCount: number;
  conflictCount: number;
  unauthorizedCount: number;
  lostAckCount: number;
  ignoredProbeCount: number;
  custodyCount: number;
  custodyDigestSha256: string;
}

export interface RelayInboundReplyInput {
  eventId: string;
  sender: {
    handle: string;
  };
  replyRef: string;
  text: string;
  ordering?: RelayInboundOrdering;
}

export interface SendInboundReplyOptions {
  /** Override Bearer token (`null` omits the Authorization header). */
  tokenOverride?: string | null;
}

export interface SendInboundReplyResult {
  status: number;
  body: Record<string, unknown>;
}

export interface RecordingRelayOptions {
  /** Expected Bearer token on `POST /outbound` from OpenRig. Held in memory only. */
  outboundToken: string;
  /** Bearer token sent on `POST /api/gateway/relay/inbound` to OpenRig. Held in memory only. */
  inboundToken: string;
  /** Path to durable JSONL custody store file. */
  custodyFilePath: string;
  /** Optional TCP port (defaults to 0 for OS-assigned loopback port). */
  port?: number;
}

export interface RecordingRelayHandle {
  readonly baseUrl: string;
  readonly outboundUrl: string;
  readonly port: number;
  readonly custodyFilePath: string;
  setLoseNextAck(lose: boolean): void;
  getCustodyRecords(): BridgeCustodyRecord[];
  getSanitizedStats(): BridgeSanitizedStats;
  restart(): Promise<void>;
  stop(): Promise<void>;
  sendInboundReply(
    daemonBaseUrl: string,
    payload: RelayInboundReplyInput,
    opts?: SendInboundReplyOptions,
  ): Promise<SendInboundReplyResult>;
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`).join(",")}}`;
}

export function computeCanonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8")
    .digest("hex");
}

function constantTimeBearerCheck(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authHeader || typeof authHeader !== "string") return false;
  const match = /^Bearer\s+(\S+)$/.exec(authHeader.trim());
  if (!match?.[1] || !expectedToken) return false;
  const providedBuf = Buffer.from(match[1], "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

const ALLOWED_ITEM_KEYS = new Set([
  "qitemId",
  "notificationKey",
  "summary",
  "body",
  "replyRef",
]);

function validateOutboundEnvelope(
  parsed: unknown,
): { ok: true; envelope: RelayOutboundEnvelope } | { ok: false; error: string } {
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Envelope must be a JSON object" };
  }
  for (const k of Object.keys(parsed)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(k)) {
      return { ok: false, error: `Unknown envelope field: ${k}` };
    }
  }
  if (parsed.v !== 1) {
    return { ok: false, error: "Expected protocol version v: 1" };
  }
  if (typeof parsed.deliveryId !== "string" || !parsed.deliveryId.trim()) {
    return { ok: false, error: "Missing or empty deliveryId" };
  }
  if (
    !isPlainObject(parsed.recipient) ||
    typeof parsed.recipient.handle !== "string" ||
    !parsed.recipient.handle.trim() ||
    Object.keys(parsed.recipient).some((k) => k !== "handle")
  ) {
    return { ok: false, error: "Invalid recipient.handle" };
  }
  if (parsed.intent !== "decision" && parsed.intent !== "update") {
    return { ok: false, error: "Invalid intent (expected decision | update)" };
  }
  if (
    parsed.outcome !== "interrupt" &&
    parsed.outcome !== "notify" &&
    parsed.outcome !== "digest"
  ) {
    return { ok: false, error: "Invalid outcome (expected interrupt | notify | digest)" };
  }
  if (typeof parsed.summary !== "string" || typeof parsed.body !== "string") {
    return { ok: false, error: "Missing summary or body string" };
  }
  if (
    parsed.replyRef !== null &&
    (typeof parsed.replyRef !== "string" || !parsed.replyRef.trim())
  ) {
    return { ok: false, error: "Invalid replyRef (expected string | null)" };
  }

  let items: RelayDigestItem[] | undefined;
  if (parsed.items !== undefined) {
    if (!Array.isArray(parsed.items)) {
      return { ok: false, error: "Invalid items array" };
    }
    items = [];
    for (const item of parsed.items) {
      if (!isPlainObject(item)) {
        return { ok: false, error: "Digest item must be an object" };
      }
      for (const k of Object.keys(item)) {
        if (!ALLOWED_ITEM_KEYS.has(k)) {
          return { ok: false, error: `Unknown digest item field: ${k}` };
        }
      }
      if (
        typeof item.qitemId !== "string" ||
        typeof item.notificationKey !== "string" ||
        typeof item.summary !== "string" ||
        (item.body !== undefined && typeof item.body !== "string") ||
        (item.replyRef !== null && typeof item.replyRef !== "string")
      ) {
        return { ok: false, error: "Malformed digest item fields" };
      }
      items.push({
        qitemId: item.qitemId,
        notificationKey: item.notificationKey,
        summary: item.summary,
        ...(item.body !== undefined ? { body: item.body } : {}),
        replyRef: item.replyRef,
      });
    }
  }

  return {
    ok: true,
    envelope: {
      v: 1,
      deliveryId: parsed.deliveryId,
      recipient: { handle: parsed.recipient.handle },
      intent: parsed.intent,
      outcome: parsed.outcome,
      summary: parsed.summary,
      body: parsed.body,
      replyRef: parsed.replyRef,
      ...(items !== undefined ? { items } : {}),
    },
  };
}

function loadCustodyRecordsStrict(custodyFilePath: string): BridgeCustodyRecord[] {
  if (!existsSync(custodyFilePath)) return [];
  const raw = readFileSync(custodyFilePath, "utf8");
  if (!raw.trim()) return [];
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, idx) => {
    const parsed = JSON.parse(line) as unknown;
    if (
      !isPlainObject(parsed) ||
      typeof parsed.deliveryId !== "string" ||
      typeof parsed.payloadSha256 !== "string" ||
      typeof parsed.rawBytesSha256 !== "string" ||
      typeof parsed.receivedAt !== "string" ||
      !isPlainObject(parsed.envelope)
    ) {
      throw new Error(`Invalid custody record at line ${idx + 1}`);
    }
    return {
      deliveryId: parsed.deliveryId,
      payloadSha256: parsed.payloadSha256,
      rawBytesSha256: parsed.rawBytesSha256,
      receivedAt: parsed.receivedAt,
      envelope: parsed.envelope as unknown as RelayOutboundEnvelope,
    };
  });
}

function appendCustodyRecordDurable(
  custodyFilePath: string,
  record: BridgeCustodyRecord,
): void {
  mkdirSync(dirname(custodyFilePath), { recursive: true });
  const fd = openSync(custodyFilePath, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      chunks.push(buf);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
      }
    });
    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, status: 400, error: "stream_error" });
      }
    });
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf8")),
  });
  res.end(body);
}

export async function startRecordingRelay(
  opts: RecordingRelayOptions,
): Promise<RecordingRelayHandle> {
  // Secrets remain in closure memory only — never written to custody log or stats
  const expectedOutboundToken = opts.outboundToken;
  const defaultInboundToken = opts.inboundToken;
  const custodyFilePath = opts.custodyFilePath;
  const host = "127.0.0.1";

  let loseNextAck = false;
  let relayPostCount = 0;
  let acceptedCount = 0;
  let deduplicatedCount = 0;
  let conflictCount = 0;
  let unauthorizedCount = 0;
  let lostAckCount = 0;
  let ignoredProbeCount = 0;

  let server: Server | null = null;
  let boundPort = opts.port ?? 0;

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const urlPath = (req.url ?? "/").split("?")[0];

    // Ignore non-relay probes (such as host GET / checks) without counting as relay POSTs
    if (method !== "POST" || urlPath !== "/outbound") {
      ignoredProbeCount += 1;
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    relayPostCount += 1;

    const authHeader =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
    if (!constantTimeBearerCheck(authHeader, expectedOutboundToken)) {
      unauthorizedCount += 1;
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      sendJson(res, bodyResult.status, { ok: false, error: bodyResult.error });
      return;
    }

    const rawBytesSha256 = createHash("sha256")
      .update(bodyResult.text, "utf8")
      .digest("hex");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bodyResult.text);
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" });
      return;
    }

    const validation = validateOutboundEnvelope(parsedJson);
    if (!validation.ok) {
      sendJson(res, 400, { ok: false, error: validation.error });
      return;
    }

    const envelope = validation.envelope;
    const payloadSha256 = computeCanonicalSha256(envelope);

    let existingRecords: BridgeCustodyRecord[];
    try {
      existingRecords = loadCustodyRecordsStrict(custodyFilePath);
    } catch {
      sendJson(res, 503, { ok: false, error: "custody_store_corrupted" });
      return;
    }

    const existing = existingRecords.find(
      (r) => r.deliveryId === envelope.deliveryId,
    );
    if (existing) {
      if (existing.payloadSha256 === payloadSha256) {
        deduplicatedCount += 1;
        sendJson(res, 200, {
          ok: true,
          deliveryId: envelope.deliveryId,
          deduplicated: true,
        });
        return;
      }
      conflictCount += 1;
      sendJson(res, 409, {
        ok: false,
        error: "delivery_id_payload_conflict",
        deliveryId: envelope.deliveryId,
      });
      return;
    }

    // Durable custody commit + fsync BEFORE returning 2xx (or simulating lost ACK)
    const record: BridgeCustodyRecord = {
      deliveryId: envelope.deliveryId,
      payloadSha256,
      rawBytesSha256,
      receivedAt: new Date().toISOString(),
      envelope,
    };

    try {
      appendCustodyRecordDurable(custodyFilePath, record);
    } catch {
      sendJson(res, 503, { ok: false, error: "custody_write_failed" });
      return;
    }

    acceptedCount += 1;

    if (loseNextAck) {
      loseNextAck = false;
      lostAckCount += 1;
      sendJson(res, 502, {
        ok: false,
        error: "simulated_lost_ack_after_durable_commit",
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      deliveryId: envelope.deliveryId,
      deduplicated: false,
    });
  };

  const listenServer = async (portToBind: number): Promise<void> => {
    const srv = createServer((req, res) => {
      void handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(portToBind, host, () => {
        srv.removeListener("error", reject);
        resolve();
      });
    });
    boundPort = (srv.address() as AddressInfo).port;
    server = srv;
  };

  const closeServer = async (): Promise<void> => {
    const srv = server;
    server = null;
    if (!srv) return;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  };

  await listenServer(boundPort);

  return {
    get baseUrl(): string {
      return `http://${host}:${boundPort}`;
    },
    get outboundUrl(): string {
      return `http://${host}:${boundPort}/outbound`;
    },
    get port(): number {
      return boundPort;
    },
    get custodyFilePath(): string {
      return custodyFilePath;
    },
    setLoseNextAck(lose: boolean): void {
      loseNextAck = lose;
    },
    getCustodyRecords(): BridgeCustodyRecord[] {
      return loadCustodyRecordsStrict(custodyFilePath);
    },
    getSanitizedStats(): BridgeSanitizedStats {
      let records: BridgeCustodyRecord[] = [];
      try {
        records = loadCustodyRecordsStrict(custodyFilePath);
      } catch {
        records = [];
      }
      const digestInput = records
        .map((r) => `${r.deliveryId}:${r.payloadSha256}`)
        .join("\n");
      const custodyDigestSha256 = createHash("sha256")
        .update(digestInput, "utf8")
        .digest("hex");

      return {
        relayPostCount,
        acceptedCount,
        deduplicatedCount,
        conflictCount,
        unauthorizedCount,
        lostAckCount,
        ignoredProbeCount,
        custodyCount: records.length,
        custodyDigestSha256,
      };
    },
    async restart(): Promise<void> {
      const portToRebind = boundPort;
      await closeServer();
      await listenServer(portToRebind);
    },
    async stop(): Promise<void> {
      await closeServer();
    },
    async sendInboundReply(
      daemonBaseUrl: string,
      payload: RelayInboundReplyInput,
      replyOpts?: SendInboundReplyOptions,
    ): Promise<SendInboundReplyResult> {
      const targetUrl = `${daemonBaseUrl.replace(/\/+$/, "")}/api/gateway/relay/inbound`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const tokenToUse =
        replyOpts && "tokenOverride" in replyOpts
          ? replyOpts.tokenOverride
          : defaultInboundToken;
      if (tokenToUse !== null && tokenToUse !== undefined) {
        headers.authorization = `Bearer ${tokenToUse}`;
      }

      const wirePayload = JSON.stringify({
        eventId: payload.eventId,
        sender: { handle: payload.sender.handle },
        replyRef: payload.replyRef,
        text: payload.text,
        ordering: payload.ordering ?? "after-question",
      });

      const response = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: wirePayload,
      });

      const rawText = await response.text();
      let parsedBody: Record<string, unknown> = {};
      try {
        const json = JSON.parse(rawText) as unknown;
        if (isPlainObject(json)) parsedBody = json;
      } catch {
        parsedBody = { rawText };
      }

      return { status: response.status, body: parsedBody };
    },
  };
}
