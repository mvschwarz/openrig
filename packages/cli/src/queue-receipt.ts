import { ConfigStore } from "./config-store.js";
import { shellQuote } from "./cross-host-executor.js";

/**
 * Slice 15 (OPR.0.7.0.15) P1 — the short receipt a queue WRITE prints when the
 * `output.compact` switch is on. A CLI-side projection of the daemon's response:
 * the daemon's route shapes (and the payload a cross-host write forwards) are
 * untouched, and `--full` prints today's whole response byte for byte.
 *
 * The receipt names the row, its state and owner, what needs action (blocker,
 * backstop, warnings, advisories) and the wake evidence the response actually
 * carries. It never echoes the body, and its footer names what it left out and
 * the read that returns it. Error responses never come here: they print in full.
 */

const ENV = "OPENRIG_OUTPUT_COMPACT";

/** Whether compact defaults are on. `OPENRIG_OUTPUT_COMPACT` set to `true`/`1`
 *  is on and `false`/`0` is off (the config store's boolean words); any other
 *  non-empty value is off, with a note on stderr. Unset or empty defers to the
 *  `output.compact` config key, default off. An unreadable config is off. */
export function compactOutputEnabled(store?: Pick<ConfigStore, "get">): boolean {
  const raw = process.env[ENV];
  if (raw !== undefined && raw !== "") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    process.stderr.write(`[openrig-config] ${ENV}=${JSON.stringify(raw)} is not true, 1, false or 0; output.compact is off for this command\n`);
    return false;
  }
  try {
    return (store ?? new ConfigStore()).get("output.compact") === true;
  } catch {
    return false;
  }
}

export type WriteVerb = "create" | "claim" | "unclaim" | "update" | "block" | "handoff" | "handoff-and-complete";

export interface ReceiptContext {
  verb: WriteVerb;
  /** The CLI sent nudge:false (`--no-nudge`). */
  nudgeSuppressed?: boolean;
  /** The caller named the row id (`create --id`), so the daemon may have returned an existing row. */
  idGiven?: boolean;
  /** A `--host` write whose new row lives on another daemon. */
  remoteHost?: string;
}

type Row = Record<string, unknown>;

const PAST: Record<WriteVerb, string> = {
  create: "created",
  claim: "claimed",
  unclaim: "unclaimed",
  update: "updated",
  block: "parked",
  handoff: "handed off",
  "handoff-and-complete": "handed off and completed",
};
const STARTS_WAKE: ReadonlySet<WriteVerb> = new Set(["create", "handoff", "handoff-and-complete"]);
/** Kept at today's key, path and type (R3: 82% of write calls run `--json`, and
 *  agents' jq filters must keep working). ALWAYS keys stay even when null, so
 *  `.priority == "routine"` or `.lastNudgeResult == null` reads as it does today;
 *  the rest appear only when the row has a value. */
const ALWAYS = ["qitemId", "state", "destinationSession", "sourceSession", "tsCreated", "tsUpdated", "priority", "summary",
  "pickup", "lastNudgeResult", "lastNudgeAttempt"] as const;
const WHEN_SET = ["tier", "blockedOn", "closureReason", "closureTarget", "closureRequiredAt", "claimedAt", "handedOffTo",
  "handedOffFrom", "targetRepo", "expiresAt", "advisories", "handoffAdvisory", "createWarning", "persisted", "delivery"] as const;
const SHOWN_WAITING = ["blocker", "nextBackstop"] as const;
const ROW_KEYS_CONSUMED_ELSEWHERE = new Set<string>(["body", "waiting"]);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

function showCommand(id: string, remoteHost?: string): string {
  const show = `rig queue show ${shellQuote(id)} --full --json`;
  return remoteHost ? `OPENRIG_URL='<daemon-url of host ${remoteHost}>' ${show}` : show;
}

interface WakeEvidence {
  evidence: "suppressed" | "not-staged" | "existing-row" | "recorded" | "none-recorded";
  result?: string;
  at?: string;
  detail: string;
}

/** Only what this response proves. "Scheduled" is never said: the response
 *  carries no flag showing a wake reached the outbox, and a null result is
 *  equally an outbox wake not yet delivered, a daemon with no transport, or an
 *  existing row returned by an idempotent create. */
