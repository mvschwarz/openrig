// Slice 18 — the report an agent files after it moves (or tries to move) a Codex home between subscriptions. The
// agent decides and moves (`rig auth switch`, `rig seat restart --keep-conversation`, then `--verify` after a real
// turn); this only checks and keeps what it reports. The report is a queue item to whoever asked, tagged
// `subscription-move`, whose body carries the report as one fenced JSON block, so the agent (and the Fleet app, once its
// page is connected) can read it back. It holds labels and references, never credentials, and it decides nothing: a refused report changes
// nothing about the move, and nothing here switches or restarts anything.

export const MOVE_REPORT_TAG = "subscription-move";
export const MOVE_REPORT_FENCE = "openrig-subscription-move";

export type MoveSeatResult = "moved" | "unconfirmed" | "unknown";
export type ReadingBasis = "observed" | "expected" | "unavailable";

/** A reading the agent acted on. `observed` is measured, `expected` is slice 01's labelled planning fact after a
 *  reset (never measured room), and `unavailable` is a reading it couldn't get. */
export interface MoveReading {
  subject: string;
  basis: ReadingBasis;
  /** When it was observed (ISO 8601). Required for `observed`; for the others, the last reading, if any. */
  observedAt?: string;
  /** For `expected`: the reset that passed, from slice 01's `expectation.expectedFullSince`. */
  expectedFullSince?: string;
  summary: string;
}

/** One kind of evidence for a seat, kept apart from the others (account, tool turn). */
export interface MoveEvidence { state: string; detail?: string; at?: string }

export interface MoveSeat {
  seat: string;
  result: MoveSeatResult;
  /** From `rig seat restart --verify`: whether the Account line matched. */
  accountEvidence?: MoveEvidence;
  /** From `rig seat restart --verify`: whether a completed, error-free tool turn was seen. */
  toolTurn?: MoveEvidence;
  /** For `unconfirmed` or `unknown`: what is missing. */
  missing?: string;
}

export interface MoveReport {
  version: 1;
  host: string;
  home: string;
  from: string;
  to: string;
  reason: string;
  /** The account policy the agent followed, or that there is none. */
  policy?: { ref: string; version: string } | { none: true };
  readings: MoveReading[];
  /** Seats restarted or attempted. Empty when the home was switched and every seat on it is a peer. */
  seats: MoveSeat[];
  /** Seats on the home not restarted ("not restarted; account unverified"), or skipped with a reason. */
  peers?: Array<{ seat: string; note: string }>;
  /** The report this one follows up, e.g. confirming a seat an earlier one left unconfirmed. */
  follows?: string;
}

