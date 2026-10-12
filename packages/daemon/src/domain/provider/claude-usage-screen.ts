// Slice 01 (OPR.0.7.0.1) — parse Claude Code's `/usage` screen, as tmux renders it, into usage windows.
// The screen is text, so only the shapes seen are accepted (labels, "<n>% used", and the UTC reset forms
// below); anything else is an unrecognized screen, never guessed values. The reader runs Claude with
// TZ=UTC, so resets print in UTC.

export interface ClaudeScreenWindow {
  /** "current_session" or "current_week". */
  window: "current_session" | "current_week";
  durationMins: number;
  usedPercent: number;
  resetsAt: string | null;
}

/** One model group on the screen: "all models" (the session and the all-models week), or a named week. */
export interface ClaudeScreenBucket {
  bucket: string;
  windows: ClaudeScreenWindow[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A reset as Claude prints it in UTC: `3pm (UTC)`, `3:30pm (UTC)`, `Oct 14, 9am (UTC)` or `Oct 14 at 9am (UTC)`.
 * A bare time is its next occurrence; a dated reset more than 180 days past rolls to the next year.
 * Returns null for any other form.
 */
export function claudeResetUtc(raw: string, now: string): string | null {
  const m = raw.trim().match(/^(?:([A-Z][a-z]{2}) (\d{1,2})(?:,| at) )?(\d{1,2})(?::(\d{2}))?(am|pm) \(UTC\)$/);
  if (!m) return null;
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) return null;
  const hour12 = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (m[5] === "pm" ? 12 : 0);
  const month = m[1] === undefined ? nowDate.getUTCMonth() : MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  const day = m[2] === undefined ? nowDate.getUTCDate() : Number(m[2]);
  if (day < 1 || day > 31) return null;
  const at = new Date(Date.UTC(nowDate.getUTCFullYear(), month, day, hour, minute));
  if (m[1] === undefined && at < nowDate) at.setUTCDate(at.getUTCDate() + 1);
  if (m[1] !== undefined && nowDate.getTime() - at.getTime() > 180 * 86_400_000) at.setUTCFullYear(at.getUTCFullYear() + 1);
  return at.toISOString();
}

/** True once the screen has rendered the all-models week with its percentage. */
export function claudeUsageScreenReady(screen: string): boolean {
  return /Current week \(all models\)[\s\S]*?\d+(?:\.\d+)?% used/.test(screen);
}

/** Parse the rendered screen. `ok:false` names what didn't match; nothing is guessed. */
export function parseClaudeUsageScreen(screen: string, now: string):
  { ok: true; buckets: ClaudeScreenBucket[] } | { ok: false; detail: string } {
  const lines = screen.split("\n").map((line) => line.trim());
  const found: Array<{ bucket: string; window: ClaudeScreenWindow }> = [];
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i]!;
    let window: ClaudeScreenWindow["window"] | null = null;
    let bucket = "";
    if (label === "Current session") {
      window = "current_session";
      bucket = "all models";
    } else {
      const week = label.match(/^Current week \(([^)]+)\)$/);
      if (week) {
        window = "current_week";
        bucket = week[1]!;
      }
    }
    if (window === null) continue;
    let usedPercent: number | null = null;
    let resetsAt: string | null = null;
    for (const next of lines.slice(i + 1, i + 4)) {
      const used = next.match(/(\d+(?:\.\d+)?)% used$/);
      if (used && usedPercent === null) {
        usedPercent = Number(used[1]);
        continue;
      }
      if (next.startsWith("Resets ")) {
        resetsAt = claudeResetUtc(next.slice("Resets ".length), now);
        if (resetsAt === null) return { ok: false, detail: `unrecognized reset text for ${label}: ${next}` };
        break;
      }
      if (next.startsWith("Current ")) break;
    }
    if (usedPercent === null) return { ok: false, detail: `no "% used" under ${label}` };
    if (usedPercent < 0 || usedPercent > 100) return { ok: false, detail: `percentage out of range under ${label}` };
    found.push({ bucket, window: { window, durationMins: window === "current_session" ? 300 : 10080, usedPercent, resetsAt } });
  }
  if (!found.some((f) => f.bucket === "all models" && f.window.window === "current_week")) {
    return { ok: false, detail: "no Current week (all models) on the /usage screen" };
  }
  const buckets: ClaudeScreenBucket[] = [];
  for (const { bucket, window } of found) {
    let entry = buckets.find((b) => b.bucket === bucket);
    if (!entry) buckets.push(entry = { bucket, windows: [] });
    if (entry.windows.some((w) => w.window === window.window)) return { ok: false, detail: `${window.window} listed twice for ${bucket}` };
    entry.windows.push(window);
  }
  return { ok: true, buckets };
}
