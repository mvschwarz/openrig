#!/usr/bin/env node
// Optional reference OTLP/HTTP JSON telemetry exporter for OpenRig (logs, metrics, and traces).
// Reads one bounded page at a time from /api/telemetry/v1/queue-transitions alongside cached
// rig/node inventory (/api/rigs, /api/rigs?archived=only, /api/rigs/:rigId/nodes), persists a
// pending transaction and proposed derived state atomically before export, and adopts the next
// cursor, queue intervals, seat baselines, and failure ledger only after all active signals resolve.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TELEMETRY_OTLP_LIMITS = Object.freeze({
  maxLimit: 128,
  // 128 transition rows + 32 gap rows + 1 truncation summary (161 source records), up to 256 observed
  // seat tenure-change records, and up to 31 exporter records (3 interval notes, 1 ledger-overflow summary,
  // and up to 27 drained failure-ledger records) = 448 log records maximum per batch.
  maxRecordsPerBatch: 448,
  // Up to 256 active seats x 10 points (2560) + up to 256 departed/replaced or runtime-changed stale seat
  // series x 10 points (2560) = 5120 seat gauge points, plus up to 122 cumulative queue metric points.
  maxMetricsPerBatch: 5376,
  maxSpansPerBatch: 128,
  maxOpenIntervals: 512,
  maxRigs: 32,
  maxSeatsPerRig: 64,
  maxKnownSeats: 256,
  seatIdBytes: 128,
  maxLedgerEntries: 32,
  ledgerDrainPerPage: 27,
  sourceResponseBytes: 128 * 1024,
  inventoryResponseBytes: 512 * 1024,
  otlpResponseBytes: 64 * 1024,
  // Worst case: 448 log records + 5242 metric points (with 128-byte unpseudonymized seat IDs) + 128 spans of
  // pending payload, the derived next state (512 open intervals + 256 known seats + counters) and live state inside 4 MiB.
  checkpointBytes: 4 * 1024 * 1024,
  exportBatchBytes: 2 * 1024 * 1024,
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
  minSeatPollMs: 10,
  maxSeatPollMs: 600_000,
  defaultSeatPollMs: 30_000,
});

export const TELEMETRY_OTLP_ALLOWLISTS = Object.freeze({
  stream: "queue-transitions",
  signals: Object.freeze(["logs", "metrics", "traces"]),
  scopeName: "openrig.telemetry.queue_transitions",
  scopeNames: Object.freeze({
    logs: "openrig.telemetry.queue_transitions",
    metrics: "openrig.telemetry.metrics",
    traces: "openrig.telemetry.traces",
  }),
  rejectedCountFields: Object.freeze({
    logs: "rejectedLogRecords",
    metrics: "rejectedDataPoints",
    traces: "rejectedSpans",
  }),
  signalOutcomes: Object.freeze(["exported", "partial_success", "dropped_permanent_rejection"]),
  recordBodies: Object.freeze([
    "openrig.queue.transition",
    "openrig.telemetry.gap",
    "openrig.telemetry.failure",
    "openrig.seat.tenure_change.observed",
  ]),
  seatActivityStates: Object.freeze(["working", "idle", "needs-input", "unknown"]),
  seatPresenceStates: Object.freeze(["running", "exited", "stopped", "detached", "unknown"]),
  runtimes: Object.freeze(["claude-code", "codex", "pi", "omp", "terminal", "stub"]),
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

/** Queue states whose recorded interval is tracked; other states close an interval but never open one. */
export const QUEUE_INTERVAL_STATES = Object.freeze(["pending", "in-progress", "blocked"]);
/** Fixed duration histogram bounds in seconds (upper-inclusive); eleven buckets including overflow. */
export const HISTOGRAM_BOUNDS = Object.freeze([1, 5, 15, 60, 300, 900, 3600, 14400, 86400, 604800]);
/** Gap codes the exporter itself raises about its derived interval state (source codes stay in the allowlist above). */
export const EXPORTER_GAP_CODES = Object.freeze(["page_intervals_suppressed", "open_interval_evicted", "invalid_interval_boundary"]);
/** Closed stage/category vocabulary for failure diagnostics: never raw error text, bodies or messages. */
export const FAILURE_CATEGORIES = Object.freeze({
  source: Object.freeze([
    "source_request_failed",
    "source_response_too_large",
    "source_http_error",
    "source_invalid_content_type",
    "source_invalid_json",
    "invalid_source_envelope",
    "invalid_transition_row",
    "invalid_gap_record",
    "invalid_inventory_response",
    "inventory_limit_exceeded",
    "configured_rig_not_found",
    "source_other",
  ]),
  export: Object.freeze(["otlp_retry_exhausted", "otlp_permanent_rejection", "otlp_unexpected_status", "otlp_invalid_content_type", "otlp_invalid_response", "otlp_response_too_large", "otlp_partial_success", "otlp_dropped_permanent_rejection", "export_batch_exceeds_byte_limit", "export_other"]),
  ledger: Object.freeze(["diagnostic_ledger_overflow"]),
});
const ROW_LOCAL_GAP_CODES = new Set(["oversized_field", "invalid_type", "invalid_timestamp"]);

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
  "  --signals <list>                comma list of logs,metrics,traces to export (default: logs,metrics,traces; bound into checkpoint)",
  "  --rig <rigId>                   repeatable immutable rigId scope bound to checkpoint (default: all active rigs)",
  "  --pseudonymize-seats            HMAC-pseudonymize seat node_id and tenure generation identifiers (bound into checkpoint)",
  "  --start <latest|retained>       initial window mode when no checkpoint exists (default: latest)",
  "  --qitem <id>                    exact source qitemId filter bound to checkpoint",
  "  --include-qitem-id              opt in to exporting openrig.qitem.id attribute",
  "  --limit <1..128>                source rows scanned per page (default: 128)",
  "  --once                          run exactly one bounded page/seat-inventory/replay step and exit",
  "  --poll-ms <10..60000>           idle poll interval in continuous mode (default: 5000)",
  "  --seat-poll-ms <10..600000>     seat inventory sampling cadence in continuous mode (default: 30000)",
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
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32_RE = /^[0-9a-f]{32}$/i;
const HEX_16_RE = /^[0-9a-f]{16}$/i;
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

function isUuidV4(value) {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

function isTraceIdHex(value) {
  return typeof value === "string" && HEX_32_RE.test(value) && !/^0+$/.test(value);
}

function isSpanIdHex(value) {
  return typeof value === "string" && HEX_16_RE.test(value) && !/^0+$/.test(value);
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

export function deriveSourceOrigin(raw) {
  return new URL(normalizeSourceUrl(raw)).origin;
}

export function deriveSignalEndpoints(logsEndpointUrl) {
  const parsed = parseCleanHttpUrl(logsEndpointUrl, TelemetryExportError, "invalid_endpoint_url", "OTLP endpoint");
  if (!parsed.pathname.endsWith("/v1/logs")) {
    throw new TelemetryExportError("invalid_endpoint_url", "OTLP logs endpoint URL path must end with /v1/logs");
  }
  const basePath = parsed.pathname.slice(0, -"/v1/logs".length);
  const makeSibling = (suffix) => {
    const u = new URL(parsed.toString());
    u.pathname = `${basePath}${suffix}`;
    return u.toString();
  };
  return Object.freeze({
    logs: parsed.toString(),
    metrics: makeSibling("/v1/metrics"),
    traces: makeSibling("/v1/traces"),
  });
}

function normalizeEndpointUrl(raw) {
  return deriveSignalEndpoints(raw).logs;
}

function boundedInt(value, defaultValue, min, max, name) {
  if (value === undefined) return defaultValue;
  const num = typeof value === "number" ? value : (typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : NaN);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return num;
}

export function normalizeConfig(options) {
  if (!options || typeof options !== "object") throw new Error("Exporter options are required");
  const sourceUrl = normalizeSourceUrl(options.sourceUrl);
  const sourceOrigin = deriveSourceOrigin(sourceUrl);
  const endpoints = deriveSignalEndpoints(options.endpointUrl);
  const endpointUrl = endpoints.logs;
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
  const rawSignals = options.signals ?? TELEMETRY_OTLP_ALLOWLISTS.signals;
  if (!Array.isArray(rawSignals) || rawSignals.length === 0 || rawSignals.some(sig => !TELEMETRY_OTLP_ALLOWLISTS.signals.includes(sig))) {
    throw new Error("signals must be a non-empty list of logs, metrics, traces");
  }
  const signals = TELEMETRY_OTLP_ALLOWLISTS.signals.filter(sig => rawSignals.includes(sig));
  const rawRigs = options.rigs !== undefined
    ? options.rigs
    : (options.rig !== undefined ? (Array.isArray(options.rig) ? options.rig : [options.rig]) : null);
  let rigs = null;
  if (rawRigs !== null) {
    if (!Array.isArray(rawRigs) || rawRigs.length === 0 || rawRigs.length > TELEMETRY_OTLP_LIMITS.maxRigs || rawRigs.some(r => !isSafeToken(r, TELEMETRY_OTLP_LIMITS.filterBytes))) {
      throw new Error(`rigs filter must be 1..${TELEMETRY_OTLP_LIMITS.maxRigs} safe immutable rigId tokens`);
    }
    rigs = [...new Set(rawRigs)].sort();
  }
  const pseudonymizeSeats = Boolean(options.pseudonymizeSeats);
  const limit = boundedInt(options.limit, TELEMETRY_OTLP_LIMITS.maxLimit, 1, TELEMETRY_OTLP_LIMITS.maxLimit, "limit");
  const timeoutMs = boundedInt(options.timeoutMs, TELEMETRY_OTLP_LIMITS.defaultTimeoutMs, TELEMETRY_OTLP_LIMITS.minTimeoutMs, TELEMETRY_OTLP_LIMITS.maxTimeoutMs, "timeoutMs");
  const retryMs = boundedInt(options.retryMs, TELEMETRY_OTLP_LIMITS.defaultRetryMs, TELEMETRY_OTLP_LIMITS.minRetryMs, 10_000, "retryMs");
  const maxRetryMs = boundedInt(options.maxRetryMs, Math.max(retryMs, TELEMETRY_OTLP_LIMITS.defaultMaxRetryMs), Math.max(retryMs, 10), TELEMETRY_OTLP_LIMITS.maxRetryMsBound, "maxRetryMs");
  const maxRetries = boundedInt(options.maxRetries, TELEMETRY_OTLP_LIMITS.defaultMaxRetries, 0, TELEMETRY_OTLP_LIMITS.maxRetriesBound, "maxRetries");
  const pollMs = boundedInt(options.pollMs, TELEMETRY_OTLP_LIMITS.defaultPollMs, TELEMETRY_OTLP_LIMITS.minPollMs, TELEMETRY_OTLP_LIMITS.maxPollMs, "pollMs");
  const seatPollMs = boundedInt(options.seatPollMs, TELEMETRY_OTLP_LIMITS.defaultSeatPollMs, TELEMETRY_OTLP_LIMITS.minSeatPollMs, TELEMETRY_OTLP_LIMITS.maxSeatPollMs, "seatPollMs");
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
    signals,
    ...(rigs !== null ? { rigs } : {}),
    ...(pseudonymizeSeats ? { pseudonymizeSeats: true } : {}),
  };
  const configHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return {
    ...identity,
    rigs,
    pseudonymizeSeats,
    sourceOrigin,
    endpoints,
    checkpointPath,
    limit,
    timeoutMs,
    retryMs,
    maxRetryMs,
    maxRetries,
    pollMs,
    seatPollMs,
    sampleSeats: options.sampleSeats !== false,
    onPermanentError,
    once: Boolean(options.once),
    configHash,
    signal: options.signal ?? null,
    onDiagnostic: typeof options.onDiagnostic === "function" ? options.onDiagnostic : null,
  };
}

export function parseExporterArgs(argv) {
  if (Array.isArray(argv) && (argv.includes("--help") || argv.includes("-h"))) {
    return { help: true, usage: EXPORTER_USAGE };
  }
  const raw = { once: false, includeQitemId: false, pseudonymizeSeats: false };
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
    else if (arg === "--rig") {
      raw.rigs ??= [];
      raw.rigs.push(next());
    } else if (arg === "--pseudonymize-seats") raw.pseudonymizeSeats = true;
    else if (arg === "--signals") raw.signals = next().split(",");
    else if (arg === "--limit") raw.limit = next();
    else if (arg === "--timeout-ms") raw.timeoutMs = next();
    else if (arg === "--retry-ms") raw.retryMs = next();
    else if (arg === "--max-retry-ms") raw.maxRetryMs = next();
    else if (arg === "--max-retries") raw.maxRetries = next();
    else if (arg === "--poll-ms") raw.pollMs = next();
    else if (arg === "--seat-poll-ms") raw.seatPollMs = next();
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
  const logRecords = buildSourceLogRecords(envelope, config, Boolean(options.replayed), observedTimeUnixNano);
  if (Array.isArray(options.extraRecords)) logRecords.push(...options.extraRecords);
  return finalizeLogsPayload(logRecords, envelope, config, { isDiscontinuity, instanceId: options.instanceId ?? null });
}

/** Source transition rows and source-reported gaps as allowlisted OTLP log records (validates rows and gap codes). */
function buildSourceLogRecords(envelope, config, replayed, observedTimeUnixNano) {
  const logRecords = [];
  const bootAttr = kvString("openrig.source.boot_epoch", envelope.source.bootEpoch);

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
      bootAttr,
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
      bootAttr,
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
        bootAttr,
        kvBool("openrig.delivery.replayed", replayed),
      ],
    });
  }
  return logRecords;
}

