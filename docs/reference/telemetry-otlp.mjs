#!/usr/bin/env node
// Optional reference OTLP/HTTP JSON queue-transition log exporter for OpenRig.
// Reads one bounded page at a time from /api/telemetry/v1/queue-transitions,
// persists a pending batch and proposed next cursor atomically before export,
// and advances its checkpoint only after a resolved OTLP outcome.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TELEMETRY_OTLP_LIMITS = Object.freeze({
  maxLimit: 128,
  maxRecordsPerBatch: 161, // 128 transition rows + 32 gap rows + 1 truncation summary row
  sourceResponseBytes: 128 * 1024,
  otlpResponseBytes: 64 * 1024,
  checkpointBytes: 256 * 1024,
  exportBatchBytes: 256 * 1024,
  cursorBytes: 2048,
  namespaceBytes: 128,
  filterBytes: 256,
  minTimeoutMs: 50,
  maxTimeoutMs: 30_000,
  defaultTimeoutMs: 5_000,
  minRetryMs: 1,
  maxRetryMsBound: 60_000,
  defaultRetryMs: 250,
  defaultMaxRetryMs: 5_000,
  maxRetriesBound: 10,
  defaultMaxRetries: 3,
  minPollMs: 10,
  maxPollMs: 60_000,
  defaultPollMs: 5_000,
});

export const TELEMETRY_OTLP_ALLOWLISTS = Object.freeze({
  stream: "queue-transitions",
  scopeName: "openrig.telemetry.queue_transitions",
  recordBodies: Object.freeze(["openrig.queue.transition", "openrig.telemetry.gap"]),
  states: Object.freeze(["pending", "in-progress", "done", "blocked", "failed", "denied", "canceled", "handed-off"]),
  identityProvenance: Object.freeze(["transport:v1", "relay:v1", "claimed:v1", "origin-unknown:v1", "principal:v1"]),
  closureReasons: Object.freeze(["handed_off_to", "blocked_on", "denied", "canceled", "no-follow-on", "escalation", "superseded"]),
  coverageStatuses: Object.freeze(["retained_window", "partial", "unavailable"]),
  historyCompleteness: Object.freeze(["unknown"]),
  gapCodes: Object.freeze([
    "historical_transitions_not_read",
    "boot_boundary_history_unverified",
    "watermark_regression_history_unverified",
    "before_retained_floor",
    "retained_sequence_gap",
    "conflicting_transition_id",
    "oversized_field",
    "invalid_type",
    "invalid_timestamp",
    "record_byte_limit",
    "gap_details_truncated",
  ]),
  gapFields: Object.freeze(["qitemId", "originalTimestamp", "state", "actorSession", "identityProvenance", "closureReason", "closureTarget"]),
});

export const EXPORTER_USAGE = [
  "usage: node telemetry-otlp.mjs --source <url> --endpoint <url/v1/logs> --checkpoint <path> --namespace <name> [options]",
  "",
  "example:",
  "  node docs/reference/telemetry-otlp.mjs \\",
  "    --source http://127.0.0.1:7433 \\",
  "    --endpoint http://127.0.0.1:4318/v1/logs \\",
  "    --checkpoint /var/tmp/openrig-telemetry-checkpoint.json \\",
  "    --namespace example-source --start retained --once",
  "",
  "options:",
  "  --start <latest|retained>       initial window mode when no checkpoint exists (default: latest)",
  "  --qitem <id>                    exact source qitemId filter bound to checkpoint",
  "  --include-qitem-id              opt in to exporting openrig.qitem.id attribute",
  "  --limit <1..128>                source rows scanned per page (default: 128)",
  "  --once                          run exactly one bounded page/replay step and exit",
  "  --poll-ms <10..60000>           idle poll interval in continuous mode (default: 5000)",
  "  --timeout-ms <50..30000>        per-request HTTP timeout (default: 5000)",
  "  --retry-ms <1..10000>           base retry backoff in ms (default: 250)",
  "  --max-retry-ms <10..60000>      max backoff / Retry-After cap in ms (default: 5000)",
  "  --max-retries <0..10>           max retries for 429/502/503/504 and network errors (default: 3)",
  "  --on-permanent-error <stop|drop> stop (default) or drop on non-retryable 4xx/5xx rejection",
  "  --help, -h                      print this usage information",
].join("\n");

const MAX_DECIMAL_ID = 9223372036854775807n;
const SAFE_TOKEN_RE = /^[A-Za-z0-9._:-]+$/;
const CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const RETRYABLE_OTLP_STATUSES = new Set([429, 502, 503, 504]);

export class TelemetryCheckpointError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TelemetryCheckpointError";
    this.code = code;
  }
}

export class TelemetrySourceError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "TelemetrySourceError";
    this.code = code;
    this.status = status;
  }
}

export class TelemetryExportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TelemetryExportError";
    this.code = code;
    Object.assign(this, details);
  }
}

function isDecimalId(value, allowZero = false) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
  if (!allowZero && value === "0") return false;
  return BigInt(value) <= MAX_DECIMAL_ID;
}

function isCursorToken(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= TELEMETRY_OTLP_LIMITS.cursorBytes && CURSOR_RE.test(value);
}

function isSafeToken(value, maxBytes) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes && SAFE_TOKEN_RE.test(value);
}

