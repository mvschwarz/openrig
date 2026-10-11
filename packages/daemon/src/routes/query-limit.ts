import type { Context } from "hono";

// SQLite converts a bound real to an integer LIMIT only strictly inside
// (-2^63, 2^63); anything else is "datatype mismatch".
const SQL_LIMIT_BOUND = 2 ** 63;

/** Parse an optional `?limit=` exactly as these routes always have
 * (`Number.parseInt(limit, 10)`, so `-1`, `0` and `10abc` keep working), and
 * refuse only values that would fail as a 500: NaN, and, where the value is
 * bound straight into SQL, a magnitude SQLite cannot bind. Absent or empty
 * keeps the route's default. `used: false` is for a request that never binds
 * the limit (it returns early, or the query has its own), so any value answers
 * as it always has. */
export function queryLimit(
  c: Context,
  opts: { boundIntoSql?: boolean; used?: boolean } = {},
): { ok: true; limit: number | undefined } | { ok: false; response: Response } {
  const raw = c.req.query("limit");
  if (!raw) return { ok: true, limit: undefined };
  const limit = Number.parseInt(raw, 10);
  if (opts.used === false) return { ok: true, limit };
  const unbindable = (opts.boundIntoSql ?? true) && Math.abs(limit) >= SQL_LIMIT_BOUND;
  if (Number.isNaN(limit) || unbindable) {
    return { ok: false, response: c.json({ error: "limit must be an integer" }, 400) };
  }
  return { ok: true, limit };
}