/**
 * Stable resource identity shared by every signal: service, namespace, persisted exporter instance and safe host id.
 * The daemon boot epoch is deliberately absent: an ordinary daemon restart must not split metric series.
 */
export function buildSignalResource(config, instanceId, hostId = null) {
  return {
    attributes: [
      kvString("service.name", "openrig-telemetry-exporter"),
      kvString("service.namespace", config.namespace),
      kvString("openrig.source.namespace", config.namespace),
      ...(instanceId ? [kvString("service.instance.id", instanceId)] : []),
      ...(isSafeToken(hostId, 256) ? [kvString("openrig.source.host_id", hostId)] : []),
    ],
  };
}

function finalizeLogsPayload(logRecords, envelope, config, { isDiscontinuity, instanceId }) {
  const safeHostId = isSafeToken(envelope.source.hostId, 256) ? envelope.source.hostId : null;

  const payload = {
    resourceLogs: logRecords.length === 0 ? [] : [
      {
        resource: buildSignalResource(config, instanceId, safeHostId),
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

// ---------------------------------------------------------------------------------------------
// Queue observation state: bounded open intervals, cumulative aggregates, durable failure ledger.
// Everything here is pure or checkpoint-shaped so a pending transaction can carry the proposed next
// state and adopt it only after every signal resolved.
// ---------------------------------------------------------------------------------------------

/** Keyed, non-reversible handle for a queue item: raw queue ids are never written to the checkpoint. */
export function pseudonymize(salt, domain, value) {
  return createHmac("sha256", Buffer.from(salt, "hex")).update(`${domain}\0${value}`).digest("hex").slice(0, 32);
}

export function emptyQueueState() {
  return { open: {}, agg: { transitions: {}, hist: {}, gaps: {}, failures: {}, lastNano: "0" } };
}

export function emptySeatsState() {
  return { known: {}, lastNano: "0" };
}

export function emptyLedger() {
  return { entries: [], dropped: 0, nextSeq: 1 };
}

function cloneQueueState(queue) {
  return JSON.parse(JSON.stringify(queue));
}

function cloneSeatsState(seats) {
  return JSON.parse(JSON.stringify(seats));
}

const aggSignature = (agg) => JSON.stringify([agg.transitions, agg.hist, agg.gaps, agg.failures]);
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] ?? 0) + n; };
const nowNano = () => (BigInt(Date.now()) * 1_000_000n).toString();
const maxNano = (...values) => values.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a)).toString();

function randomHexId(bytes) {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(hex)) return hex;
  }
}

function isSafeCount(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function validateQueueState(queue) {
  const bad = () => new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint queue observation state is malformed");
  const exactKeys = (obj, keys) => obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).sort().join() === [...keys].sort().join();
  if (!exactKeys(queue, ["open", "agg"]) || !exactKeys(queue.agg, ["transitions", "hist", "gaps", "failures", "lastNano"])) throw bad();
  const openKeys = Object.keys(queue.open);
  if (!queue.open || typeof queue.open !== "object" || openKeys.length > TELEMETRY_OTLP_LIMITS.maxOpenIntervals) throw bad();
  for (const key of openKeys) {
    const entry = queue.open[key];
    if (!/^[0-9a-f]{32}$/.test(key) || !exactKeys(entry, ["s", "t", "id"]) || !QUEUE_INTERVAL_STATES.includes(entry.s) || !isDecimalId(entry.t, false) || !isDecimalId(entry.id, false)) throw bad();
  }
  const { transitions, hist, gaps, failures, lastNano } = queue.agg;
  const states = TELEMETRY_OTLP_ALLOWLISTS.states;
  const closures = [...TELEMETRY_OTLP_ALLOWLISTS.closureReasons, "-"];
  for (const [key, count] of Object.entries(transitions)) {
    const [state, closure, extra] = key.split("|");
    if (extra !== undefined || !states.includes(state) || !closures.includes(closure) || !isSafeCount(count, 1)) throw bad();
  }
  for (const [key, h] of Object.entries(hist)) {
    const [state, departure, extra] = key.split("|");
    if (extra !== undefined || !QUEUE_INTERVAL_STATES.includes(state) || !states.includes(departure) || departure === state) throw bad();
    if (!exactKeys(h, ["n", "sum", "b"]) || !isSafeCount(h.n, 1) || typeof h.sum !== "number" || !Number.isFinite(h.sum) || h.sum < 0) throw bad();
    if (!Array.isArray(h.b) || h.b.length !== HISTOGRAM_BOUNDS.length + 1 || !h.b.every(c => isSafeCount(c)) || h.b.reduce((a, c) => a + c, 0) !== h.n) throw bad();
  }
  const gapCodes = new Set([...TELEMETRY_OTLP_ALLOWLISTS.gapCodes, ...EXPORTER_GAP_CODES]);
  for (const [code, count] of Object.entries(gaps)) if (!gapCodes.has(code) || !isSafeCount(count, 1)) throw bad();
  for (const [key, count] of Object.entries(failures)) {
    const [stage, category, extra] = key.split("|");
    if (extra !== undefined || !FAILURE_CATEGORIES[stage]?.includes(category) || !isSafeCount(count, 1)) throw bad();
  }
  if (!isDecimalId(lastNano, true)) throw bad();
}

function validateLedger(ledger) {
  const bad = () => new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint failure ledger is malformed");
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.entries) || ledger.entries.length > TELEMETRY_OTLP_LIMITS.maxLedgerEntries) throw bad();
  if (!isSafeCount(ledger.dropped) || !isSafeCount(ledger.nextSeq, 1)) throw bad();
  let previous = 0;
  for (const e of ledger.entries) {
    if (!e || typeof e !== "object" || !isSafeCount(e.seq, previous + 1) || e.seq >= ledger.nextSeq) throw bad();
    if (!FAILURE_CATEGORIES[e.stage]?.includes(e.category) || e.stage === "ledger") throw bad();
    if (e.signal !== null && !TELEMETRY_OTLP_ALLOWLISTS.signals.includes(e.signal)) throw bad();
    if (!isDecimalId(e.atNano, false) || !isSafeCount(e.items) || e.items > 1_000_000_000) throw bad();
    previous = e.seq;
  }
}

function validateSeatsState(seats) {
  const bad = () => new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint seat observation state is malformed");
  const exactKeys = (obj, keys) => obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).sort().join() === [...keys].sort().join();
  if (!exactKeys(seats, ["known", "lastNano"]) || !isDecimalId(seats.lastNano, true)) throw bad();
  if (!seats.known || typeof seats.known !== "object" || Array.isArray(seats.known)) throw bad();
  const keys = Object.keys(seats.known);
  if (keys.length > TELEMETRY_OTLP_LIMITS.maxKnownSeats) throw bad();
  for (const key of keys) {
    const e = seats.known[key];
    if (!/^[0-9a-f]{32}$/.test(key) || !exactKeys(e, ["id", "rig", "rt", "gen", "ni"])) throw bad();
    if (!isSafeToken(e.id, TELEMETRY_OTLP_LIMITS.seatIdBytes) || !/^[0-9a-f]{32}$/.test(e.rig)) throw bad();
    if (e.rt !== null && !TELEMETRY_OTLP_ALLOWLISTS.runtimes.includes(e.rt)) throw bad();
    if (e.gen !== null && !isSafeToken(e.gen, TELEMETRY_OTLP_LIMITS.filterBytes)) throw bad();
    if (typeof e.ni !== "boolean") throw bad();
  }
}

function validateDerived(derived) {
  if (derived === null) return;
  const bad = () => new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint pending derived state is malformed");
  if (!derived || typeof derived !== "object" || !isSafeCount(derived.ledgerThrough) || !isSafeCount(derived.ledgerDroppedThrough)) throw bad();
  validateQueueState(derived.queue);
  if (derived.seats !== undefined) validateSeatsState(derived.seats);
}