function isBoundedFilter(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= TELEMETRY_OTLP_LIMITS.filterBytes && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeQitemId(value) {
  return isBoundedFilter(value) && !/[\s/\\]/.test(value);
}

function isJsonContentType(headers) {
  const raw = Array.isArray(headers?.["content-type"]) ? headers["content-type"][0] : headers?.["content-type"];
  return typeof raw === "string" && /^application\/json(?:\s*;|$)/i.test(raw.trim());
}

function isoToUnixNano(iso) {
  if (typeof iso !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(iso);
  if (!match) return null;
  const wholeSecondsMs = Date.parse(`${match[1]}.000Z`);
  if (!Number.isFinite(wholeSecondsMs)) return null;
  const nanosFraction = BigInt((match[2] ?? "").padEnd(9, "0").slice(0, 9));
  return ((BigInt(wholeSecondsMs) / 1000n) * 1_000_000_000n + nanosFraction).toString();
}

function parseCleanHttpUrl(raw, ErrorClass, code, label) {
  if (typeof raw !== "string" || !raw.trim()) throw new ErrorClass(code, `${label} URL is required`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ErrorClass(code, `${label} URL is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ErrorClass(code, `${label} URL must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ErrorClass(code, `${label} URL must not contain credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new ErrorClass(code, `${label} URL must not include query parameters or fragments`);
  }
  return parsed;
}

function normalizeSourceUrl(raw) {
  const parsed = parseCleanHttpUrl(raw, TelemetrySourceError, "invalid_source_url", "Source");
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (trimmedPath === "" || trimmedPath === "/api/telemetry/v1/queue-transitions") {
    parsed.pathname = "/api/telemetry/v1/queue-transitions";
  } else {
    throw new TelemetrySourceError("invalid_source_url", "Source URL path must be / or /api/telemetry/v1/queue-transitions");
  }
  return parsed.toString();
}

function normalizeEndpointUrl(raw) {
  const parsed = parseCleanHttpUrl(raw, TelemetryExportError, "invalid_endpoint_url", "OTLP endpoint");
  if (!parsed.pathname.endsWith("/v1/logs")) {
    throw new TelemetryExportError("invalid_endpoint_url", "OTLP logs endpoint URL path must end with /v1/logs");
  }
  return parsed.toString();
}

function boundedInt(value, defaultValue, min, max, name) {
  if (value === undefined) return defaultValue;
  const num = typeof value === "number" ? value : (typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : NaN);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return num;
}

function normalizeConfig(options) {
  if (!options || typeof options !== "object") throw new Error("Exporter options are required");
  const sourceUrl = normalizeSourceUrl(options.sourceUrl);
  const endpointUrl = normalizeEndpointUrl(options.endpointUrl);
  if (typeof options.checkpointPath !== "string" || !options.checkpointPath.trim()) {
    throw new TelemetryCheckpointError("invalid_checkpoint_path", "checkpointPath is required");
  }
  const checkpointPath = resolve(options.checkpointPath);
  if (!isSafeToken(options.namespace, TELEMETRY_OTLP_LIMITS.namespaceBytes)) {
    throw new Error("namespace must be 1..128 ASCII identifier characters ([A-Za-z0-9._:-])");
  }
  const start = options.start ?? "latest";
  if (start !== "latest" && start !== "retained") throw new Error("start must be latest or retained");
  const qitemId = options.qitemId ?? null;
  if (qitemId !== null && !isBoundedFilter(qitemId)) throw new Error("qitemId filter must be 1..256 printable bytes");
  const includeQitemId = Boolean(options.includeQitemId);
  const limit = boundedInt(options.limit, TELEMETRY_OTLP_LIMITS.maxLimit, 1, TELEMETRY_OTLP_LIMITS.maxLimit, "limit");
  const timeoutMs = boundedInt(options.timeoutMs, TELEMETRY_OTLP_LIMITS.defaultTimeoutMs, TELEMETRY_OTLP_LIMITS.minTimeoutMs, TELEMETRY_OTLP_LIMITS.maxTimeoutMs, "timeoutMs");
  const retryMs = boundedInt(options.retryMs, TELEMETRY_OTLP_LIMITS.defaultRetryMs, TELEMETRY_OTLP_LIMITS.minRetryMs, 10_000, "retryMs");
  const maxRetryMs = boundedInt(options.maxRetryMs, Math.max(retryMs, TELEMETRY_OTLP_LIMITS.defaultMaxRetryMs), Math.max(retryMs, 10), TELEMETRY_OTLP_LIMITS.maxRetryMsBound, "maxRetryMs");
  const maxRetries = boundedInt(options.maxRetries, TELEMETRY_OTLP_LIMITS.defaultMaxRetries, 0, TELEMETRY_OTLP_LIMITS.maxRetriesBound, "maxRetries");
  const pollMs = boundedInt(options.pollMs, TELEMETRY_OTLP_LIMITS.defaultPollMs, TELEMETRY_OTLP_LIMITS.minPollMs, TELEMETRY_OTLP_LIMITS.maxPollMs, "pollMs");
  const onPermanentError = options.onPermanentError ?? "stop";
  if (onPermanentError !== "stop" && onPermanentError !== "drop") throw new Error("onPermanentError must be stop or drop");
  const identity = {
    stream: TELEMETRY_OTLP_ALLOWLISTS.stream,
    namespace: options.namespace,
    sourceUrl,
    endpointUrl,
    start,
    qitemId,
    includeQitemId,
  };
  const configHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return {
    ...identity,
    checkpointPath,
    limit,
    timeoutMs,
    retryMs,
    maxRetryMs,
    maxRetries,
    pollMs,
    onPermanentError,
    once: Boolean(options.once),
    configHash,
    onDiagnostic: typeof options.onDiagnostic === "function" ? options.onDiagnostic : null,
  };
}

export function parseExporterArgs(argv) {
  if (Array.isArray(argv) && (argv.includes("--help") || argv.includes("-h"))) {
    return { help: true, usage: EXPORTER_USAGE };
  }
  const raw = { once: false, includeQitemId: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Flag ${arg} requires a value`);
      return argv[++i];
    };
    if (arg === "--source") raw.sourceUrl = next();
    else if (arg === "--endpoint") raw.endpointUrl = next();
    else if (arg === "--checkpoint") raw.checkpointPath = next();
    else if (arg === "--namespace") raw.namespace = next();
    else if (arg === "--start") raw.start = next();
    else if (arg === "--qitem") raw.qitemId = next();
    else if (arg === "--include-qitem-id") raw.includeQitemId = true;
    else if (arg === "--limit") raw.limit = next();
    else if (arg === "--timeout-ms") raw.timeoutMs = next();
    else if (arg === "--retry-ms") raw.retryMs = next();
    else if (arg === "--max-retry-ms") raw.maxRetryMs = next();
    else if (arg === "--max-retries") raw.maxRetries = next();
    else if (arg === "--poll-ms") raw.pollMs = next();
    else if (arg === "--on-permanent-error") raw.onPermanentError = next();
    else if (arg === "--once") raw.once = true;
    else throw new Error(`Unknown CLI argument: ${arg}`);
  }
  return normalizeConfig(raw);
}

const kvString = (key, stringValue) => ({ key, value: { stringValue } });
const kvInt = (key, intValue) => ({ key, value: { intValue: String(intValue) } });
const kvBool = (key, boolValue) => ({ key, value: { boolValue: Boolean(boolValue) } });

function validateSourceEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || envelope.schemaVersion !== 1 || envelope.stream !== TELEMETRY_OTLP_ALLOWLISTS.stream) {
    throw new TelemetrySourceError("invalid_source_envelope", "Unsupported telemetry schemaVersion or stream");
  }
  const observedTimeUnixNano = isoToUnixNano(envelope.observedAt);
  if (!observedTimeUnixNano) {
    throw new TelemetrySourceError("invalid_source_envelope", "Telemetry envelope observedAt must be a valid UTC ISO timestamp");
  }
  const src = envelope.source;
  if (!src || typeof src !== "object" || src.sequenceSpaceId !== null || !isSafeToken(src.bootEpoch, 128)) {
    throw new TelemetrySourceError("invalid_source_envelope", "Telemetry source identity is invalid or sequenceSpaceId is non-null");
  }
  if (src.hostId !== null && (typeof src.hostId !== "string" || Buffer.byteLength(src.hostId) > 256)) {
    throw new TelemetrySourceError("invalid_source_envelope", "Telemetry source hostId exceeds bounds");
  }
  const cov = envelope.coverage;
  if (
    !cov ||
    typeof cov !== "object" ||
    !TELEMETRY_OTLP_ALLOWLISTS.coverageStatuses.includes(cov.status) ||
    !TELEMETRY_OTLP_ALLOWLISTS.historyCompleteness.includes(cov.historyCompleteness) ||
    !Array.isArray(cov.gaps) ||
    cov.gaps.length > 32 ||
    !Number.isInteger(cov.gapCount) ||
    cov.gapCount < cov.gaps.length ||
    cov.gapDetailsTruncated !== (cov.gapCount > cov.gaps.length)
  ) {
    throw new TelemetrySourceError("invalid_source_envelope", "Telemetry coverage metadata is invalid");
  }
  if (!Array.isArray(envelope.rows) || envelope.rows.length > TELEMETRY_OTLP_LIMITS.maxLimit) {
    throw new TelemetrySourceError("invalid_source_envelope", "Telemetry rows exceed page bound");
  }
  const page = envelope.page;
  if (!page || typeof page !== "object" || typeof page.hasMore !== "boolean") {
    throw new TelemetrySourceError("invalid_source_envelope", "Telemetry page metadata is invalid");
  }
  const isDiscontinuity = cov.status === "unavailable" || page.restartCursor !== null;
  if (isDiscontinuity) {
    if (page.nextCursor !== null || !isCursorToken(page.restartCursor) || envelope.rows.length !== 0 || cov.gaps.length === 0) {
      throw new TelemetrySourceError("invalid_source_envelope", "Discontinuity envelope must carry gaps and a valid restartCursor with no rows");
    }
  } else if (!isCursorToken(page.nextCursor) || page.restartCursor !== null) {
    throw new TelemetrySourceError("invalid_source_envelope", "Telemetry page must carry a valid nextCursor");
  }
  return { observedTimeUnixNano, isDiscontinuity };
}

