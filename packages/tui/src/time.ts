/** Absolute local presentation only. Source strings and ordering stay with the caller. */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

export function displayTime(value: unknown, timeZone = DEFAULT_TIME_ZONE): string {
  if (typeof value !== "string") return "time unknown";
  // SQLite datetime('now') is UTC. Zone-less ISO timestamps are ambiguous, not local time.
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp)) return "time unknown";
  const calendarDay = new Date(stamp.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== stamp.slice(0, 10)
    || Number(stamp.slice(11, 13)) > 23) return "time unknown";
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) return "time unknown";
  const zone = validTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date);
  const p = (name: string) => parts.find((part) => part.type === name)?.value ?? "?";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}:${p("second")} ${p("timeZoneName")}${zone !== timeZone ? " (timezone fallback)" : ""}`;
}

/** displayTime's HH:MM, for a row with room only for a clock; "" when the time is unknown. */
export function displayClock(value: unknown, timeZone = DEFAULT_TIME_ZONE): string {
  const time = displayTime(value, timeZone);
  return time === "time unknown" ? "" : time.slice(11, 16);
}

export function resolveTimeZone(setting: unknown, readWarning = false): { timeZone: string; warning: string | null } {
  const timeZone = validTimeZone(setting) ? setting : DEFAULT_TIME_ZONE;
  return { timeZone, warning: validTimeZone(setting) && !readWarning ? null
    : `ui.timezone unavailable or invalid; using ${timeZone}. Run timezone for correction.` };
}