/** Append one allowlisted failure to the durable ledger (bounded; overflow is counted, never silent). */
export function withLedgerFailure(state, { stage, category, signal = null, items = 0 }) {
  const known = FAILURE_CATEGORIES[stage]?.includes(category) ? category : `${stage}_other`;
  const ledger = { ...state.ledger, entries: [...state.ledger.entries] };
  if (ledger.entries.length >= TELEMETRY_OTLP_LIMITS.maxLedgerEntries) {
    ledger.dropped += 1;
  } else {
    ledger.entries.push({ seq: ledger.nextSeq, stage, category: known, signal, atNano: nowNano(), items: Math.min(items, 1_000_000_000) });
    ledger.nextSeq += 1;
  }
  return { ...state, ledger };
}

/** Failures observed while a transaction was pending stay for the next one; only what that transaction reported is removed. */
function consumeLedger(ledger, derived) {
  return {
    entries: ledger.entries.filter(e => e.seq > derived.ledgerThrough),
    dropped: Math.max(0, ledger.dropped - derived.ledgerDroppedThrough),
    nextSeq: ledger.nextSeq,
  };
}

function exportFailureCategory(err) {
  return typeof err?.code === "string" && err.code !== "exporter_aborted" ? err.code : null;
}

function persistSourceFailure(config, checkpoint, err) {
  let stage = null;
  if (err instanceof TelemetrySourceError) stage = "source";
  else if (err instanceof TelemetryExportError && exportFailureCategory(err)) stage = "export";
  if (stage === null) return;
  try {
    writeCheckpointAtomically(config.checkpointPath, withLedgerFailure(checkpoint, { stage, category: err.code }));
  } catch {
    // The original failure is the one the caller must see; a failed ledger write is not allowed to mask it.
  }
}

/**
 * Advance bounded open intervals and cumulative aggregates over one validated source page.
 * Known gaps, unkeyable rows or non-monotonic IDs suppress the WHOLE page: the open map is cleared and the
 * page neither completes nor opens an interval, so no duration can span rows the source did not return.
 */
export function advanceQueueState(prev, envelope, { salt, includeQitemId = false }) {
  const queue = cloneQueueState(prev);
  const { open, agg } = queue;
  const rows = envelope.rows;
  const spans = [];
  const notes = { suppressed: false, evicted: 0, invalid: 0 };
  for (const gap of envelope.coverage.gaps) bump(agg.gaps, gap.code);
  if (envelope.coverage.gapDetailsTruncated) bump(agg.gaps, "gap_details_truncated");
  for (const row of rows) {
    if (TELEMETRY_OTLP_ALLOWLISTS.states.includes(row.state)) {
      bump(agg.transitions, `${row.state}|${TELEMETRY_OTLP_ALLOWLISTS.closureReasons.includes(row.closureReason) ? row.closureReason : "-"}`);
    }
  }
  let ordered = true;
  let lastId = 0n;
  for (const row of rows) {
    const id = BigInt(row.transitionId);
    if (id <= lastId) ordered = false;
    lastId = id;
  }
  const suppress = envelope.page.restartCursor !== null
    || envelope.coverage.status === "unavailable"
    || envelope.coverage.gapDetailsTruncated
    || envelope.coverage.gaps.some(gap => !ROW_LOCAL_GAP_CODES.has(gap.code))
    || !ordered
    || rows.some(row => !isSafeQitemId(row.qitemId));
  if (suppress) {
    if (rows.length > 0 || Object.keys(open).length > 0) {
      notes.suppressed = true;
      bump(agg.gaps, "page_intervals_suppressed");
    }
    for (const key of Object.keys(open)) delete open[key];
    return { queue, spans, notes };
  }
  for (const row of rows) {
    const key = pseudonymize(salt, "qitem", row.qitemId);
    const state = TELEMETRY_OTLP_ALLOWLISTS.states.includes(row.state) ? row.state : null;
    const tNano = typeof row.createdAt === "string" ? isoToUnixNano(row.createdAt) : null;
    const entry = open[key];
    if (state === null || tNano === null || !isDecimalId(tNano, false)) {
      if (entry) {
        delete open[key];
        notes.invalid += 1;
      }
      continue;
    }
    if (entry) {
      if (entry.s === state) continue; // repeated state: the original entry (and its time) stands
      delete open[key];
      if (BigInt(tNano) < BigInt(entry.t)) {
        notes.invalid += 1;
      } else {
        const seconds = Number(BigInt(tNano) - BigInt(entry.t)) / 1e9;
        const histKey = `${entry.s}|${state}`;
        const h = (agg.hist[histKey] ??= { n: 0, sum: 0, b: Array(HISTOGRAM_BOUNDS.length + 1).fill(0) });
        const bucket = HISTOGRAM_BOUNDS.findIndex(bound => seconds <= bound);
        h.n += 1;
        h.sum += seconds;
        h.b[bucket === -1 ? HISTOGRAM_BOUNDS.length : bucket] += 1;
        spans.push({ startNano: entry.t, endNano: tNano, state: entry.s, departure: state, enterId: entry.id, departId: row.transitionId, qitemId: includeQitemId ? row.qitemId : null });
      }
    }
    if (QUEUE_INTERVAL_STATES.includes(state)) {
      const keys = Object.keys(open);
      if (keys.length >= TELEMETRY_OTLP_LIMITS.maxOpenIntervals) {
        const oldest = keys.reduce((a, b) => (BigInt(open[b].id) < BigInt(open[a].id) ? b : a));
        delete open[oldest];
        notes.evicted += 1;
      }
      open[key] = { s: state, t: tNano, id: row.transitionId };
    }
  }
  if (notes.invalid) bump(agg.gaps, "invalid_interval_boundary", notes.invalid);
  if (notes.evicted) bump(agg.gaps, "open_interval_evicted", notes.evicted);
  return { queue, spans, notes };
}

const BOUNDED_ATTR_ORDER = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const attrsFrom = (pairs) => pairs.map(([k, v]) => kvString(k, v));

/** Cumulative (temporality 2) OTLP metrics for the queue aggregates; null when no series has a value. */
export function buildQueueMetricsPayload(config, checkpoint, agg, observedNano, hostId = null) {
  const startTimeUnixNano = checkpoint.metricsStartUnixNano;
  const timeUnixNano = maxNano(observedNano, agg.lastNano, startTimeUnixNano);
  const stamp = { startTimeUnixNano, timeUnixNano };
  const metrics = [];
  const sumPoints = (entries, attrsOf) => entries.sort(BOUNDED_ATTR_ORDER).map(([key, count]) => ({ attributes: attrsOf(key), ...stamp, asInt: String(count) }));
  const transitions = sumPoints(Object.entries(agg.transitions), (key) => {
    const [state, closure] = key.split("|");
    return attrsFrom([["openrig.queue.state", state], ...(closure === "-" ? [] : [["openrig.queue.closure_reason", closure]])]);
  });
  if (transitions.length) metrics.push({ name: "openrig.queue.transition.observed", unit: "{transition}", description: "Queue transition records collected by this exporter (not lifetime or occurred-today totals)", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: transitions } });
  const hist = Object.entries(agg.hist).sort(BOUNDED_ATTR_ORDER).map(([key, h]) => {
    const [state, departure] = key.split("|");
    return { attributes: attrsFrom([["openrig.queue.departure_state", departure], ["openrig.queue.state", state]]), ...stamp, count: String(h.n), sum: h.sum, bucketCounts: h.b.map(String), explicitBounds: [...HISTOGRAM_BOUNDS] };
  });
  if (hist.length) metrics.push({ name: "openrig.queue.state.duration", unit: "s", description: "Recorded queue-state interval between two observed transition timestamps", histogram: { aggregationTemporality: 2, dataPoints: hist } });
  const gaps = sumPoints(Object.entries(agg.gaps), (code) => attrsFrom([["openrig.gap.code", code]]));
  if (gaps.length) metrics.push({ name: "openrig.telemetry.coverage.gap", unit: "{gap}", description: "Coverage-gap reports encountered", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: gaps } });
  const failures = sumPoints(Object.entries(agg.failures), (key) => {
    const [stage, category] = key.split("|");
    return attrsFrom([["openrig.failure.category", category], ["openrig.failure.stage", stage]]);
  });
  if (failures.length) metrics.push({ name: "openrig.telemetry.failure", unit: "{failure}", description: "Collection and export failures by bounded stage and category", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: failures } });
  const itemCount = transitions.length + hist.length + gaps.length + failures.length;
  if (itemCount === 0) return null;
  return {
    itemCount,
    timeUnixNano,
    payload: { resourceMetrics: [{ resource: buildSignalResource(config, checkpoint.instanceId, hostId), scopeMetrics: [{ scope: { name: TELEMETRY_OTLP_ALLOWLISTS.scopeNames.metrics, version: "1" }, metrics }] }] },
  };
}

/** Root INTERNAL spans for completed observed intervals; ids are generated once here and persisted for replay. */
export function buildQueueSpansPayload(config, checkpoint, spans, hostId = null) {
  if (spans.length === 0) return null;
  const built = spans.map((span) => ({
    traceId: randomHexId(16),
    spanId: randomHexId(8),
    name: "openrig.queue.state",
    kind: 1,
    startTimeUnixNano: span.startNano,
    endTimeUnixNano: span.endNano,
    attributes: [
      kvString("openrig.record.kind", "queue_state_interval"),
      kvString("openrig.queue.state", span.state),
      kvString("openrig.queue.departure_state", span.departure),
      kvString("openrig.transition.enter_id", span.enterId),
      kvString("openrig.transition.depart_id", span.departId),
      ...(config.includeQitemId && span.qitemId ? [kvString("openrig.qitem.id", span.qitemId)] : []),
    ],
  }));
  return {
    itemCount: built.length,
    payload: { resourceSpans: [{ resource: buildSignalResource(config, checkpoint.instanceId, hostId), scopeSpans: [{ scope: { name: TELEMETRY_OTLP_ALLOWLISTS.scopeNames.traces, version: "1" }, spans: built }] }] },
  };
}

function parseRigInventoryList(raw) {
  if (!Array.isArray(raw)) {
    throw new TelemetrySourceError("invalid_inventory_response", "Rig inventory response must be a JSON array");
  }
  if (raw.length > TELEMETRY_OTLP_LIMITS.maxRigs) {
    throw new TelemetrySourceError("inventory_limit_exceeded", `Rig inventory exceeds maximum bound of ${TELEMETRY_OTLP_LIMITS.maxRigs}`);
  }
  const ids = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || !isSafeToken(entry.id, TELEMETRY_OTLP_LIMITS.filterBytes)) {
      throw new TelemetrySourceError("invalid_inventory_response", "Rig inventory entry is missing a valid immutable id");
    }
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      ids.push(entry.id);
    }
  }
  return ids.sort();
}