export function buildQueueTransitionLogsPayload(envelope, config, options = {}) {
  const { observedTimeUnixNano, isDiscontinuity } = validateSourceEnvelope(envelope);
  const replayed = Boolean(options.replayed);
  const logRecords = [];

  for (const row of envelope.rows) {
    if (!row || typeof row !== "object" || !isDecimalId(row.transitionId, false)) {
      throw new TelemetrySourceError("invalid_transition_row", "Queue transition row is missing a valid decimal transitionId");
    }
    const attrs = [
      kvString("openrig.record.kind", "queue_transition"),
      kvString("openrig.stream", TELEMETRY_OTLP_ALLOWLISTS.stream),
      kvString("openrig.transition.id", row.transitionId),
    ];
    if (typeof row.state === "string" && TELEMETRY_OTLP_ALLOWLISTS.states.includes(row.state)) {
      attrs.push(kvString("openrig.queue.state", row.state));
    }
    if (typeof row.identityProvenance === "string" && TELEMETRY_OTLP_ALLOWLISTS.identityProvenance.includes(row.identityProvenance)) {
      attrs.push(kvString("openrig.identity.provenance", row.identityProvenance));
    }
    if (typeof row.closureReason === "string" && TELEMETRY_OTLP_ALLOWLISTS.closureReasons.includes(row.closureReason)) {
      attrs.push(kvString("openrig.queue.closure_reason", row.closureReason));
    }
    if (config.includeQitemId && isSafeQitemId(row.qitemId)) {
      attrs.push(kvString("openrig.qitem.id", row.qitemId));
    }
    attrs.push(
      kvString("openrig.coverage.status", envelope.coverage.status),
      kvString("openrig.coverage.history_completeness", envelope.coverage.historyCompleteness),
      kvBool("openrig.delivery.replayed", replayed),
    );
    const eventTimeUnixNano = row.createdAt !== null ? isoToUnixNano(row.createdAt) : null;
    logRecords.push({
      ...(eventTimeUnixNano ? { timeUnixNano: eventTimeUnixNano } : {}),
      observedTimeUnixNano,
      severityNumber: 9,
      severityText: "INFO",
      body: { stringValue: "openrig.queue.transition" },
      attributes: attrs,
    });
  }

  for (const gap of envelope.coverage.gaps) {
    if (!gap || typeof gap !== "object" || !TELEMETRY_OTLP_ALLOWLISTS.gapCodes.includes(gap.code) || gap.code === "gap_details_truncated") {
      throw new TelemetrySourceError("invalid_gap_record", "Telemetry envelope contains an unallowlisted gap code");
    }
    const attrs = [
      kvString("openrig.record.kind", "coverage_gap"),
      kvString("openrig.stream", TELEMETRY_OTLP_ALLOWLISTS.stream),
      kvString("openrig.gap.code", gap.code),
    ];
    if (gap.id !== undefined) {
      if (!isDecimalId(gap.id, false)) throw new TelemetrySourceError("invalid_gap_record", "Invalid decimal gap.id");
      attrs.push(kvString("openrig.gap.id", gap.id));
    }
    if (gap.from !== undefined) {
      if (!isDecimalId(gap.from, false)) throw new TelemetrySourceError("invalid_gap_record", "Invalid decimal gap.from");
      attrs.push(kvString("openrig.gap.from", gap.from));
    }
    if (gap.through !== undefined) {
      if (!isDecimalId(gap.through, true)) throw new TelemetrySourceError("invalid_gap_record", "Invalid decimal gap.through");
      attrs.push(kvString("openrig.gap.through", gap.through));
    }
    if (gap.field !== undefined) {
      if (!TELEMETRY_OTLP_ALLOWLISTS.gapFields.includes(gap.field)) {
        throw new TelemetrySourceError("invalid_gap_record", "Unallowlisted gap.field");
      }
      attrs.push(kvString("openrig.gap.field", gap.field));
    }
    attrs.push(
      kvString("openrig.coverage.status", envelope.coverage.status),
      kvString("openrig.coverage.history_completeness", envelope.coverage.historyCompleteness),
      kvBool("openrig.delivery.replayed", replayed),
    );
    logRecords.push({
      observedTimeUnixNano,
      severityNumber: 13,
      severityText: "WARN",
      body: { stringValue: "openrig.telemetry.gap" },
      attributes: attrs,
    });
  }

  if (envelope.coverage.gapDetailsTruncated) {
    const omitted = envelope.coverage.gapCount - envelope.coverage.gaps.length;
    logRecords.push({
      observedTimeUnixNano,
      severityNumber: 13,
      severityText: "WARN",
      body: { stringValue: "openrig.telemetry.gap" },
      attributes: [
        kvString("openrig.record.kind", "coverage_gap"),
        kvString("openrig.stream", TELEMETRY_OTLP_ALLOWLISTS.stream),
        kvString("openrig.gap.code", "gap_details_truncated"),
        kvInt("openrig.gap.total_count", envelope.coverage.gapCount),
        kvInt("openrig.gap.omitted_count", omitted),
        kvString("openrig.coverage.status", envelope.coverage.status),
        kvString("openrig.coverage.history_completeness", envelope.coverage.historyCompleteness),
        kvBool("openrig.delivery.replayed", replayed),
      ],
    });
  }

  const safeHostId = isSafeToken(envelope.source.hostId, 256) ? envelope.source.hostId : null;
  const resourceAttributes = [
    kvString("service.name", "openrig-telemetry-exporter"),
    kvString("service.namespace", config.namespace),
    kvString("openrig.source.namespace", config.namespace),
    kvString("openrig.source.boot_epoch", envelope.source.bootEpoch),
    ...(safeHostId ? [kvString("openrig.source.host_id", safeHostId)] : []),
  ];

  const payload = {
    resourceLogs: logRecords.length === 0 ? [] : [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: {
              name: TELEMETRY_OTLP_ALLOWLISTS.scopeName,
              version: "1",
              attributes: [kvString("openrig.namespace", config.namespace)],
            },
            logRecords,
          },
        ],
      },
    ],
  };

  if (Buffer.byteLength(JSON.stringify(payload)) > TELEMETRY_OTLP_LIMITS.exportBatchBytes) {
    throw new TelemetryExportError("export_batch_exceeds_byte_limit", "Constructed OTLP batch exceeds maximum export byte bound");
  }

  return {
    recordCount: logRecords.length,
    isDiscontinuity,
    nextCursor: isDiscontinuity ? envelope.page.restartCursor : envelope.page.nextCursor,
    hasMore: envelope.page.hasMore,
    source: { hostId: safeHostId, bootEpoch: envelope.source.bootEpoch, sequenceSpaceId: null },
    coverage: { status: envelope.coverage.status, historyCompleteness: "unknown" },
    payload,
  };
}