function wakeEvidence(row: Row, ctx: ReceiptContext): WakeEvidence {
  const result = str(row.lastNudgeResult);
  const at = str(row.lastNudgeAttempt) ?? undefined;
  const warning = isRow(row.createWarning) ? row.createWarning : null;
  if (ctx.nudgeSuppressed) return { evidence: "suppressed", detail: "--no-nudge: no wake was requested" };
  if (warning?.code === "qitem_body_not_saved") {
    return { evidence: "existing-row", ...(result ? { result } : {}), ...(at ? { at } : {}), detail: "an existing row was returned; this write started no new wake" };
  }
  if (result?.startsWith("failed:wake not retained")) {
    return { evidence: "not-staged", result, ...(at ? { at } : {}), detail: "the row saved but its wake was NOT staged" };
  }
  if (result) return { evidence: "recorded", result, ...(at ? { at } : {}), detail: "the daemon's recorded wake result" };
  const maybeExisting = ctx.idGiven
    ? "; if --id named an existing row, it was returned with no new wake"
    : ctx.remoteHost && ctx.verb !== "create"
      ? "; a re-driven cross-host handoff returns the existing successor with no new wake"
      : "";
  return { evidence: "none-recorded", detail: `no wake result recorded yet (delivery, if staged, follows the write)${maybeExisting}` };
}

function waitingReceipt(row: Row): Row | null {
  if (!isRow(row.waiting)) return null;
  const out: Row = {};
  for (const k of SHOWN_WAITING) if (row.waiting[k] !== undefined) out[k] = row.waiting[k];
  return out;
}

/** The receipt for one row, plus the paths of the response it does not show. */
function rowReceipt(row: Row, ctx: ReceiptContext, wake: boolean): { receipt: Row; omitted: string[] } {
  const receipt: Row = {};
  for (const k of ALWAYS) if (k in row) receipt[k] = row[k];
  for (const k of WHEN_SET) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") receipt[k] = v;
  }
  if (typeof row.body === "string") receipt.bodyBytes = Buffer.byteLength(row.body, "utf8");
  const waiting = waitingReceipt(row);
  if (waiting) receipt.waiting = waiting;
  // `wake` (a new key) labels what the response proves for a write that starts
  // one. Writes that start none keep the row's earlier wake fields as data only.
  if (wake) receipt.wake = wakeEvidence(row, ctx);
  const shown = new Set(Object.keys(receipt));
  const omitted: string[] = [];
  if (typeof row.body === "string") omitted.push("body");
  for (const k of Object.keys(row)) {
    if (ROW_KEYS_CONSUMED_ELSEWHERE.has(k) || shown.has(k)) continue;
    omitted.push(k);
  }
  if (isRow(row.waiting)) {
    for (const k of Object.keys(row.waiting)) if (!(SHOWN_WAITING as readonly string[]).includes(k)) omitted.push(`waiting.${k}`);
  }
  return { receipt, omitted };
}

export interface WriteReceipt {
  json: Row;
  text: string;
}

function backstopLine(b: unknown): string | null {
  if (!isRow(b)) return null;
  const parts = [`backstop: ${str(b.mechanism) ?? "unknown"}`];
  if (str(b.dueAt)) parts.push(`due ${b.dueAt}`);
  if (str(b.owner)) parts.push(`owner ${b.owner}`);
  if (isRow(b.recovery)) parts.push(`recovery ${String(b.recovery.qitemId)} (${String(b.recovery.state)})`);
  if (str(b.note)) parts.push(String(b.note));
  return parts.join(" · ");
}

function rowLines(heading: string, r: Row): string[] {
  const lines = [`${heading} ${String(r.qitemId)} · ${String(r.state)} · owner ${String(r.destinationSession)}`];
  const facts = [`created ${String(r.tsCreated)}`, `updated ${String(r.tsUpdated)}`,
    typeof r.bodyBytes === "number" ? `body ${r.bodyBytes.toLocaleString("en-US")} bytes` : "body size not in the response",
    `from ${String(r.sourceSession)}`];
  if (r.priority && r.priority !== "routine") facts.push(`priority ${String(r.priority)}`);
  if (r.claimedAt) facts.push(`claimed ${String(r.claimedAt)}`);
  if (r.closureRequiredAt) facts.push(`close by ${String(r.closureRequiredAt)}`);
  if (r.tier) facts.push(`tier ${String(r.tier)}`);
  if (r.targetRepo) facts.push(`repo ${String(r.targetRepo)}`);
  lines.push(`  ${facts.join(" · ")}`);
  if (r.summary) lines.push(`  summary: ${String(r.summary)}`);
  if (isRow(r.pickup)) lines.push(`  pickup: ${String(r.pickup.state)}${r.pickup.evidence ? ` (${String(r.pickup.evidence)})` : ""}`);
  const waiting = isRow(r.waiting) ? r.waiting : null;
  if (waiting && isRow(waiting.blocker)) {
    const b = waiting.blocker;
    lines.push(`  blocked on ${String(b.ref)}${b.owner || b.state ? ` (${[b.owner && `owner ${String(b.owner)}`, b.state && `state ${String(b.state)}`].filter(Boolean).join(", ")})` : ""}`);
  } else if (r.blockedOn) {
    lines.push(`  blocked on ${String(r.blockedOn)}`);
  }
  const backstop = waiting ? backstopLine(waiting.nextBackstop) : null;
  if (backstop) lines.push(`  ${backstop}`);
  if (r.closureReason || r.closureTarget) lines.push(`  closure: ${String(r.closureReason ?? "none")}${r.closureTarget ? ` → ${String(r.closureTarget)}` : ""}`);
  if (r.handedOffTo) lines.push(`  handed off to ${String(r.handedOffTo)}`);
  if (r.handedOffFrom) lines.push(`  handed off from ${String(r.handedOffFrom)}`);
  if (r.expiresAt) lines.push(`  expires ${String(r.expiresAt)}`);
  if (isRow(r.wake)) {
    const w = r.wake;
    const result = w.result ? `${String(w.result)}${w.at ? ` at ${String(w.at)}` : ""} — ` : "";
    lines.push(`  wake: ${result}${String(w.detail)}`);
  }
  if (isRow(r.createWarning)) lines.push(`  WARNING: ${String(r.createWarning.message ?? JSON.stringify(r.createWarning))}`);
  if (isRow(r.handoffAdvisory)) lines.push(`  advisory: ${String(r.handoffAdvisory.message ?? JSON.stringify(r.handoffAdvisory))}`);
  if (Array.isArray(r.advisories)) {
    for (const a of r.advisories) lines.push(`  advisory: ${isRow(a) && typeof a.message === "string" ? a.message : JSON.stringify(a)}`);
  }
  if (r.persisted !== undefined) lines.push(`  persisted: ${String(r.persisted)}`);
  if (r.delivery !== undefined) lines.push(`  delivery: ${JSON.stringify(r.delivery)}`);
  return lines;
}