export function buildSeatMetrics(activeSamples, staleSeries, observedNano, prevLastNano = "0") {
  const timeUnixNano = prevLastNano === "0"
    ? observedNano
    : maxNano(observedNano, (BigInt(prevLastNano) + 1n).toString());
  const bySeatOrder = (a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    const ra = a.rt ?? "";
    const rb = b.rt ?? "";
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  };
  const sortedActive = [...activeSamples].sort(bySeatOrder);
  const sortedStale = [...staleSeries].sort(bySeatOrder);

  const activityPoints = [];
  for (const s of sortedActive) {
    for (const st of TELEMETRY_OTLP_ALLOWLISTS.seatActivityStates) {
      activityPoints.push({
        attributes: [
          kvString("openrig.seat.node_id", s.id),
          kvString("openrig.seat.state", st),
          ...(s.rt ? [kvString("openrig.seat.runtime", s.rt)] : []),
        ],
        timeUnixNano,
        asInt: st === s.activity ? "1" : "0",
      });
    }
  }
  for (const stSeries of sortedStale) {
    if (!stSeries.activity) continue;
    for (const st of TELEMETRY_OTLP_ALLOWLISTS.seatActivityStates) {
      activityPoints.push({
        attributes: [
          kvString("openrig.seat.node_id", stSeries.id),
          kvString("openrig.seat.state", st),
          ...(stSeries.rt ? [kvString("openrig.seat.runtime", stSeries.rt)] : []),
        ],
        timeUnixNano,
        flags: 1,
      });
    }
  }

  const presencePoints = [];
  for (const s of sortedActive) {
    for (const st of TELEMETRY_OTLP_ALLOWLISTS.seatPresenceStates) {
      presencePoints.push({
        attributes: [
          kvString("openrig.seat.node_id", s.id),
          kvString("openrig.seat.status", st),
          ...(s.rt ? [kvString("openrig.seat.runtime", s.rt)] : []),
        ],
        timeUnixNano,
        asInt: st === s.presence ? "1" : "0",
      });
    }
  }
  for (const stSeries of sortedStale) {
    if (!stSeries.presence) continue;
    for (const st of TELEMETRY_OTLP_ALLOWLISTS.seatPresenceStates) {
      presencePoints.push({
        attributes: [
          kvString("openrig.seat.node_id", stSeries.id),
          kvString("openrig.seat.status", st),
          ...(stSeries.rt ? [kvString("openrig.seat.runtime", stSeries.rt)] : []),
        ],
        timeUnixNano,
        flags: 1,
      });
    }
  }

  const needsInputPoints = [];
  for (const s of sortedActive) {
    if (s.needsInputCount === null) continue;
    needsInputPoints.push({
      attributes: [
        kvString("openrig.seat.node_id", s.id),
        ...(s.rt ? [kvString("openrig.seat.runtime", s.rt)] : []),
      ],
      timeUnixNano,
      asInt: String(s.needsInputCount),
    });
  }
  for (const stSeries of sortedStale) {
    if (!stSeries.needsInput) continue;
    needsInputPoints.push({
      attributes: [
        kvString("openrig.seat.node_id", stSeries.id),
        ...(stSeries.rt ? [kvString("openrig.seat.runtime", stSeries.rt)] : []),
      ],
      timeUnixNano,
      flags: 1,
    });
  }

  const metrics = [];
  if (activityPoints.length > 0) {
    metrics.push({
      name: "openrig.seat.activity",
      unit: "{seat}",
      description: "Sampled seat activity state from cached server-derived display",
      gauge: { dataPoints: activityPoints },
    });
  }
  if (presencePoints.length > 0) {
    metrics.push({
      name: "openrig.seat.presence",
      unit: "{seat}",
      description: "Sampled projected inventory session status (not independent process execution proof)",
      gauge: { dataPoints: presencePoints },
    });
  }
  if (needsInputPoints.length > 0) {
    metrics.push({
      name: "openrig.seat.needs_input",
      unit: "{request}",
      description: "Observed seat needs-input count when backed by authoritative evidence",
      gauge: { dataPoints: needsInputPoints },
    });
  }
  const itemCount = activityPoints.length + presencePoints.length + needsInputPoints.length;
  if (itemCount === 0) return null;
  return { itemCount, timeUnixNano, metrics };
}

export async function sampleSeatInventory(config, checkpoint, observedTimeUnixNano, bootEpoch) {
  const salt = checkpoint.hmacSalt;
  const prevSeats = checkpoint.seats ?? emptySeatsState();
  const nextSeats = cloneSeatsState(prevSeats);
  const origin = config.sourceOrigin;

  const activeRigIds = parseRigInventoryList(await fetchSourceJson(`${origin}/api/rigs`, config, TELEMETRY_OTLP_LIMITS.inventoryResponseBytes));
  const activeRigSet = new Set(activeRigIds);
  const activeRigKeySet = new Set(activeRigIds.map(id => pseudonymize(salt, "seat-rig", id)));

  const missingConfiguredRigs = (config.rigs ?? []).filter(id => !activeRigSet.has(id));
  const hasKnownSeatsInNonActiveRig = Object.values(prevSeats.known).some(e => !activeRigKeySet.has(e.rig));

  let archivedRigSet = new Set();
  let archivedRigKeySet = new Set();
  if (missingConfiguredRigs.length > 0 || hasKnownSeatsInNonActiveRig) {
    const archivedRigIds = parseRigInventoryList(await fetchSourceJson(`${origin}/api/rigs?archived=only`, config, TELEMETRY_OTLP_LIMITS.inventoryResponseBytes));
    archivedRigSet = new Set(archivedRigIds);
    archivedRigKeySet = new Set(archivedRigIds.map(id => pseudonymize(salt, "seat-rig", id)));
  }

  const hasMissingConfiguredRig = missingConfiguredRigs.some(rigId => !archivedRigSet.has(rigId));
  const hasUnverifiedMissingKnownRig = Object.values(prevSeats.known).some(
    e => !activeRigKeySet.has(e.rig) && !archivedRigKeySet.has(e.rig),
  );
  const failures = (hasMissingConfiguredRig || hasUnverifiedMissingKnownRig)
    ? ["configured_rig_not_found"]
    : [];

  const targetActiveRigs = config.rigs !== null ? config.rigs.filter(id => activeRigSet.has(id)) : activeRigIds;
  const activeSamples = [];
  const staleSeries = [];
  const tenureLogs = [];

  for (const [seatKey, prevEntry] of Object.entries(prevSeats.known)) {
    if (archivedRigKeySet.has(prevEntry.rig)) {
      staleSeries.push({ id: prevEntry.id, rt: prevEntry.rt, activity: true, presence: true, needsInput: prevEntry.ni });
      delete nextSeats.known[seatKey];
    }
  }

  for (const rigId of targetActiveRigs) {
    const rigKey = pseudonymize(salt, "seat-rig", rigId);
    const rawNodes = await fetchSourceJson(`${origin}/api/rigs/${encodeURIComponent(rigId)}/nodes`, config, TELEMETRY_OTLP_LIMITS.inventoryResponseBytes);
    if (!Array.isArray(rawNodes)) {
      throw new TelemetrySourceError("invalid_inventory_response", "Node inventory response must be a JSON array");
    }
    if (rawNodes.length > TELEMETRY_OTLP_LIMITS.maxSeatsPerRig) {
      throw new TelemetrySourceError("inventory_limit_exceeded", `Node inventory exceeds maximum per-rig bound of ${TELEMETRY_OTLP_LIMITS.maxSeatsPerRig}`);
    }
    const seenInRig = new Set();
    for (const node of rawNodes) {
      if (!node || typeof node !== "object" || !isSafeToken(node.nodeId, TELEMETRY_OTLP_LIMITS.seatIdBytes)) {
        throw new TelemetrySourceError("invalid_inventory_response", "Node inventory entry is missing a valid immutable nodeId");
      }
      if (node.rigId !== rigId) {
        throw new TelemetrySourceError("invalid_inventory_response", "Node inventory entry rigId does not match requested rig");
      }
      const seatKey = pseudonymize(salt, "seat-key", node.nodeId);
      if (seenInRig.has(seatKey)) {
        throw new TelemetrySourceError("invalid_inventory_response", "Duplicate nodeId in node inventory snapshot");
      }
      seenInRig.add(seatKey);

      const exportedNodeId = config.pseudonymizeSeats ? pseudonymize(salt, "seat-node", node.nodeId) : node.nodeId;
      const runtime = typeof node.runtime === "string" && TELEMETRY_OTLP_ALLOWLISTS.runtimes.includes(node.runtime) ? node.runtime : null;
      const presence = typeof node.sessionStatus === "string" && TELEMETRY_OTLP_ALLOWLISTS.seatPresenceStates.includes(node.sessionStatus)
        ? node.sessionStatus
        : "unknown";
      const rawDisplay = node.activityState?.display;
      let activity = typeof rawDisplay === "string" && TELEMETRY_OTLP_ALLOWLISTS.seatActivityStates.includes(rawDisplay)
        ? rawDisplay
        : "unknown";
      if (presence !== "running" && activity === "idle") {
        activity = "unknown";
      }

      const rawCount = node.activityState?.needsInput?.count;
      const validCount = Number.isSafeInteger(rawCount) && rawCount >= 0 && rawCount <= 1_000_000 ? rawCount : null;
      let needsInputCount = null;
      if (node.arbitratedNeedsInput === true && validCount !== null && validCount > 0) {
        needsInputCount = validCount;
      } else if (node.arbitratedNeedsInput === false && validCount === 0) {
        needsInputCount = 0;
      }

      const prevEntry = prevSeats.known[seatKey] ?? null;
      const lastSwap = node.activityState?.lastSwap ?? null;
      let nextGen = prevEntry?.gen ?? null;
      if (lastSwap !== null) {
        if (typeof lastSwap !== "object" || !isSafeToken(lastSwap.generation, TELEMETRY_OTLP_LIMITS.filterBytes)) {
          throw new TelemetrySourceError("invalid_inventory_response", "Node inventory lastSwap.generation is invalid");
        }
        const observedGen = config.pseudonymizeSeats ? pseudonymize(salt, "seat-gen", lastSwap.generation) : lastSwap.generation;
        if (prevEntry !== null && prevEntry.gen !== null && prevEntry.gen !== observedGen) {
          const eventTimeUnixNano = typeof lastSwap.at === "string" ? isoToUnixNano(lastSwap.at) : null;
          tenureLogs.push({
            ...(eventTimeUnixNano ? { timeUnixNano: eventTimeUnixNano } : {}),
            observedTimeUnixNano,
            severityNumber: 9,
            severityText: "INFO",
            body: { stringValue: "openrig.seat.tenure_change.observed" },
            attributes: [
              kvString("openrig.record.kind", "seat_tenure_change"),
              kvString("openrig.stream", TELEMETRY_OTLP_ALLOWLISTS.stream),
              kvString("openrig.seat.node_id", exportedNodeId),
              ...(runtime ? [kvString("openrig.seat.runtime", runtime)] : []),
              kvString("openrig.tenure.prior_generation", prevEntry.gen),
              kvString("openrig.tenure.new_generation", observedGen),
              kvString("openrig.tenure.continuity", "intermediate_changes_unknown"),
              kvBool("openrig.tenure.intermediate_changes_unknown", true),
              kvString("openrig.source.boot_epoch", bootEpoch),
              kvBool("openrig.delivery.replayed", false),
            ],
          });
        }
        nextGen = observedGen;
      }

      if (prevEntry && prevEntry.rt !== runtime) {
        staleSeries.push({ id: prevEntry.id, rt: prevEntry.rt, activity: true, presence: true, needsInput: prevEntry.ni });
      } else if (prevEntry && prevEntry.ni && needsInputCount === null) {
        staleSeries.push({ id: exportedNodeId, rt: runtime, activity: false, presence: false, needsInput: true });
      }

      activeSamples.push({ id: exportedNodeId, rt: runtime, activity, presence, needsInputCount });
      nextSeats.known[seatKey] = {
        id: exportedNodeId,
        rig: rigKey,
        rt: runtime,
        gen: nextGen,
        ni: needsInputCount !== null,
      };
    }

    for (const [seatKey, prevEntry] of Object.entries(prevSeats.known)) {
      if (prevEntry.rig === rigKey && !seenInRig.has(seatKey)) {
        staleSeries.push({ id: prevEntry.id, rt: prevEntry.rt, activity: true, presence: true, needsInput: prevEntry.ni });
        delete nextSeats.known[seatKey];
      }
    }
  }

  if (Object.keys(nextSeats.known).length > TELEMETRY_OTLP_LIMITS.maxKnownSeats) {
    throw new TelemetrySourceError("inventory_limit_exceeded", `Known seats exceed maximum bound of ${TELEMETRY_OTLP_LIMITS.maxKnownSeats}`);
  }

  const seatMetrics = config.signals.includes("metrics")
    ? buildSeatMetrics(activeSamples, staleSeries, observedTimeUnixNano, prevSeats.lastNano)
    : null;
  if (seatMetrics) {
    nextSeats.lastNano = seatMetrics.timeUnixNano;
  }

  return {
    seats: nextSeats,
    seatMetrics,
    tenureLogs: config.signals.includes("logs") ? tenureLogs : [],
    failures,
  };
}

