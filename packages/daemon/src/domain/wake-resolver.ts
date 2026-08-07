/**
 * L3b — resolve a seat[@generation] to a resume token for a wake, on the stores
 * that exist TODAY (ruling A): the `sessions` rows for the seat's session_name,
 * newest-first. No dedicated tenure ledger exists yet (that is the pooled
 * boot-capture atom); until it lands, "which tenures exist" = the sessions rows,
 * and a wake target that cannot be resolved REFUSES with a teaching listing —
 * raw tokens accepted, guessed tokens never.
 */

export interface WakeSessionRow {
  id: number;
  sessionName: string;
  resumeToken: string | null;
  runtime: string | null;
  createdAt: string;
}

export interface WakeResolveInput {
  seat: string;
  /** 1 = newest tenure (default), 2 = next-older, … */
  generation?: number;
}

export interface KnownTenure {
  generation: number;
  sessionId: number;
  tokenPresent: boolean;
  createdAt: string;
}

export type WakeResolution =
  | { resolved: true; token: string; runtime: "claude" | "codex"; sessionId: number }
  | { resolved: false; reason: string; known: KnownTenure[] };

/**
 * @param rows sessions for the seat's session_name, NEWEST-FIRST (id DESC).
 */
export function resolveWakeTarget(rows: WakeSessionRow[], input: WakeResolveInput): WakeResolution {
  const known: KnownTenure[] = rows.map((r, i) => ({
    generation: i + 1,
    sessionId: r.id,
    tokenPresent: !!r.resumeToken,
    createdAt: r.createdAt,
  }));

  if (rows.length === 0) {
    return {
      resolved: false,
      reason: `No known sessions for seat '${input.seat}'. It may never have run on this host, or its sessions predate resume-token capture.`,
      known,
    };
  }

  const gen = input.generation ?? 1;
  if (gen < 1 || gen > rows.length) {
    return {
      resolved: false,
      reason: `Generation ${gen} does not exist for seat '${input.seat}' — only ${rows.length} tenure(s) recorded. Pick 1..${rows.length} (1 = newest).`,
      known,
    };
  }

  const row = rows[gen - 1]!;
  if (!row.resumeToken) {
    return {
      resolved: false,
      reason: `Tenure ${gen} of seat '${input.seat}' has no captured resume token (not resumable). Try another generation, or pass a raw token to --wake.`,
      known,
    };
  }

  const runtime: "claude" | "codex" = row.runtime === "codex" ? "codex" : "claude";
  return { resolved: true, token: row.resumeToken, runtime, sessionId: row.id };
}