function markPayloadReplayed(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  for (const rl of clone.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        if (Array.isArray(rec.attributes)) {
          const entry = rec.attributes.find(a => a.key === "openrig.delivery.replayed");
          if (entry) entry.value = { boolValue: true };
          else rec.attributes.push(kvBool("openrig.delivery.replayed", true));
        }
      }
    }
  }
  return clone;
}

function isValidPendingBlocked(blocked) {
  if (blocked === undefined || blocked === null) return true;
  if (!blocked || typeof blocked !== "object") return false;
  const { code, status } = blocked;
  if (code === "otlp_response_too_large") return status === null;
  if (code === "otlp_invalid_content_type" || code === "otlp_invalid_response") return status === 200;
  if (code === "otlp_unexpected_status") return Number.isInteger(status) && status >= 100 && status < 400 && status !== 200;
  if (code === "otlp_permanent_rejection") {
    return Number.isInteger(status) && status >= 400 && status < 600 && !RETRYABLE_OTLP_STATUSES.has(status);
  }
  return false;
}

function validateCheckpointPending(pending) {
  if (pending === null) return;
  if (
    !pending ||
    typeof pending !== "object" ||
    !Number.isInteger(pending.recordCount) ||
    pending.recordCount < 1 ||
    pending.recordCount > TELEMETRY_OTLP_LIMITS.maxRecordsPerBatch ||
    !isCursorToken(pending.nextCursor) ||
    typeof pending.discontinuity !== "boolean" ||
    typeof pending.hasMore !== "boolean" ||
    !pending.source ||
    pending.source.sequenceSpaceId !== null ||
    !isSafeToken(pending.source.bootEpoch, 128) ||
    (pending.source.hostId !== null && !isSafeToken(pending.source.hostId, 256)) ||
    !pending.coverage ||
    !TELEMETRY_OTLP_ALLOWLISTS.coverageStatuses.includes(pending.coverage.status) ||
    pending.coverage.historyCompleteness !== "unknown" ||
    !isValidPendingBlocked(pending.blocked) ||
    !pending.payload ||
    typeof pending.payload !== "object" ||
    !Array.isArray(pending.payload.resourceLogs) ||
    pending.payload.resourceLogs.length !== 1 ||
    Buffer.byteLength(JSON.stringify(pending.payload)) > TELEMETRY_OTLP_LIMITS.exportBatchBytes
  ) {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint pending batch state is malformed");
  }
  const rl = pending.payload.resourceLogs[0];
  const sl = rl?.scopeLogs?.[0];
  if (
    !rl ||
    !Array.isArray(rl.scopeLogs) ||
    rl.scopeLogs.length !== 1 ||
    sl?.scope?.name !== TELEMETRY_OTLP_ALLOWLISTS.scopeName ||
    !Array.isArray(sl.logRecords) ||
    sl.logRecords.length !== pending.recordCount
  ) {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint pending OTLP structure is malformed");
  }
  for (const rec of sl.logRecords) {
    if (
      !rec ||
      typeof rec !== "object" ||
      rec.traceId !== undefined ||
      rec.spanId !== undefined ||
      !TELEMETRY_OTLP_ALLOWLISTS.recordBodies.includes(rec.body?.stringValue) ||
      !Array.isArray(rec.attributes)
    ) {
      throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint pending logRecord failed validation");
    }
  }
}