function exporterLogRecords({ notes, drained, observedTimeUnixNano, bootEpoch }) {
  const common = (kind) => [kvString("openrig.record.kind", kind), kvString("openrig.stream", TELEMETRY_OTLP_ALLOWLISTS.stream)];
  const tail = [kvString("openrig.source.boot_epoch", bootEpoch), kvBool("openrig.delivery.replayed", false)];
  const records = [];
  const note = (code, count) => records.push({
    observedTimeUnixNano, severityNumber: 13, severityText: "WARN", body: { stringValue: "openrig.telemetry.gap" },
    attributes: [...common("coverage_gap"), kvString("openrig.gap.code", code), kvInt("openrig.gap.count", count), ...tail],
  });
  if (notes.suppressed) note("page_intervals_suppressed", 1);
  if (notes.evicted) note("open_interval_evicted", notes.evicted);
  if (notes.invalid) note("invalid_interval_boundary", notes.invalid);
  const failure = (entry, stage, category, items, timeNano) => records.push({
    ...(timeNano ? { timeUnixNano: timeNano } : {}),
    observedTimeUnixNano, severityNumber: 17, severityText: "ERROR", body: { stringValue: "openrig.telemetry.failure" },
    attributes: [...common("failure"), kvString("openrig.failure.stage", stage), kvString("openrig.failure.category", category), ...(entry.signal ? [kvString("openrig.signal", entry.signal)] : []), kvInt("openrig.failure.items", items), ...tail],
  });
  if (drained.dropped > 0) failure({ signal: null }, "ledger", "diagnostic_ledger_overflow", drained.dropped, null);
  for (const entry of drained.entries) failure(entry, entry.stage, entry.category, entry.items, entry.atNano);
  return records;
}

