// Quiet hours for a person: a timed overlay beside their availability, set on its own (or, later, by a mode). This
// module stores the window and resolves it against the clock. It doesn't decide delivery: nothing in the delivery
// path reads it yet.
//
// One current window per person, either a daily local rule ("22:00-07:00" in a named IANA timezone, which may cross
// midnight) or an until-time. Every set, replace, extend and clear bumps the window's revision; "end" closes only the
// current occurrence, so tomorrow's rule stays.
//
// Local times that don't exist or happen twice (daylight saving changes) follow one convention:
// - a skipped local time (the spring gap) means the next valid minute after it;
// - a repeated local time (the autumn overlap) means its first occurrence.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type QuietWindowErrorCode = "invalid_timezone" | "invalid_time" | "empty_window" | "until_passed" | "not_quiet" | "no_window";

export class QuietWindowError extends Error {
  constructor(readonly code: QuietWindowErrorCode, message: string) {
    super(message);
    this.name = "QuietWindowError";
  }
}

export interface QuietWindow {
  entityId: string;
  windowId: string;
  revision: number;
  kind: "daily" | "until";
  timezone: string;
  /** Daily rule only: local HH:MM. */
  start?: string;
  end?: string;
  /** Until-time only: an instant (ISO). */
  until?: string;
  source: string;
  setBy: string;
  setAt: string;
  /** The current revision's occurrence that was ended early, if any. */
  ended?: { occurrence: string; by: string; at: string };
}

export interface QuietBoundary {
  kind: "start" | "end";
  at: string;
}

export type QuietState =
  | { active: false; nextBoundary: null }
  | { active: false; windowId: string; revision: number; nextBoundary: QuietBoundary | null }
  /** occurrenceStart: when the occurrence that is on now began (a daily window's start that day; an until-window's
   *  single occurrence begins when its rule was set). */
  | { active: true; windowId: string; revision: number; occurrence: string; occurrenceStart: string; nextBoundary: QuietBoundary };