function readCheckpoint(config) {
  if (!existsSync(config.checkpointPath)) {
    return {
      schemaVersion: 1,
      configHash: config.configHash,
      config: {
        stream: config.stream,
        namespace: config.namespace,
        sourceUrl: config.sourceUrl,
        endpointUrl: config.endpointUrl,
        start: config.start,
        qitemId: config.qitemId,
        includeQitemId: config.includeQitemId,
      },
      cursor: null,
      source: { hostId: null, bootEpoch: null, sequenceSpaceId: null },
      coverage: { status: "retained_window", historyCompleteness: "unknown" },
      pending: null,
      updatedAt: new Date().toISOString(),
    };
  }
  let stat;
  try {
    stat = lstatSync(config.checkpointPath);
  } catch {
    throw new TelemetryCheckpointError("checkpoint_unreadable", "Checkpoint file could not be stat'd");
  }
  if (!stat.isFile()) {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint path must be a regular file");
  }
  if (stat.size > TELEMETRY_OTLP_LIMITS.checkpointBytes) {
    throw new TelemetryCheckpointError("checkpoint_exceeds_byte_limit", "Checkpoint file exceeds maximum byte bound");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(config.checkpointPath, "utf8"));
  } catch {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint file is not valid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.configHash !== "string" ||
    !parsed.config ||
    typeof parsed.config !== "object" ||
    (parsed.cursor !== null && !isCursorToken(parsed.cursor)) ||
    !parsed.source ||
    parsed.source.sequenceSpaceId !== null ||
    (parsed.source.bootEpoch !== null && !isSafeToken(parsed.source.bootEpoch, 128)) ||
    (parsed.source.hostId !== null && !isSafeToken(parsed.source.hostId, 256)) ||
    !parsed.coverage ||
    parsed.coverage.historyCompleteness !== "unknown" ||
    !TELEMETRY_OTLP_ALLOWLISTS.coverageStatuses.includes(parsed.coverage.status)
  ) {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint file failed schema validation");
  }
  validateCheckpointPending(parsed.pending);
  if (
    parsed.configHash !== config.configHash ||
    parsed.config.stream !== config.stream ||
    parsed.config.namespace !== config.namespace ||
    parsed.config.sourceUrl !== config.sourceUrl ||
    parsed.config.endpointUrl !== config.endpointUrl ||
    parsed.config.start !== config.start ||
    parsed.config.qitemId !== config.qitemId ||
    parsed.config.includeQitemId !== config.includeQitemId
  ) {
    throw new TelemetryCheckpointError("checkpoint_config_mismatch", "Checkpoint configuration does not match current exporter options");
  }
  return parsed;
}

