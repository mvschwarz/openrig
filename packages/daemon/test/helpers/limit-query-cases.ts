import { expect } from "vitest";

/** #586: `?limit=` parses exactly as it does on main (`Number.parseInt`), and
 * only the values that used to fail as a 500 are refused. */
export async function expectLimitParsing(
  app: { request: (url: string) => Response | Promise<Response> },
  base: string,
  opts: { boundIntoSql?: boolean } = {},
): Promise<void> {
  const sep = base.includes("?") ? "&" : "?";
  const get = async (limit?: string) => {
    const res = await app.request(limit === undefined ? base : `${base}${sep}limit=${limit}`);
    return { status: res.status, body: await res.json() };
  };

  // Non-numeric: was a 500 (NaN bound into SQL), now a 400.
  for (const limit of ["abc", "x10", "-"]) {
    expect({ limit, ...(await get(limit)) }).toEqual({ limit, status: 400, body: { error: "limit must be an integer" } });
  }

  // Absent or empty keeps the route default.
  const absent = await get();
  expect(absent.status).toBe(200);
  expect(await get("")).toEqual(absent);

  // Negative, zero and positive keep working as on main.
  for (const limit of ["-1", "0", "2"]) {
    expect({ limit, status: (await get(limit)).status }).toEqual({ limit, status: 200 });
  }

  // Values parseInt reads leniently answer exactly as the integer it reads.
  for (const [limit, same] of [["2abc", "2"], ["1.5", "1"], ["%202", "2"], ["%2B2", "2"], ["1e3", "1"]]) {
    expect({ limit, ...(await get(limit)) }).toEqual({ limit, ...(await get(same)) });
  }

  // The largest magnitudes SQLite can bind keep working.
  for (const limit of ["9223372036854775295", "-9223372036854775295"]) {
    expect({ limit, status: (await get(limit)).status }).toEqual({ limit, status: 200 });
  }

  // From 2^63 up SQLite cannot bind the value (a 500 on main), so it is a 400
  // where the route binds it, and unchanged where the route clamps it first.
  const large = opts.boundIntoSql === false ? 200 : 400;
  for (const limit of ["9223372036854775296", "99999999999999999999", "-9223372036854775296", "9".repeat(400)]) {
    expect({ limit: limit.slice(0, 25), status: (await get(limit)).status }).toEqual({ limit: limit.slice(0, 25), status: large });
  }
}