function footer(omitted: string[], commands: string[], verb: WriteVerb): string {
  const bodies = omitted.filter((p) => p === "body" || p.endsWith(".body")).length;
  const others = omitted.length - bodies;
  const what = [bodies > 1 ? "bodies" : bodies === 1 ? "body" : "", others > 0 ? `${others} ${bodies ? "other " : ""}field${others === 1 ? "" : "s"}` : ""]
    .filter(Boolean).join(" and ") || "nothing";
  return `receipt: ${what} not shown (output.compact); full ${commands.length > 1 ? "rows" : "row"}: ${commands.join(" · ")}, or add --full to the ${verb}`;
}

/** Project a successful write response to its receipt. Returns null for a
 *  shape this projection does not recognize, so the caller prints the whole
 *  response rather than guess. */
export function buildWriteReceipt(body: unknown, ctx: ReceiptContext): WriteReceipt | null {
  if (!isRow(body)) return null;
  const wakes = STARTS_WAKE.has(ctx.verb);
  if (ctx.verb === "handoff" || ctx.verb === "handoff-and-complete") {
    if (!isRow(body.closed) || !isRow(body.created)) return null;
    const closed = rowReceipt(body.closed, ctx, false);
    const created = rowReceipt(body.created, ctx, wakes);
    const commands = [showCommand(String(body.closed.qitemId)), showCommand(String(body.created.qitemId), ctx.remoteHost)];
    const extraTop = Object.keys(body).filter((k) => k !== "closed" && k !== "created" && k !== "advisories");
    const omitted = [...closed.omitted.map((p) => `closed.${p}`), ...created.omitted.map((p) => `created.${p}`), ...extraTop];
    const json: Row = {
      closed: closed.receipt,
      created: created.receipt,
      ...(Array.isArray(body.advisories) ? { advisories: body.advisories } : {}),
      ...(ctx.remoteHost ? { host: ctx.remoteHost } : {}),
      receipt: { omitted, fullCommands: commands },
    };
    const text = [
      ...rowLines("closed", closed.receipt),
      ...rowLines("created", created.receipt),
      ...(ctx.remoteHost ? [`  host: ${ctx.remoteHost} (the new row lives on that daemon)`] : []),
      ...(Array.isArray(body.advisories) ? body.advisories.map((a) => `advisory: ${isRow(a) && typeof a.message === "string" ? a.message : JSON.stringify(a)}`) : []),
      footer(omitted, commands, ctx.verb),
    ].join("\n");
    return { json, text };
  }
  if (typeof body.qitemId !== "string") return null;
  const one = rowReceipt(body, ctx, wakes);
  const command = showCommand(body.qitemId, ctx.remoteHost);
  const json: Row = { ...one.receipt, ...(ctx.remoteHost ? { host: ctx.remoteHost } : {}), receipt: { omitted: one.omitted, fullCommand: command } };
  const text = [
    ...rowLines(PAST[ctx.verb], one.receipt),
    ...(ctx.remoteHost ? [`  host: ${ctx.remoteHost} (the row lives on that daemon)`] : []),
    footer(one.omitted, [command], ctx.verb),
  ].join("\n");
  return { json, text };
}