function writeCheckpointAtomically(checkpointPath, state) {
  const serialized = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }) + "\n";
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > TELEMETRY_OTLP_LIMITS.checkpointBytes) {
    throw new TelemetryCheckpointError("checkpoint_exceeds_byte_limit", "Serialized checkpoint exceeds maximum byte bound");
  }
  const dir = dirname(checkpointPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${checkpointPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  let fd = null;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeSync(fd, bytes, 0, bytes.byteLength);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, checkpointPath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function httpRequestBounded(urlString, { method, headers = {}, body = null, timeoutMs, maxResponseBytes }) {
  const url = new URL(urlString);
  const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finishError = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise({ code, message });
    };
    const req = reqFn(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(body !== null ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.byteLength;
          if (total > maxResponseBytes) {
            req.destroy();
            res.destroy();
            finishError("response_too_large", `HTTP response exceeded ${maxResponseBytes} byte bound`);
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", () => finishError("network_error", "HTTP response stream failed"));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finishError("timeout", `HTTP request timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    req.on("error", () => finishError("network_error", "HTTP request failed"));
    if (body !== null) req.write(body);
    req.end();
  });
}

function parseRetryAfterMs(headerValue, maxRetryMs) {
  if (typeof headerValue !== "string" || !headerValue.trim()) return null;
  const trimmed = headerValue.trim();
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
    const ms = Math.ceil(Number(trimmed) * 1000);
    return Number.isFinite(ms) && ms >= 0 ? Math.min(maxRetryMs, ms) : null;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.min(maxRetryMs, Math.max(0, parsedDate - Date.now()));
  }
  return null;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolveSleep();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolveSleep();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function emitDiagnostic(config, event) {
  if (config.onDiagnostic) config.onDiagnostic(event);
}

async function sendOtlpBatch(config, payload, recordCount) {
  const body = JSON.stringify(payload);
  let lastFailureCode = "network_error";
  let lastStatus = null;
  const retryDelaysMs = [];

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    let response;
    try {
      response = await httpRequestBounded(config.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: TELEMETRY_OTLP_LIMITS.otlpResponseBytes,
      });
    } catch (err) {
      if (err && err.code === "response_too_large") {
        emitDiagnostic(config, { type: "otlp_response_too_large", pendingRecords: recordCount });
        throw new TelemetryExportError("otlp_response_too_large", "OTLP receiver response exceeded byte bound", {
          attempts: attempt + 1,
          retryDelaysMs,
          nonRetryableBlock: { code: "otlp_response_too_large", status: null },
        });
      }
      lastFailureCode = err?.code === "timeout" ? "timeout" : "network_error";
      lastStatus = null;
      if (attempt < config.maxRetries) {
        const delayMs = Math.min(config.maxRetryMs, config.retryMs * (2 ** attempt));
        retryDelaysMs.push(delayMs);
        await sleep(delayMs);
        continue;
      }
      throw new TelemetryExportError("otlp_retry_exhausted", `OTLP export failed after ${attempt + 1} attempts (${lastFailureCode})`, {
        reason: lastFailureCode,
        status: null,
        attempts: attempt + 1,
        retryDelaysMs,
      });
    }

    const { status, headers, bodyText } = response;
    if (RETRYABLE_OTLP_STATUSES.has(status)) {
      lastFailureCode = "http_retryable_status";
      lastStatus = status;
      if (attempt < config.maxRetries) {
        const backoffMs = Math.min(config.maxRetryMs, config.retryMs * (2 ** attempt));
        const retryAfterHeader = Array.isArray(headers["retry-after"]) ? headers["retry-after"][0] : headers["retry-after"];
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader, config.maxRetryMs);
        const delayMs = retryAfterMs !== null ? Math.min(config.maxRetryMs, Math.max(backoffMs, retryAfterMs)) : backoffMs;
        retryDelaysMs.push(delayMs);
        await sleep(delayMs);
        continue;
      }
      throw new TelemetryExportError("otlp_retry_exhausted", `OTLP receiver returned retryable HTTP ${status} across ${attempt + 1} attempts`, {
        reason: "http_retryable_status",
        status,
        attempts: attempt + 1,
        retryDelaysMs,
      });
    }

    if (status >= 400 && status < 600) {
      if (config.onPermanentError === "drop") {
        emitDiagnostic(config, { type: "otlp_permanent_rejection_dropped", status, droppedRecords: recordCount });
        return { outcome: "dropped_permanent_rejection", status, droppedRecords: recordCount, attempts: attempt + 1, retryDelaysMs };
      }
      emitDiagnostic(config, { type: "otlp_permanent_rejection_stopped", status, pendingRecords: recordCount });
      throw new TelemetryExportError("otlp_permanent_rejection", `OTLP receiver permanently rejected batch with HTTP ${status}`, {
        status,
        disposition: "stopped",
        attempts: attempt + 1,
        retryDelaysMs,
        nonRetryableBlock: { code: "otlp_permanent_rejection", status },
      });
    }

    if (status !== 200) {
      throw new TelemetryExportError("otlp_unexpected_status", `OTLP receiver returned unexpected HTTP ${status}; expected 200`, {
        status,
        attempts: attempt + 1,
        retryDelaysMs,
        nonRetryableBlock: { code: "otlp_unexpected_status", status },
      });
    }

    if (!isJsonContentType(headers)) {
      throw new TelemetryExportError("otlp_invalid_content_type", "OTLP receiver 200 response must have application/json content-type", {
        status: 200,
        attempts: attempt + 1,
        retryDelaysMs,
        nonRetryableBlock: { code: "otlp_invalid_content_type", status: 200 },
      });
    }

    const invalidResponse = (message) => new TelemetryExportError("otlp_invalid_response", message, {
      status: 200,
      attempts: attempt + 1,
      retryDelaysMs,
      nonRetryableBlock: { code: "otlp_invalid_response", status: 200 },
    });

    let parsedBody;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      throw invalidResponse("OTLP receiver returned non-JSON 200 response");
    }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw invalidResponse("OTLP receiver returned non-object 200 JSON response");
    }
    if (parsedBody.partialSuccess === undefined || parsedBody.partialSuccess === null) {
      return { outcome: "exported", rejectedLogRecords: 0, partialSuccessWarning: false, attempts: attempt + 1, retryDelaysMs };
    }
    if (typeof parsedBody.partialSuccess !== "object" || Array.isArray(parsedBody.partialSuccess)) {
      throw invalidResponse("OTLP partialSuccess field is malformed");
    }
    const rawRejected = parsedBody.partialSuccess.rejectedLogRecords;
    let rejectedCount = 0;
    if (rawRejected !== undefined && rawRejected !== null) {
      if (typeof rawRejected === "number" && Number.isInteger(rawRejected) && rawRejected >= 0) {
        rejectedCount = rawRejected;
      } else if (typeof rawRejected === "string" && /^[0-9]+$/.test(rawRejected)) {
        rejectedCount = Number(rawRejected);
      } else {
        throw invalidResponse("OTLP partialSuccess.rejectedLogRecords is invalid");
      }
    }
    if (!Number.isSafeInteger(rejectedCount) || rejectedCount < 0 || rejectedCount > recordCount) {
      throw invalidResponse("OTLP partialSuccess.rejectedLogRecords is out of bounds");
    }
    const hasWarning = typeof parsedBody.partialSuccess.errorMessage === "string" && parsedBody.partialSuccess.errorMessage.trim().length > 0;
    if (rejectedCount > 0 || hasWarning) {
      emitDiagnostic(config, {
        type: "otlp_partial_success",
        sentRecords: recordCount,
        rejectedLogRecords: rejectedCount,
        partialSuccessWarning: hasWarning,
      });
      return { outcome: "partial_success", rejectedLogRecords: rejectedCount, partialSuccessWarning: hasWarning, attempts: attempt + 1, retryDelaysMs };
    }
    return { outcome: "exported", rejectedLogRecords: 0, partialSuccessWarning: false, attempts: attempt + 1, retryDelaysMs };
  }

  throw new TelemetryExportError("otlp_retry_exhausted", `OTLP export failed (${lastFailureCode})`, {
    reason: lastFailureCode,
    status: lastStatus,
    retryDelaysMs,
  });
}

