// Slice 02 — System → Cost: the read. One GET of the daemon's cost view (the same body `rig usage cost --json`
// prints), computed from what the daemon already stores. It starts nothing: no provider lookup, native read, charge
// lookup, sign-in, account or setting change. A failed or absent route resolves to its status instead of throwing.

type Row = Record<string, unknown>;

export interface CostBody {
  seats: Array<Row & { seatSession: string; status: string }>;
  note: string;
}

export interface CostRead {
  /** The served cost view, or why it couldn't be read (status null: no HTTP answer). */
  status: { body: CostBody } | { status: number | null; error: string };
}

export const COST_ROUTE = "/api/telemetry/usage/cost";

/** GET the cost view through the caller's fetch (the TUI client's, so page reads, timeouts and headers apply). */
export async function readUsageCost(fetchImpl: typeof fetch, baseUrl: string, headers: Record<string, string>): Promise<CostRead["status"]> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${COST_ROUTE}`, { headers, signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : "Read failed; the cause was not identified." };
  }
  const data = await res.json().catch(() => null) as Row | null;
  if (!res.ok) return { status: res.status, error: typeof data?.["error"] === "string" ? data["error"] as string : `HTTP ${res.status}` };
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data["seats"])) {
    return { status: res.status, error: "the response was not a cost view" };
  }
  return { body: { seats: data["seats"] as CostBody["seats"], note: typeof data["note"] === "string" ? data["note"] : "" } };
}