// Recognized credential formats only. Ordinary labels, home paths and account names aren't credentials, so there is
// no broad shape heuristic (such as long base64 runs) here.
const CREDENTIAL_FORMATS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "Slack token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/ },
  { kind: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { kind: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];

/** Where `value` has a recognized credential format, in a string or in an object key: the path to it and the format,
 *  never the value. A key is checked before what it holds, so a path only ever names keys that passed. */
export function findCredential(value: unknown, path = "report"): { path: string; kind: string; inKey: boolean } | null {
  const format = (text: string) => CREDENTIAL_FORMATS.find((candidate) => candidate.pattern.test(text));
  if (typeof value === "string") {
    const hit = format(value);
    return hit ? { path, kind: hit.kind, inKey: false } : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findCredential(item, `${path}[${index}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const named = format(key);
      if (named) return { path, kind: named.kind, inKey: true };
      const hit = findCredential(item, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

/** The refusal for a credential `findCredential` found, saying where and which format without repeating it. */
export function credentialRefusal(hit: { path: string; kind: string; inKey: boolean }): string {
  return `${hit.path} ${hit.inKey ? "has a key that looks like" : "holds what looks like"} a ${hit.kind}; a report holds labels and references only, never credentials`;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isoTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

export type MoveReportCheck = { ok: true; report: MoveReport } | { ok: false; errors: string[] };

/** Check a report's shape. It checks what the report claims, not whether the move was authorized or happened. */
export function checkMoveReport(raw: unknown): MoveReportCheck {
  const credential = findCredential(raw);
  if (credential) return { ok: false, errors: [credentialRefusal(credential)] };
  if (!isObject(raw)) return { ok: false, errors: ["the report must be a JSON object"] };
  const errors: string[] = [];
  if (raw.version !== 1) errors.push("version must be 1");
  for (const field of ["host", "home", "from", "to", "reason"] as const) {
    if (!text(raw[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (raw.policy !== undefined) {
    const policy = raw.policy;
    const named = isObject(policy) && text(policy.ref) && text(policy.version);
    const none = isObject(policy) && policy.none === true;
    if (!named && !none) errors.push('policy must be { "ref": "<pack>", "version": "<version>" } or { "none": true }');
  }

  if (!Array.isArray(raw.readings) || raw.readings.length === 0) {
    errors.push("readings must list at least one reading the move acted on (an unavailable one counts, with basis unavailable)");
  } else {
    raw.readings.forEach((reading, index) => {
      const at = `readings[${index}]`;
      if (!isObject(reading)) { errors.push(`${at} must be an object`); return; }
      if (!text(reading.subject)) errors.push(`${at}.subject must be a non-empty string`);
      if (!text(reading.summary)) errors.push(`${at}.summary must be a non-empty string`);
      if (reading.observedAt !== undefined && !isoTime(reading.observedAt)) errors.push(`${at}.observedAt must be an ISO 8601 time`);
      if (reading.basis === "observed") {
        if (reading.observedAt === undefined) errors.push(`${at}: an observed reading needs observedAt, when it was observed`);
      } else if (reading.basis === "expected") {
        if (!isoTime(reading.expectedFullSince)) errors.push(`${at}: an expected reading needs expectedFullSince, the reset it rests on`);
      } else if (reading.basis !== "unavailable") {
        errors.push(`${at}.basis must be observed, expected or unavailable`);
      }
    });
  }

  if (!Array.isArray(raw.seats)) {
    errors.push("seats must be a list (empty when every seat on the home is a peer)");
  } else {
    raw.seats.forEach((seat, index) => {
      const at = `seats[${index}]`;
      if (!isObject(seat)) { errors.push(`${at} must be an object`); return; }
      if (!text(seat.seat)) errors.push(`${at}.seat must be a non-empty string`);
      for (const key of ["accountEvidence", "toolTurn"] as const) {
        const evidence = seat[key];
        if (evidence === undefined) continue;
        if (!isObject(evidence) || !text(evidence.state)) errors.push(`${at}.${key} must be an object with a state`);
        else if (evidence.at !== undefined && !isoTime(evidence.at)) errors.push(`${at}.${key}.at must be an ISO 8601 time`);
      }
      if (seat.result === "moved") {
        const account = isObject(seat.accountEvidence) ? seat.accountEvidence.state : undefined;
        const turn = isObject(seat.toolTurn) ? seat.toolTurn.state : undefined;
        if (account !== "matched" || turn !== "observed") {
          errors.push(`${at}: moved needs accountEvidence.state matched and toolTurn.state observed (from rig seat restart --verify); report it unconfirmed, with what's missing, until both are seen`);
        }
      } else if (seat.result === "unconfirmed" || seat.result === "unknown") {
        if (!text(seat.missing)) errors.push(`${at}: ${seat.result} needs missing, what wasn't seen`);
      } else {
        errors.push(`${at}.result must be moved, unconfirmed or unknown`);
      }
    });
  }

  if (raw.peers !== undefined) {
    if (!Array.isArray(raw.peers)) errors.push("peers must be a list");
    else raw.peers.forEach((peer, index) => {
      if (!isObject(peer) || !text(peer.seat) || !text(peer.note)) errors.push(`peers[${index}] must have a seat and a note`);
    });
  }
  if (raw.follows !== undefined && !text(raw.follows)) errors.push("follows must be the qitem id of the report this one follows up");

  return errors.length > 0 ? { ok: false, errors } : { ok: true, report: raw as unknown as MoveReport };
}