async function fetchSourcePage(config, cursor) {
  const url = new URL(config.sourceUrl);
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  else url.searchParams.set("start", config.start);
  url.searchParams.set("limit", String(config.limit));
  if (config.qitemId !== null) url.searchParams.set("qitemId", config.qitemId);

  let response;
  try {
    response = await httpRequestBounded(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: config.timeoutMs,
      maxResponseBytes: TELEMETRY_OTLP_LIMITS.sourceResponseBytes,
    });
  } catch (err) {
    if (err?.code === "response_too_large") {
      throw new TelemetrySourceError("source_response_too_large", "Telemetry source response exceeded 128 KiB bound");
    }
    throw new TelemetrySourceError("source_request_failed", `Telemetry source request failed (${err?.code ?? "network_error"})`);
  }

  if (response.status !== 200) {
    throw new TelemetrySourceError("source_http_error", `Telemetry source returned HTTP ${response.status}`, response.status);
  }
  if (!isJsonContentType(response.headers)) {
    throw new TelemetrySourceError("source_invalid_content_type", "Telemetry source response must have application/json content-type", 200);
  }

  try {
    return JSON.parse(response.bodyText);
  } catch {
    throw new TelemetrySourceError("source_invalid_json", "Telemetry source returned invalid JSON", 200);
  }
}