/** One page becomes one transaction: source-derived records, proposed next state and per-signal payloads. */
function buildQueueTransaction(envelope, config, checkpoint, seatSample = null) {
  const { observedTimeUnixNano, isDiscontinuity } = validateSourceEnvelope(envelope);
  const sourceRecords = buildSourceLogRecords(envelope, config, false, observedTimeUnixNano);
  const observe = config.signals.includes("metrics") || config.signals.includes("traces");
  const advanced = observe
    ? advanceQueueState(checkpoint.queue, envelope, { salt: checkpoint.hmacSalt, includeQitemId: config.includeQitemId })
    : { queue: cloneQueueState(checkpoint.queue), spans: [], notes: { suppressed: false, evicted: 0, invalid: 0 } };
  const tenureLogs = seatSample?.tenureLogs ?? [];
  const canExportFailures = config.signals.includes("logs") || config.signals.includes("metrics");
  const maxDrain = canExportFailures
    ? Math.max(0, Math.min(TELEMETRY_OTLP_LIMITS.ledgerDrainPerPage, TELEMETRY_OTLP_LIMITS.maxRecordsPerBatch - sourceRecords.length - tenureLogs.length - 4))
    : 0;
  const drainable = canExportFailures ? checkpoint.ledger.entries.slice(0, maxDrain) : [];
  const drained = canExportFailures
    ? { entries: drainable, dropped: checkpoint.ledger.dropped, through: drainable.length ? drainable.at(-1).seq : 0 }
    : { entries: [], dropped: 0, through: 0 };
  if (config.signals.includes("metrics")) {
    for (const entry of drainable) bump(advanced.queue.agg.failures, `${entry.stage}|${entry.category}`);
    if (drained.dropped > 0) bump(advanced.queue.agg.failures, "ledger|diagnostic_ledger_overflow", drained.dropped);
  }
  const bootEpoch = envelope.source.bootEpoch;
  const safeHostId = isSafeToken(envelope.source.hostId, 256) ? envelope.source.hostId : null;
  const records = [...sourceRecords, ...tenureLogs, ...exporterLogRecords({ notes: advanced.notes, drained, observedTimeUnixNano, bootEpoch })];
  const signals = { logs: null, metrics: null, traces: null };
  if (config.signals.includes("logs") && records.length > 0) {
    const finalized = finalizeLogsPayload(records, envelope, config, { isDiscontinuity, instanceId: checkpoint.instanceId });
    signals.logs = { itemCount: finalized.recordCount, payload: finalized.payload };
  }
  const seatMetrics = seatSample?.seatMetrics ?? null;
  const nextSeats = seatSample?.seats ?? cloneSeatsState(checkpoint.seats ?? emptySeatsState());
  if (config.signals.includes("metrics")) {
    const queueChanged = aggSignature(advanced.queue.agg) !== aggSignature(checkpoint.queue.agg);
    const wantQueueMetrics = queueChanged || seatMetrics !== null;
    const queueMetrics = wantQueueMetrics
      ? buildQueueMetricsPayload(config, checkpoint, advanced.queue.agg, observedTimeUnixNano, safeHostId)
      : null;
    if (queueMetrics) {
      advanced.queue.agg.lastNano = queueMetrics.timeUnixNano;
    }
    const combinedMetrics = [
      ...(queueMetrics ? queueMetrics.payload.resourceMetrics[0].scopeMetrics[0].metrics : []),
      ...(seatMetrics ? seatMetrics.metrics : []),
    ];
    const combinedItemCount = (queueMetrics?.itemCount ?? 0) + (seatMetrics?.itemCount ?? 0);
    if (combinedItemCount > 0) {
      if (combinedItemCount > TELEMETRY_OTLP_LIMITS.maxMetricsPerBatch) {
        throw new TelemetryExportError("export_batch_exceeds_byte_limit", "Constructed OTLP metrics batch exceeds maximum dataPoint bound");
      }
      const metricsPayload = {
        resourceMetrics: [
          {
            resource: buildSignalResource(config, checkpoint.instanceId, safeHostId),
            scopeMetrics: [
              {
                scope: { name: TELEMETRY_OTLP_ALLOWLISTS.scopeNames.metrics, version: "1" },
                metrics: combinedMetrics,
              },
            ],
          },
        ],
      };
      if (Buffer.byteLength(JSON.stringify(metricsPayload)) > TELEMETRY_OTLP_LIMITS.exportBatchBytes) {
        throw new TelemetryExportError("export_batch_exceeds_byte_limit", "Constructed OTLP metrics batch exceeds maximum export byte bound");
      }
      signals.metrics = { itemCount: combinedItemCount, payload: metricsPayload };
    }
  }
  if (config.signals.includes("traces")) {
    const traces = buildQueueSpansPayload(config, checkpoint, advanced.spans, safeHostId);
    if (traces) signals.traces = { itemCount: traces.itemCount, payload: traces.payload };
  }
  return {
    hasOutput: Object.values(signals).some(Boolean),
    input: {
      nextCursor: isDiscontinuity ? envelope.page.restartCursor : envelope.page.nextCursor,
      discontinuity: isDiscontinuity,
      hasMore: envelope.page.hasMore,
      source: { hostId: safeHostId, bootEpoch, sequenceSpaceId: null },
      coverage: { status: envelope.coverage.status, historyCompleteness: "unknown" },
      signals,
      derived: { queue: advanced.queue, seats: nextSeats, ledgerThrough: drained.through, ledgerDroppedThrough: drained.dropped },
    },
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

export function markSignalPayloadReplayed(signal, payload) {
  if (signal === "logs") return markPayloadReplayed(payload);
  return payload;
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

function validateSignalPayload(signal, itemCount, payload) {
  if (!payload || typeof payload !== "object") return false;
  if (Buffer.byteLength(JSON.stringify(payload)) > TELEMETRY_OTLP_LIMITS.exportBatchBytes) return false;
  if (signal === "logs") {
    if (
      !Number.isInteger(itemCount) ||
      itemCount < 1 ||
      itemCount > TELEMETRY_OTLP_LIMITS.maxRecordsPerBatch ||
      !Array.isArray(payload.resourceLogs) ||
      payload.resourceLogs.length !== 1
    ) {
      return false;
    }
    const rl = payload.resourceLogs[0];
    const sl = rl?.scopeLogs?.[0];
    if (
      !rl ||
      !Array.isArray(rl.scopeLogs) ||
      rl.scopeLogs.length !== 1 ||
      sl?.scope?.name !== TELEMETRY_OTLP_ALLOWLISTS.scopeNames.logs ||
      !Array.isArray(sl.logRecords) ||
      sl.logRecords.length !== itemCount
    ) {
      return false;
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
        return false;
      }
    }
    return true;
  }
  if (signal === "metrics") {
    if (
      !Number.isInteger(itemCount) ||
      itemCount < 1 ||
      itemCount > TELEMETRY_OTLP_LIMITS.maxMetricsPerBatch ||
      !Array.isArray(payload.resourceMetrics) ||
      payload.resourceMetrics.length !== 1
    ) {
      return false;
    }
    const rm = payload.resourceMetrics[0];
    const sm = rm?.scopeMetrics?.[0];
    if (
      !rm ||
      !Array.isArray(rm.scopeMetrics) ||
      rm.scopeMetrics.length !== 1 ||
      sm?.scope?.name !== TELEMETRY_OTLP_ALLOWLISTS.scopeNames.metrics ||
      !Array.isArray(sm.metrics) ||
      sm.metrics.length < 1
    ) {
      return false;
    }
    let totalPoints = 0;
    for (const m of sm.metrics) {
      if (!m || typeof m !== "object" || typeof m.name !== "string" || !m.name.startsWith("openrig.")) return false;
      const pts = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints;
      if (!Array.isArray(pts) || pts.length < 1) return false;
      totalPoints += pts.length;
    }
    return totalPoints === itemCount;
  }
  if (signal === "traces") {
    if (
      !Number.isInteger(itemCount) ||
      itemCount < 1 ||
      itemCount > TELEMETRY_OTLP_LIMITS.maxSpansPerBatch ||
      !Array.isArray(payload.resourceSpans) ||
      payload.resourceSpans.length !== 1
    ) {
      return false;
    }
    const rs = payload.resourceSpans[0];
    const ss = rs?.scopeSpans?.[0];
    if (
      !rs ||
      !Array.isArray(rs.scopeSpans) ||
      rs.scopeSpans.length !== 1 ||
      ss?.scope?.name !== TELEMETRY_OTLP_ALLOWLISTS.scopeNames.traces ||
      !Array.isArray(ss.spans) ||
      ss.spans.length !== itemCount
    ) {
      return false;
    }
    for (const sp of ss.spans) {
      if (
        !sp ||
        typeof sp !== "object" ||
        !isTraceIdHex(sp.traceId) ||
        !isSpanIdHex(sp.spanId) ||
        typeof sp.name !== "string" ||
        !sp.name.startsWith("openrig.") ||
        !isDecimalId(sp.startTimeUnixNano, false) ||
        !isDecimalId(sp.endTimeUnixNano, false) ||
        !Array.isArray(sp.attributes)
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function validateSignalPendingEntry(signal, entry) {
  if (entry === null) return true;
  if (!entry || typeof entry !== "object") return false;
  const { itemCount, attempted, outcome, rejectedCount, partialSuccessWarning, droppedCount, status, blocked, payload } = entry;
  if (typeof attempted !== "boolean") return false;
  if (!Number.isInteger(rejectedCount) || rejectedCount < 0 || rejectedCount > itemCount) return false;
  if (typeof partialSuccessWarning !== "boolean") return false;
  if (!Number.isInteger(droppedCount) || droppedCount < 0 || droppedCount > itemCount) return false;
  if (status !== null && (!Number.isInteger(status) || status < 100 || status >= 600)) return false;
  if (!isValidPendingBlocked(blocked)) return false;
  if (!validateSignalPayload(signal, itemCount, payload)) return false;
  if (outcome === null) {
    if (rejectedCount !== 0 || partialSuccessWarning !== false || droppedCount !== 0) return false;
    if (blocked !== null && !attempted) return false;
    return true;
  }
  if (!TELEMETRY_OTLP_ALLOWLISTS.signalOutcomes.includes(outcome)) return false;
  if (!attempted || blocked !== null) return false;
  if (outcome === "exported") {
    return rejectedCount === 0 && partialSuccessWarning === false && droppedCount === 0 && status === 200;
  }
  if (outcome === "partial_success") {
    return (rejectedCount > 0 || partialSuccessWarning === true) && droppedCount === 0 && status === 200;
  }
  if (outcome === "dropped_permanent_rejection") {
    return droppedCount === itemCount && rejectedCount === 0 && partialSuccessWarning === false && Number.isInteger(status) && status >= 400 && status < 600 && !RETRYABLE_OTLP_STATUSES.has(status);
  }
  return false;
}

function validateCheckpointPending(pending) {
  if (pending === null) return;
  if (
    !pending ||
    typeof pending !== "object" ||
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
    !Array.isArray(pending.diagnostics) ||
    pending.diagnostics.length > 64 ||
    pending.derived === undefined ||
    !pending.signals ||
    typeof pending.signals !== "object"
  ) {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint pending batch state is malformed");
  }
  validateDerived(pending.derived);
  let hasActiveSignal = false;
  for (const sig of TELEMETRY_OTLP_ALLOWLISTS.signals) {
    const entry = pending.signals[sig];
    if (entry === undefined || !validateSignalPendingEntry(sig, entry)) {
      throw new TelemetryCheckpointError("checkpoint_malformed", `Checkpoint pending ${sig} signal state is malformed`);
    }
    if (entry !== null) hasActiveSignal = true;
  }
  if (!hasActiveSignal) {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint pending transaction must contain at least one signal");
  }
}

export function readCheckpoint(config) {
  if (!existsSync(config.checkpointPath)) {
    const nowMs = BigInt(Date.now());
    return {
      schemaVersion: 2,
      configHash: config.configHash,
      instanceId: randomUUID(),
      metricsStartUnixNano: (nowMs * 1_000_000n).toString(),
      config: {
        stream: config.stream,
        namespace: config.namespace,
        sourceUrl: config.sourceUrl,
        endpointUrl: config.endpointUrl,
        start: config.start,
        qitemId: config.qitemId,
        includeQitemId: config.includeQitemId,
        signals: config.signals,
        rigs: config.rigs ?? null,
        pseudonymizeSeats: Boolean(config.pseudonymizeSeats),
      },
      hmacSalt: randomBytes(32).toString("hex"),
      queue: emptyQueueState(),
      seats: emptySeatsState(),
      ledger: emptyLedger(),
      cursor: null,
      source: { hostId: null, bootEpoch: null, sequenceSpaceId: null },
      coverage: { status: "retained_window", historyCompleteness: "unknown" },
      pending: null,
      updatedAt: new Date(Number(nowMs)).toISOString(),
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
  if (!parsed || typeof parsed !== "object") {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint file failed schema validation");
  }
  if (parsed.schemaVersion === 1) {
    throw new TelemetryCheckpointError("checkpoint_unsupported_version", "Checkpoint schemaVersion 1 is unsupported; use schemaVersion 2");
  }
  if (
    parsed.schemaVersion !== 2 ||
    typeof parsed.configHash !== "string" ||
    !isUuidV4(parsed.instanceId) ||
    !isDecimalId(parsed.metricsStartUnixNano, false) ||
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
  if (typeof parsed.hmacSalt !== "string" || !/^[0-9a-f]{64}$/.test(parsed.hmacSalt)) {
    throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint hmacSalt is malformed");
  }
  if (!parsed.queue) throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint queue observation state is missing");
  validateQueueState(parsed.queue);
  if (!parsed.seats) throw new TelemetryCheckpointError("checkpoint_malformed", "Checkpoint seat observation state is missing");
  validateSeatsState(parsed.seats);
  validateLedger(parsed.ledger);
  validateCheckpointPending(parsed.pending);
  const ckptRigs = parsed.config.rigs ?? null;
  const ckptPseudonymizeSeats = Boolean(parsed.config.pseudonymizeSeats);
  if (
    parsed.configHash !== config.configHash ||
    parsed.config.stream !== config.stream ||
    parsed.config.namespace !== config.namespace ||
    parsed.config.sourceUrl !== config.sourceUrl ||
    parsed.config.endpointUrl !== config.endpointUrl ||
    parsed.config.start !== config.start ||
    parsed.config.qitemId !== config.qitemId ||
    parsed.config.includeQitemId !== config.includeQitemId ||
    JSON.stringify(parsed.config.signals) !== JSON.stringify(config.signals) ||
    JSON.stringify(ckptRigs) !== JSON.stringify(config.rigs ?? null) ||
    ckptPseudonymizeSeats !== Boolean(config.pseudonymizeSeats)
  ) {
    throw new TelemetryCheckpointError("checkpoint_config_mismatch", "Checkpoint configuration does not match current exporter options");
  }
  return parsed;
}

export function writeCheckpointAtomically(checkpointPath, state) {
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

export function httpRequestBounded(urlString, { method, headers = {}, body = null, timeoutMs, maxResponseBytes, signal = null }) {
  if (signal?.aborted) {
    return Promise.reject({ code: "aborted", message: "HTTP request aborted before start" });
  }
  const url = new URL(urlString);
  const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let activeRes = null;
    const onAbort = () => {
      req.destroy();
      activeRes?.destroy?.();
      finishError("aborted", "HTTP request aborted");
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finishError = (code, message) => {
      if (settled) return;
      settled = true;
      cleanup();
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
        activeRes = res;
        if (signal?.aborted) {
          onAbort();
          return;
        }
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
          if (signal?.aborted) {
            onAbort();
            return;
          }
          settled = true;
          cleanup();
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", () => finishError(signal?.aborted ? "aborted" : "network_error", "HTTP response stream failed"));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finishError("timeout", `HTTP request timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    req.on("error", () => finishError(signal?.aborted ? "aborted" : "network_error", "HTTP request failed"));
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

function emitDiagnostic(config, event, collector = null) {
  if (Array.isArray(collector) && collector.length < 64) collector.push(event);
  if (config.onDiagnostic) config.onDiagnostic(event);
}

export async function sendOtlpSignalBatch(config, signal, payload, itemCount, diagnosticsCollector = null) {
  const rejectedField = TELEMETRY_OTLP_ALLOWLISTS.rejectedCountFields[signal];
  const endpointUrl = config.endpoints?.[signal] ?? config.endpointUrl;
  if (!rejectedField || !endpointUrl) {
    throw new TelemetryExportError("invalid_signal", `Unsupported OTLP signal: ${String(signal)}`, { signal });
  }
  const abortSignal = config.signal ?? null;
  if (abortSignal?.aborted) {
    throw new TelemetryExportError("exporter_aborted", `OTLP ${signal} export aborted before send`, {
      signal,
      attempts: 0,
      retryDelaysMs: [],
    });
  }

  const body = JSON.stringify(payload);
  let lastFailureCode = "network_error";
  let lastStatus = null;
  const retryDelaysMs = [];

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (abortSignal?.aborted) {
      throw new TelemetryExportError("exporter_aborted", `OTLP ${signal} export aborted`, {
        signal,
        attempts: attempt,
        retryDelaysMs,
      });
    }
    let response;
    try {
      response = await httpRequestBounded(endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: TELEMETRY_OTLP_LIMITS.otlpResponseBytes,
        signal: abortSignal,
      });
    } catch (err) {
      if (err?.code === "aborted" || abortSignal?.aborted) {
        throw new TelemetryExportError("exporter_aborted", `OTLP ${signal} export aborted during request`, {
          signal,
          attempts: attempt + 1,
          retryDelaysMs,
        });
      }
      if (err && err.code === "response_too_large") {
        emitDiagnostic(config, { type: "otlp_response_too_large", signal, pendingRecords: itemCount }, diagnosticsCollector);
        throw new TelemetryExportError("otlp_response_too_large", "OTLP receiver response exceeded byte bound", {
          signal,
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
        await sleep(delayMs, abortSignal);
        if (abortSignal?.aborted) {
          throw new TelemetryExportError("exporter_aborted", `OTLP ${signal} export aborted during retry backoff`, {
            signal,
            attempts: attempt + 1,
            retryDelaysMs,
          });
        }
        continue;
      }
      throw new TelemetryExportError("otlp_retry_exhausted", `OTLP ${signal} export failed after ${attempt + 1} attempts (${lastFailureCode})`, {
        signal,
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
        await sleep(delayMs, abortSignal);
        if (abortSignal?.aborted) {
          throw new TelemetryExportError("exporter_aborted", `OTLP ${signal} export aborted during retry backoff`, {
            signal,
            attempts: attempt + 1,
            retryDelaysMs,
          });
        }
        continue;
      }
      throw new TelemetryExportError("otlp_retry_exhausted", `OTLP receiver returned retryable HTTP ${status} across ${attempt + 1} attempts`, {
        signal,
        reason: "http_retryable_status",
        status,
        attempts: attempt + 1,
        retryDelaysMs,
      });
    }

    if (status >= 400 && status < 600) {
      if (config.onPermanentError === "drop") {
        emitDiagnostic(config, {
          type: "otlp_permanent_rejection_dropped",
          signal,
          status,
          droppedCount: itemCount,
          ...(signal === "logs" ? { droppedRecords: itemCount } : {}),
        }, diagnosticsCollector);
        return {
          outcome: "dropped_permanent_rejection",
          signal,
          status,
          rejectedCount: 0,
          partialSuccessWarning: false,
          droppedCount: itemCount,
          ...(signal === "logs" ? { rejectedLogRecords: 0, droppedRecords: itemCount } : {}),
          attempts: attempt + 1,
          retryDelaysMs,
        };
      }
      emitDiagnostic(config, {
        type: "otlp_permanent_rejection_stopped",
        signal,
        status,
        pendingCount: itemCount,
        ...(signal === "logs" ? { pendingRecords: itemCount } : {}),
      }, diagnosticsCollector);
      throw new TelemetryExportError("otlp_permanent_rejection", `OTLP receiver permanently rejected ${signal} batch with HTTP ${status}`, {
        signal,
        status,
        disposition: "stopped",
        attempts: attempt + 1,
        retryDelaysMs,
        nonRetryableBlock: { code: "otlp_permanent_rejection", status },
      });
    }

    if (status !== 200) {
      throw new TelemetryExportError("otlp_unexpected_status", `OTLP receiver returned unexpected HTTP ${status}; expected 200`, {
        signal,
        status,
        attempts: attempt + 1,
        retryDelaysMs,
        nonRetryableBlock: { code: "otlp_unexpected_status", status },
      });
    }

    if (!isJsonContentType(headers)) {
      throw new TelemetryExportError("otlp_invalid_content_type", "OTLP receiver 200 response must have application/json content-type", {
        signal,
        status: 200,
        attempts: attempt + 1,
        retryDelaysMs,
        nonRetryableBlock: { code: "otlp_invalid_content_type", status: 200 },
      });
    }

    const invalidResponse = (message) => new TelemetryExportError("otlp_invalid_response", message, {
      signal,
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
      return {
        outcome: "exported",
        signal,
        status: 200,
        rejectedCount: 0,
        partialSuccessWarning: false,
        droppedCount: 0,
        [rejectedField]: 0,
        attempts: attempt + 1,
        retryDelaysMs,
      };
    }
    if (typeof parsedBody.partialSuccess !== "object" || Array.isArray(parsedBody.partialSuccess)) {
      throw invalidResponse("OTLP partialSuccess field is malformed");
    }
    const rawRejected = parsedBody.partialSuccess[rejectedField];
    let rejectedCount = 0;
    if (rawRejected !== undefined && rawRejected !== null) {
      if (typeof rawRejected === "number" && Number.isInteger(rawRejected) && rawRejected >= 0) {
        rejectedCount = rawRejected;
      } else if (typeof rawRejected === "string" && /^[0-9]+$/.test(rawRejected)) {
        rejectedCount = Number(rawRejected);
      } else {
        throw invalidResponse(`OTLP partialSuccess.${rejectedField} is invalid`);
      }
    }
    if (!Number.isSafeInteger(rejectedCount) || rejectedCount < 0 || rejectedCount > itemCount) {
      throw invalidResponse(`OTLP partialSuccess.${rejectedField} is out of bounds`);
    }
    const hasWarning = typeof parsedBody.partialSuccess.errorMessage === "string" && parsedBody.partialSuccess.errorMessage.trim().length > 0;
    if (rejectedCount > 0 || hasWarning) {
      emitDiagnostic(config, {
        type: "otlp_partial_success",
        signal,
        sentCount: itemCount,
        ...(signal === "logs" ? { sentRecords: itemCount } : {}),
        [rejectedField]: rejectedCount,
        partialSuccessWarning: hasWarning,
      }, diagnosticsCollector);
      return {
        outcome: "partial_success",
        signal,
        status: 200,
        rejectedCount,
        partialSuccessWarning: hasWarning,
        droppedCount: 0,
        [rejectedField]: rejectedCount,
        attempts: attempt + 1,
        retryDelaysMs,
      };
    }
    return {
      outcome: "exported",
      signal,
      status: 200,
      rejectedCount: 0,
      partialSuccessWarning: false,
      droppedCount: 0,
      [rejectedField]: 0,
      attempts: attempt + 1,
      retryDelaysMs,
    };
  }

  throw new TelemetryExportError("otlp_retry_exhausted", `OTLP ${signal} export failed (${lastFailureCode})`, {
    signal,
    reason: lastFailureCode,
    status: lastStatus,
    retryDelaysMs,
  });
}

export async function fetchSourceJson(urlString, config, maxResponseBytes = TELEMETRY_OTLP_LIMITS.sourceResponseBytes) {
  if (config.signal?.aborted) {
    throw new TelemetryExportError("exporter_aborted", "Telemetry source fetch aborted before start");
  }
  let response;
  try {
    response = await httpRequestBounded(urlString, {
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: config.timeoutMs,
      maxResponseBytes,
      signal: config.signal ?? null,
    });
  } catch (err) {
    if (err?.code === "aborted" || config.signal?.aborted) {
      throw new TelemetryExportError("exporter_aborted", "Telemetry source request aborted");
    }
    if (err?.code === "response_too_large") {
      throw new TelemetrySourceError("source_response_too_large", `Telemetry source response exceeded ${maxResponseBytes} byte bound`);
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

async function fetchSourcePage(config, cursor) {
  if (config.signal?.aborted) {
    throw new TelemetryExportError("exporter_aborted", "Telemetry source fetch aborted before start");
  }
  const url = new URL(config.sourceUrl);
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  else url.searchParams.set("start", config.start);
  url.searchParams.set("limit", String(config.limit));
  if (config.qitemId !== null) url.searchParams.set("qitemId", config.qitemId);
  return fetchSourceJson(url.toString(), config);
}

export function createPendingTransaction({ nextCursor, discontinuity, hasMore, source, coverage, signals = {}, diagnostics = [], derived = null }) {
  const normalizedSignals = {};
  for (const sig of TELEMETRY_OTLP_ALLOWLISTS.signals) {
    const spec = signals[sig];
    if (!spec || !Number.isInteger(spec.itemCount) || spec.itemCount === 0) {
      normalizedSignals[sig] = null;
      continue;
    }
    normalizedSignals[sig] = {
      itemCount: spec.itemCount,
      attempted: false,
      outcome: null,
      rejectedCount: 0,
      partialSuccessWarning: false,
      droppedCount: 0,
      status: null,
      blocked: null,
      payload: spec.payload,
    };
  }
  const pending = {
    nextCursor,
    discontinuity: Boolean(discontinuity),
    hasMore: Boolean(hasMore),
    source,
    coverage,
    diagnostics: Array.isArray(diagnostics) ? diagnostics.slice(0, 64) : [],
    derived,
    signals: normalizedSignals,
  };
  validateCheckpointPending(pending);
  return pending;
}

function summarizeTransactionResult(state, pending, replayedPending, retryDelaysMs) {
  const sigs = pending.signals;
  const activeEntries = TELEMETRY_OTLP_ALLOWLISTS.signals.map(s => [s, sigs[s]]).filter(([, e]) => e !== null);
  let overallOutcome = "exported";
  if (activeEntries.length === 0) {
    overallOutcome = "empty_page_advanced";
  } else if (activeEntries.every(([, e]) => e.outcome === "dropped_permanent_rejection")) {
    overallOutcome = "dropped_permanent_rejection";
  } else if (activeEntries.some(([, e]) => e.outcome === "partial_success" || e.outcome === "dropped_permanent_rejection")) {
    overallOutcome = "partial_success";
  }
  const logsEntry = sigs.logs;
  const metricsEntry = sigs.metrics;
  const tracesEntry = sigs.traces;
  const exportedCountFor = (entry) => (!entry || entry.outcome === "dropped_permanent_rejection" || entry.outcome === null ? 0 : entry.itemCount);
  const signalSummary = {};
  for (const sig of TELEMETRY_OTLP_ALLOWLISTS.signals) {
    const e = sigs[sig];
    signalSummary[sig] = e === null ? null : {
      outcome: e.outcome,
      itemCount: e.itemCount,
      exportedCount: exportedCountFor(e),
      rejectedCount: e.rejectedCount,
      partialSuccessWarning: e.partialSuccessWarning,
      droppedCount: e.droppedCount,
      status: e.status ?? 200,
    };
  }
  const firstActiveStatus = activeEntries.find(([, e]) => e.status !== null)?.[1]?.status ?? 200;
  return {
    outcome: overallOutcome,
    exportedRecords: exportedCountFor(logsEntry),
    rejectedLogRecords: logsEntry?.rejectedCount ?? 0,
    partialSuccessWarning: activeEntries.some(([, e]) => e.partialSuccessWarning),
    droppedRecords: logsEntry?.droppedCount ?? 0,
    exportedDataPoints: exportedCountFor(metricsEntry),
    rejectedDataPoints: metricsEntry?.rejectedCount ?? 0,
    droppedDataPoints: metricsEntry?.droppedCount ?? 0,
    exportedSpans: exportedCountFor(tracesEntry),
    rejectedSpans: tracesEntry?.rejectedCount ?? 0,
    droppedSpans: tracesEntry?.droppedCount ?? 0,
    status: logsEntry?.status ?? firstActiveStatus,
    retryDelaysMs,
    replayedPending: Boolean(replayedPending),
    discontinuity: Boolean(pending.discontinuity),
    hasMore: Boolean(pending.hasMore),
    cursor: state.cursor,
    source: state.source,
    coverage: state.coverage,
    signals: signalSummary,
    diagnostics: pending.diagnostics,
  };
}

export async function exportPendingTransaction(config, checkpoint, transactionInput = null) {
  const replayedPending = checkpoint.pending !== null;
  let currentState = checkpoint;
  let pending = checkpoint.pending;

  if (!replayedPending) {
    pending = createPendingTransaction(transactionInput);
    currentState = { ...checkpoint, pending };
    writeCheckpointAtomically(config.checkpointPath, currentState);
  }

  const allRetryDelaysMs = [];
  const diagnostics = [...(pending.diagnostics ?? [])];

  // One atomic write per signal outcome. A failure observed here is appended to the durable ledger in the SAME write
  // that records the signal state, so it can neither be lost nor counted twice across retries and final adoption.
  const persist = (signals, failure = null) => {
    pending = { ...pending, diagnostics, signals: { ...pending.signals, ...signals } };
    currentState = { ...currentState, pending };
    if (failure) currentState = withLedgerFailure(currentState, { stage: "export", ...failure });
    writeCheckpointAtomically(config.checkpointPath, currentState);
  };

  for (const sig of TELEMETRY_OTLP_ALLOWLISTS.signals) {
    const entry = pending.signals[sig];
    if (entry === null || entry.outcome !== null) continue;

    if (entry.blocked !== null) {
      if (entry.blocked.code === "otlp_permanent_rejection" && config.onPermanentError === "drop") {
        emitDiagnostic(config, {
          type: "otlp_permanent_rejection_dropped",
          signal: sig,
          status: entry.blocked.status,
          droppedCount: entry.itemCount,
          ...(sig === "logs" ? { droppedRecords: entry.itemCount } : {}),
        }, diagnostics);
        persist({
          [sig]: { ...entry, outcome: "dropped_permanent_rejection", droppedCount: entry.itemCount, status: entry.blocked.status, blocked: null },
        }, { category: "otlp_dropped_permanent_rejection", signal: sig, items: entry.itemCount });
        continue;
      }
      // Already ledgered when it blocked: a rerun of a blocked batch is not a new failure.
      throw new TelemetryExportError(
        entry.blocked.code,
        `Pending ${sig} batch is blocked by prior non-retryable ${entry.blocked.code} and will not be automatically resubmitted`,
        { signal: sig, status: entry.blocked.status, disposition: "stopped", attempts: 0, retryDelaysMs: [] },
      );
    }

    const wasAttemptedBefore = entry.attempted;
    const payloadToSend = wasAttemptedBefore ? markSignalPayloadReplayed(sig, entry.payload) : entry.payload;
    const markedAttemptedEntry = { ...entry, attempted: true, payload: payloadToSend };
    persist({ [sig]: markedAttemptedEntry });

    let sigResult;
    try {
      sigResult = await sendOtlpSignalBatch(config, sig, payloadToSend, entry.itemCount, diagnostics);
    } catch (err) {
      if (Array.isArray(err?.retryDelaysMs)) allRetryDelaysMs.push(...err.retryDelaysMs);
      const category = exportFailureCategory(err);
      persist(
        err?.nonRetryableBlock ? { [sig]: { ...markedAttemptedEntry, blocked: err.nonRetryableBlock } } : {},
        category ? { category, signal: sig } : null,
      );
      throw err;
    }

    if (Array.isArray(sigResult.retryDelaysMs)) allRetryDelaysMs.push(...sigResult.retryDelaysMs);
    const resolvedEntry = {
      ...markedAttemptedEntry,
      outcome: sigResult.outcome,
      rejectedCount: sigResult.rejectedCount ?? 0,
      partialSuccessWarning: Boolean(sigResult.partialSuccessWarning),
      droppedCount: sigResult.droppedCount ?? 0,
      status: sigResult.status ?? 200,
      blocked: null,
    };
    const failure = sigResult.outcome === "partial_success"
      ? { category: "otlp_partial_success", signal: sig, items: resolvedEntry.rejectedCount }
      : sigResult.outcome === "dropped_permanent_rejection"
        ? { category: "otlp_dropped_permanent_rejection", signal: sig, items: resolvedEntry.droppedCount }
        : null;
    persist({ [sig]: resolvedEntry }, failure);
  }

  // Adoption: the proposed cursor and derived state become current only now that every signal resolved.
  const derived = pending.derived;
  const adoptedState = {
    ...currentState,
    cursor: pending.nextCursor,
    source: pending.source,
    coverage: pending.coverage,
    ...(derived ? {
      ...(derived.queue ? { queue: derived.queue } : {}),
      ...(derived.seats ? { seats: derived.seats } : {}),
      ledger: consumeLedger(currentState.ledger, derived),
    } : {}),
    pending: null,
  };
  writeCheckpointAtomically(config.checkpointPath, adoptedState);
  return summarizeTransactionResult(adoptedState, pending, replayedPending, allRetryDelaysMs);
}

export async function exportQueueTransitionsOnce(rawOptions) {
  const config = normalizeConfig(rawOptions);
  const checkpoint = readCheckpoint(config);

  if (checkpoint.pending !== null) {
    return exportPendingTransaction(config, checkpoint, null);
  }

  let workingCheckpoint = checkpoint;
  let built;
  try {
    const envelope = await fetchSourcePage(config, workingCheckpoint.cursor);
    const { observedTimeUnixNano } = validateSourceEnvelope(envelope);
    let seatSample = null;
    if (config.sampleSeats && (config.signals.includes("metrics") || config.signals.includes("logs"))) {
      try {
        seatSample = await sampleSeatInventory(config, workingCheckpoint, observedTimeUnixNano, envelope.source.bootEpoch);
        if (Array.isArray(seatSample.failures) && seatSample.failures.length > 0) {
          for (const category of seatSample.failures) {
            emitDiagnostic(config, {
              type: "seat_inventory_failure",
              category,
              status: null,
            });
            workingCheckpoint = withLedgerFailure(workingCheckpoint, { stage: "source", category });
          }
          writeCheckpointAtomically(config.checkpointPath, workingCheckpoint);
        }
      } catch (seatErr) {
        if (seatErr instanceof TelemetryExportError && seatErr.code === "exporter_aborted") {
          throw seatErr;
        }
        const category = seatErr instanceof TelemetrySourceError ? seatErr.code : "source_other";
        emitDiagnostic(config, {
          type: "seat_inventory_failure",
          category,
          status: typeof seatErr?.status === "number" ? seatErr.status : null,
        });
        workingCheckpoint = withLedgerFailure(workingCheckpoint, { stage: "source", category });
        writeCheckpointAtomically(config.checkpointPath, workingCheckpoint);
        seatSample = {
          seats: cloneSeatsState(workingCheckpoint.seats),
          seatMetrics: null,
          tenureLogs: [],
        };
      }
    }
    built = buildQueueTransaction(envelope, config, workingCheckpoint, seatSample);
  } catch (err) {
    persistSourceFailure(config, workingCheckpoint, err);
    throw err;
  }

  if (!built.hasOutput) {
    const { input } = built;
    const nextState = {
      ...workingCheckpoint,
      cursor: input.nextCursor,
      source: input.source,
      coverage: input.coverage,
      queue: input.derived.queue,
      ...(input.derived.seats ? { seats: input.derived.seats } : {}),
      ledger: consumeLedger(workingCheckpoint.ledger, input.derived),
      pending: null,
    };
    writeCheckpointAtomically(config.checkpointPath, nextState);
    return summarizeTransactionResult(
      nextState,
      {
        nextCursor: input.nextCursor,
        discontinuity: false,
        hasMore: input.hasMore,
        source: input.source,
        coverage: input.coverage,
        diagnostics: [],
        signals: { logs: null, metrics: null, traces: null },
      },
      false,
      [],
    );
  }

  return exportPendingTransaction(config, workingCheckpoint, built.input);
}

export async function runQueueTransitionsExporter(rawOptions) {
  const config = normalizeConfig(rawOptions);
  if (config.once) return exportQueueTransitionsOnce(config);
  const signal = config.signal;
  let lastResult = null;
  let lastSeatSampleMs = 0;
  while (!signal?.aborted) {
    const nowMs = Date.now();
    const shouldSampleSeats = config.sampleSeats && (lastSeatSampleMs === 0 || nowMs - lastSeatSampleMs >= config.seatPollMs);
    lastResult = await exportQueueTransitionsOnce({ ...config, sampleSeats: shouldSampleSeats });
    if (shouldSampleSeats && !lastResult.replayedPending) lastSeatSampleMs = nowMs;
    if (signal?.aborted) break;
    if (!lastResult.hasMore && !lastResult.replayedPending) await sleep(config.pollMs, signal);
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
    if (controller.signal.aborted && err instanceof TelemetryExportError && err.code === "exporter_aborted") {
      return 0;
    }
    const code = err?.code ?? "exporter_error";
    const status = typeof err?.status === "number" ? ` (status ${err.status})` : "";
    process.stderr.write(`[telemetry-otlp] ${code}${status}: ${err?.message ?? "Exporter failed"}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function isDirectCliExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectCliExecution()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