function seatLine(seat: MoveSeat): string {
  if (seat.result === "moved") {
    const account = seat.accountEvidence!;
    return `- ${seat.seat}: moved (account ${account.state}${account.detail ? `: ${account.detail}` : ""}${account.at ? ` at ${account.at}` : ""}; tool turn ${seat.toolTurn!.state}${seat.toolTurn!.at ? ` at ${seat.toolTurn!.at}` : ""})`;
  }
  return `- ${seat.seat}: ${seat.result}; missing: ${seat.missing}`;
}

function readingLine(reading: MoveReading): string {
  if (reading.basis === "expected") {
    return `- ${reading.subject}: expected full since ${reading.expectedFullSince} (not measured${reading.observedAt ? `; last reading ${reading.observedAt}` : ""}): ${reading.summary}`;
  }
  if (reading.basis === "unavailable") {
    return `- ${reading.subject}: unavailable${reading.observedAt ? ` (last reading ${reading.observedAt})` : ""}: ${reading.summary}`;
  }
  return `- ${reading.subject}: observed ${reading.observedAt}: ${reading.summary}`;
}

/** The queue item's summary and body: readable prose, then the report itself as one fenced block. */
export function renderMoveReport(report: MoveReport): { summary: string; body: string } {
  const count = (result: MoveSeatResult) => report.seats.filter((seat) => seat.result === result).length;
  const results = (["moved", "unconfirmed", "unknown"] as const).filter((result) => count(result) > 0).map((result) => `${count(result)} ${result}`);
  const peers = report.peers ?? [];
  const summary = `Subscription move ${report.from} → ${report.to} on ${report.host}: ${[...results, `${peers.length} peer${peers.length === 1 ? "" : "s"}`].join(", ")}`;
  const policy = report.policy === undefined ? "not stated"
    : "none" in report.policy ? "no policy" : `${report.policy.ref}, version ${report.policy.version}`;
  const lines = [
    `# Subscription move on ${report.host}: ${report.home}, ${report.from} → ${report.to}`,
    "",
    `**Reason:** ${report.reason}`,
    `**Policy:** ${policy}`,
    ...(report.follows ? [`**Follows:** ${report.follows}`] : []),
    "",
    "**Seats:**",
    ...(report.seats.length > 0 ? report.seats.map(seatLine) : ["- none restarted"]),
    ...(peers.length > 0 ? ["", "**Peers:**", ...peers.map((peer) => `- ${peer.seat}: ${peer.note}`)] : []),
    "",
    "**Readings:**",
    ...report.readings.map(readingLine),
    "",
    `\`\`\`${MOVE_REPORT_FENCE}`,
    JSON.stringify(report, null, 2),
    "```",
    "",
  ];
  return { summary, body: lines.join("\n") };
}

const OPENING = `\`\`\`${MOVE_REPORT_FENCE}\n`;

/** The report's block: the LAST opening fence at the start of a line, up to the next fence line. The block is written
 *  last, after the prose, so a fence quoted in the prose (say a reason quoting an earlier report) comes before it;
 *  inside the block, JSON escapes every newline, so no fence line can occur there. */
function reportBlock(body: string): string | undefined {
  let at = body.lastIndexOf(OPENING);
  while (at > 0 && body[at - 1] !== "\n") at = body.lastIndexOf(OPENING, at - 1);
  if (at < 0) return undefined;
  const start = at + OPENING.length;
  const end = body.indexOf("\n```", start);
  return end < 0 ? undefined : body.slice(start, end);
}

/** Read a report back from a queue item's body, with the same check as when it was filed. */
export function readMoveReport(body: string): MoveReportCheck {
  const block = reportBlock(body);
  if (block === undefined) return { ok: false, errors: [`no ${MOVE_REPORT_FENCE} block`] };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    // Not the parser's message: it quotes the input, which may be what a report must never repeat.
    return { ok: false, errors: [`the ${MOVE_REPORT_FENCE} block isn't valid JSON`] };
  }
  return checkMoveReport(raw);
}