function makeStepResult(state, batchMeta, exportResult = {}) {
  const outcome = exportResult.outcome ?? "empty_page_advanced";
  return {
    outcome,
    exportedRecords: outcome === "dropped_permanent_rejection" || outcome === "empty_page_advanced" ? 0 : batchMeta.recordCount,
    rejectedLogRecords: exportResult.rejectedLogRecords ?? 0,
    partialSuccessWarning: Boolean(exportResult.partialSuccessWarning),
    droppedRecords: exportResult.droppedRecords ?? 0,
    status: exportResult.status ?? 200,
    retryDelaysMs: exportResult.retryDelaysMs ?? [],
    replayedPending: Boolean(batchMeta.replayedPending),
    discontinuity: Boolean(batchMeta.discontinuity),
    hasMore: Boolean(batchMeta.hasMore),
    cursor: state.cursor,
    source: state.source,
    coverage: state.coverage,
  };
}

export async function exportQueueTransitionsOnce(rawOptions) {
  const config = normalizeConfig(rawOptions);
  const checkpoint = readCheckpoint(config);

  if (checkpoint.pending !== null) {
    const pending = checkpoint.pending;
    if (pending.blocked) {
      if (pending.blocked.code === "otlp_permanent_rejection" && config.onPermanentError === "drop") {
        emitDiagnostic(config, {
          type: "otlp_permanent_rejection_dropped",
          status: pending.blocked.status,
          droppedRecords: pending.recordCount,
        });
        const droppedState = {
          ...checkpoint,
          cursor: pending.nextCursor,
          source: pending.source,
          coverage: pending.coverage,
          pending: null,
        };
        writeCheckpointAtomically(config.checkpointPath, droppedState);
        return makeStepResult(
          droppedState,
          { ...pending, replayedPending: true },
          { outcome: "dropped_permanent_rejection", status: pending.blocked.status, droppedRecords: pending.recordCount, retryDelaysMs: [] },
        );
      }
      throw new TelemetryExportError(
        pending.blocked.code,
        `Pending batch is blocked by prior non-retryable ${pending.blocked.code} and will not be automatically resubmitted`,
        { status: pending.blocked.status, disposition: "stopped", attempts: 0, retryDelaysMs: [] },
      );
    }

    const replayPayload = markPayloadReplayed(pending.payload);
    let exportResult;
    try {
      exportResult = await sendOtlpBatch(config, replayPayload, pending.recordCount);
    } catch (err) {
      if (err?.nonRetryableBlock) {
        writeCheckpointAtomically(config.checkpointPath, {
          ...checkpoint,
          pending: { ...pending, blocked: err.nonRetryableBlock },
        });
      }
      throw err;
    }
    const nextState = {
      ...checkpoint,
      cursor: pending.nextCursor,
      source: pending.source,
      coverage: pending.coverage,
      pending: null,
    };
    writeCheckpointAtomically(config.checkpointPath, nextState);
    return makeStepResult(nextState, { ...pending, replayedPending: true }, exportResult);
  }

  const envelope = await fetchSourcePage(config, checkpoint.cursor);
  const built = buildQueueTransitionLogsPayload(envelope, config, { replayed: false });

  if (built.recordCount === 0) {
    const nextState = {
      ...checkpoint,
      cursor: built.nextCursor,
      source: built.source,
      coverage: built.coverage,
      pending: null,
    };
    writeCheckpointAtomically(config.checkpointPath, nextState);
    return makeStepResult(nextState, { recordCount: 0, replayedPending: false, discontinuity: false, hasMore: built.hasMore });
  }

  const pendingBatch = {
    recordCount: built.recordCount,
    nextCursor: built.nextCursor,
    discontinuity: built.isDiscontinuity,
    hasMore: built.hasMore,
    source: built.source,
    coverage: built.coverage,
    blocked: null,
    payload: built.payload,
  };
  writeCheckpointAtomically(config.checkpointPath, { ...checkpoint, pending: pendingBatch });

  let exportResult;
  try {
    exportResult = await sendOtlpBatch(config, built.payload, built.recordCount);
  } catch (err) {
    if (err?.nonRetryableBlock) {
      writeCheckpointAtomically(config.checkpointPath, {
        ...checkpoint,
        pending: { ...pendingBatch, blocked: err.nonRetryableBlock },
      });
    }
    throw err;
  }

  const resolvedState = {
    ...checkpoint,
    cursor: built.nextCursor,
    source: built.source,
    coverage: built.coverage,
    pending: null,
  };
  writeCheckpointAtomically(config.checkpointPath, resolvedState);
  return makeStepResult(resolvedState, { ...pendingBatch, replayedPending: false }, exportResult);
}

export async function runQueueTransitionsExporter(rawOptions) {
  const config = normalizeConfig(rawOptions);
  if (config.once) return exportQueueTransitionsOnce(config);
  const signal = rawOptions?.signal;
  let lastResult = null;
  while (!signal?.aborted) {
    lastResult = await exportQueueTransitionsOnce(config);
    if (signal?.aborted) break;
    if (!lastResult.hasMore) await sleep(config.pollMs, signal);
  }
  return lastResult;
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const config = parseExporterArgs(argv);
    if (config.help) {
      process.stdout.write(`${config.usage}\n`);
      return 0;
    }
    await runQueueTransitionsExporter({
      ...config,
      signal: controller.signal,
      onDiagnostic: (diag) => process.stderr.write(`${JSON.stringify(diag)}\n`),
    });
    return 0;
  } catch (err) {
    const code = err?.code ?? "exporter_error";
    const status = typeof err?.status === "number" ? ` (status ${err.status})` : "";
    process.stderr.write(`[telemetry-otlp] ${code}${status}: ${err?.message ?? "Exporter failed"}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
