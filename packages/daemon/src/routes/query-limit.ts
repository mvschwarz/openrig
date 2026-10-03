import type { Context } from "hono";

/** Parse an optional `?limit=` for routes that bind it straight into SQL.
 * better-sqlite3 throws on a NaN or fractional LIMIT (a 500), and SQLite treats
 * a negative LIMIT as unbounded, so anything but a positive integer is a 400. */
export function queryLimit(c: Context): { ok: true; limit: number | undefined } | { ok: false; response: Response } {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return { ok: true, limit: undefined };
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return { ok: false, response: c.json({ error: "limit must be a positive integer" }, 400) };
  }
  return { ok: true, limit };
}