interface Row {
  entity_id: string; window_id: string; revision: number; kind: "daily" | "until"; timezone: string;
  daily_start: string | null; daily_end: string | null; until_at: string | null; source: string;
  set_by: string; set_at: string; ended_occurrence: string | null; ended_by: string | null; ended_at: string | null;
  cleared_by: string | null; cleared_at: string | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class HumanQuietStore {
  constructor(private readonly db: Database.Database) {}

  setDaily(entityId: string, input: { start: string; end: string; timezone: string; setBy: string; now: Date; source?: string }): QuietWindow {
    assertTimezone(input.timezone);
    for (const value of [input.start, input.end]) {
      if (!HHMM.test(value)) throw new QuietWindowError("invalid_time", `"${value}" isn't a time: use 24-hour HH:MM, for example 22:00`);
    }
    if (input.start === input.end) throw new QuietWindowError("empty_window", "the start and end are the same time, so the window would be empty");
    return this.write(entityId, { kind: "daily", timezone: input.timezone, daily_start: input.start, daily_end: input.end, until_at: null },
      input.setBy, input.now, input.source);
  }

  setUntil(entityId: string, input: { until: Date; timezone: string; setBy: string; now: Date; source?: string }): QuietWindow {
    assertTimezone(input.timezone);
    if (Number.isNaN(input.until.getTime())) throw new QuietWindowError("invalid_time", "the until-time isn't a valid time");
    if (input.until.getTime() <= input.now.getTime()) {
      throw new QuietWindowError("until_passed", `${input.until.toISOString()} has already passed`);
    }
    return this.write(entityId, { kind: "until", timezone: input.timezone, daily_start: null, daily_end: null, until_at: input.until.toISOString() },
      input.setBy, input.now, input.source);
  }

  /** "I'm back": end the occurrence that is on now. Tomorrow's daily rule stays. */
  end(entityId: string, input: { endedBy: string; now: Date }): { windowId: string; revision: number; occurrence: string } {
    const state = this.quietStateFor(entityId, input.now);
    if (!state.active) throw new QuietWindowError("not_quiet", `quiet isn't on now for ${entityId}, so there's nothing to end`);
    this.db.prepare(`UPDATE human_quiet_windows SET ended_occurrence = ?, ended_by = ?, ended_at = ? WHERE entity_id = ? AND revision = ?`)
      .run(state.occurrence, input.endedBy, input.now.toISOString(), entityId, state.revision);
    return { windowId: state.windowId, revision: state.revision, occurrence: state.occurrence };
  }

  /** Put an occurrence's ended mark back on the current revision, as end() writes it (no new revision, no source change):
   *  for a window restored over one whose occurrence the person had already ended, so restoring it doesn't start that
   *  occurrence's quiet again. Applies only while the revision is still the given one. */
  restoreEnded(entityId: string, revision: number, ended: { occurrence: string; by: string; at: string }): void {
    this.db.prepare(`UPDATE human_quiet_windows SET ended_occurrence = ?, ended_by = ?, ended_at = ? WHERE entity_id = ? AND revision = ?`)
      .run(ended.occurrence, ended.by, ended.at, entityId, revision);
  }

  /** Remove the rule. The row stays, with a new revision, so an older revision is still recognisably stale. */
  clear(entityId: string, input: { clearedBy: string; now: Date }): { windowId: string; revision: number } {
    const row = this.row(entityId);
    if (!row || row.cleared_at) throw new QuietWindowError("no_window", `${entityId} has no quiet window to clear`);
    const revision = row.revision + 1;
    this.db.prepare(`UPDATE human_quiet_windows SET revision = ?, cleared_by = ?, cleared_at = ?,
        ended_occurrence = NULL, ended_by = NULL, ended_at = NULL WHERE entity_id = ?`)
      .run(revision, input.clearedBy, input.now.toISOString(), entityId);
    return { windowId: row.window_id, revision };
  }

  /** The current window, or null when there is none (never set, or cleared). */
  show(entityId: string): QuietWindow | null {
    const row = this.row(entityId);
    return row && !row.cleared_at ? toWindow(row) : null;
  }

  /** Whether quiet is on for this person now, for which occurrence and revision, and the next boundary. */
  quietStateFor(entityId: string, now: Date): QuietState {
    const row = this.row(entityId);
    if (!row) return { active: false, nextBoundary: null };
    const base = { windowId: row.window_id, revision: row.revision };
    if (row.cleared_at) return { active: false, ...base, nextBoundary: null };
    const nowMs = now.getTime();
    if (row.kind === "until") {
      const untilMs = Date.parse(row.until_at!);
      if (nowMs < untilMs && row.ended_occurrence !== "until") {
        return { active: true, ...base, occurrence: "until", occurrenceStart: row.set_at, nextBoundary: { kind: "end", at: new Date(untilMs).toISOString() } };
      }
      return { active: false, ...base, nextBoundary: null };
    }
    const start = row.daily_start!, end = row.daily_end!, tz = row.timezone;
    const today = localDate(now, tz);
    let nextStart: number | null = null;
    // The occurrence that started yesterday can still be on (a window across midnight). The search runs two days ahead,
    // so skipping one empty occurrence still finds the next real one.
    for (const day of [addDays(today, -1), today, addDays(today, 1), addDays(today, 2)]) {
      const startMs = zonedLocalToInstant(day, start, tz).getTime();
      const endMs = zonedLocalToInstant(end > start ? day : addDays(day, 1), end, tz).getTime();
      // A window wholly inside a skipped hour resolves both ends to the same instant: that night has no quiet at all.
      if (endMs <= startMs) continue;
      if (startMs <= nowMs && nowMs < endMs && row.ended_occurrence !== day) {
        return { active: true, ...base, occurrence: day, occurrenceStart: new Date(startMs).toISOString(), nextBoundary: { kind: "end", at: new Date(endMs).toISOString() } };
      }
      if (startMs > nowMs && (nextStart === null || startMs < nextStart)) nextStart = startMs;
    }
    return { active: false, ...base, nextBoundary: nextStart === null ? null : { kind: "start", at: new Date(nextStart).toISOString() } };
  }

  private write(entityId: string, rule: Pick<Row, "kind" | "timezone" | "daily_start" | "daily_end" | "until_at">,
    setBy: string, now: Date, source = "manual"): QuietWindow {
    const existing = this.row(entityId);
    const windowId = existing?.window_id ?? randomUUID();
    const revision = (existing?.revision ?? 0) + 1;
    this.db.prepare(`INSERT INTO human_quiet_windows (entity_id, window_id, revision, kind, timezone, daily_start, daily_end, until_at,
        source, set_by, set_at, ended_occurrence, ended_by, ended_at, cleared_by, cleared_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
      ON CONFLICT (entity_id) DO UPDATE SET revision = excluded.revision, kind = excluded.kind, timezone = excluded.timezone,
        daily_start = excluded.daily_start, daily_end = excluded.daily_end, until_at = excluded.until_at, source = excluded.source,
        set_by = excluded.set_by, set_at = excluded.set_at, ended_occurrence = NULL, ended_by = NULL, ended_at = NULL,
        cleared_by = NULL, cleared_at = NULL`)
      .run(entityId, windowId, revision, rule.kind, rule.timezone, rule.daily_start, rule.daily_end, rule.until_at,
        source, setBy, now.toISOString());
    return toWindow(this.row(entityId)!);
  }

  private row(entityId: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM human_quiet_windows WHERE entity_id = ?`).get(entityId) as Row | undefined;
  }
}

function toWindow(row: Row): QuietWindow {
  return {
    entityId: row.entity_id, windowId: row.window_id, revision: row.revision, kind: row.kind, timezone: row.timezone,
    ...(row.kind === "daily" ? { start: row.daily_start!, end: row.daily_end! } : { until: row.until_at! }),
    source: row.source, setBy: row.set_by, setAt: row.set_at,
    ...(row.ended_occurrence ? { ended: { occurrence: row.ended_occurrence, by: row.ended_by!, at: row.ended_at! } } : {}),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}

export function assertTimezone(tz: string): void {
  try {
    if (!tz || formatter(tz).resolvedOptions().timeZone === undefined) throw new RangeError(tz);
  } catch {
    throw new QuietWindowError("invalid_timezone", `unknown timezone "${tz}": use an IANA name, for example Europe/Berlin or America/New_York`);
  }
}

/** The local wall-clock fields of an instant in a timezone, as a UTC-epoch number of the same fields. */
function localFieldsMs(ms: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
}

function localDate(now: Date, tz: string): string {
  return new Date(localFieldsMs(now.getTime(), tz)).toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The instant a local date and time happen in a timezone: a skipped time gives the next valid minute, a repeated
 *  time its first occurrence. */
export function zonedLocalToInstant(day: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const wanted = Date.parse(`${day}T00:00:00Z`) + (h! * 60 + m!) * 60_000;
  for (let skip = 0; skip <= 24 * 60; skip++) {
    const local = wanted + skip * 60_000;
    const matches = new Set<number>();
    for (const probe of [local - DAY_MS, local, local + DAY_MS]) {
      const offset = localFieldsMs(probe, tz) - probe;
      const candidate = local - offset;
      if (localFieldsMs(candidate, tz) === local) matches.add(candidate);
    }
    if (matches.size > 0) return new Date(Math.min(...matches));
  }
  throw new QuietWindowError("invalid_time", `${day} ${hhmm} doesn't occur in ${tz}`);
}

/** An until-time as a person gives it: an ISO instant with an offset, or a local "HH:MM" meaning its next occurrence
 *  in the timezone (under the convention above). */
export function resolveUntil(value: string, tz: string, now: Date): Date {
  assertTimezone(tz);
  const text = value.trim();
  if (HHMM.test(text)) {
    const today = localDate(now, tz);
    const todays = zonedLocalToInstant(today, text, tz);
    return todays.getTime() > now.getTime() ? todays : zonedLocalToInstant(addDays(today, 1), text, tz);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new QuietWindowError("invalid_time", `"${value}" isn't a time: use HH:MM (the next such time in the timezone) or an ISO time with an offset, for example 2026-10-21T07:00:00+02:00`);
  }
  return new Date(text);
}

/** A daily rule as a person gives it: "HH:MM-HH:MM". */
export function parseDailyRule(value: string): { start: string; end: string } {
  const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(value);
  if (!m) throw new QuietWindowError("invalid_time", `"${value}" isn't a daily window: use HH:MM-HH:MM, for example 22:00-07:00`);
  return { start: m[1]!, end: m[2]! };
}

/** The person's quiet window when it's on now, as the delivery decision takes it; null when it's off. Only a database
 *  without the quiet-hours table (an older schema) reads as off, which is today's behaviour. Any other failure to read
 *  it throws: a caller must not take "can't tell" as "not quiet" and post. */
export function quietHoldFor(db: Database.Database, entityId: string, now: Date): { windowId: string; occurrence: string; revision: number } | null {
  let state: QuietState;
  try {
    state = new HumanQuietStore(db).quietStateFor(entityId, now);
  } catch (error) {
    if (/no such table: human_quiet_windows/.test((error as Error).message)) return null;
    throw error;
  }
  return state.active ? { windowId: state.windowId, occurrence: state.occurrence, revision: state.revision } : null;
}
