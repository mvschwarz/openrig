// Some history routes compare a since/until bound as text against a stored ISO timestamp, so a
// mistyped bound quietly matches nothing (or everything). These helpers only describe a bound so
// the route can say so; they never change how the route filters with it.

// An ISO date or time, or a leading part of one: 2026, 2026-10, 2026-10-14, 2026-10-14T09,
// 2026-10-14T09:30, 2026-10-14T09:30:00.123Z, with an optional zone once there is an hour.
const ISO_DATE_OR_TIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/** Whether a bound reads as an ISO date or time (or a leading part of one) with in-range fields. */
export function isRecognisedDateOrTime(value: string): boolean {
  const match = ISO_DATE_OR_TIME.exec(value);
  if (!match) return false;
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] =
    match.slice(1, 7).map((part) => (part === undefined ? undefined : Number(part)));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year!, month, 0);
  return day >= 1 && day <= lastDay.getUTCDate();
}

/** An advisory for a bound that is not recognised as a date or time; undefined when nothing triggers it. */
export function timeBoundAdvisory(name: string, value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.length === 0 || isRecognisedDateOrTime(value)) return undefined;
  return `${name} "${value}" was not recognised as a date or time; the existing text comparison against ${field} was used`;
}
