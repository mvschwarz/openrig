import { DaemonTimeoutError, type DaemonClient } from "./client.js";

const FRESH_REASON = "fresh-prime after restore";

/**
 * The one-seat command printed for a seat a restore left awaiting a decision. `rig up --existing <rig> --fresh <seat>`
 * is refused while sibling seats run, which is the state a partial restore leaves. The restore result names each
 * seat by its logical id and carries the rig's name, but not the seat's session name. `rig seat launch` resolves
 * `<logical id>@<rig>` to the seat with exactly that logical id in that rig, so dotted legacy ids such as
 * `dev.ops.impl` and `dev.ops-impl` each get a command for their own seat.
 */
export function freshSeatCommand(logicalId: string, rigName: string): string {
  return `rig seat launch ${logicalId}@${rigName} --fresh --reason "${FRESH_REASON}"`;
}

export interface FreshSeatLaunch { ok: boolean; message: string; guidance?: string }

/** Starts a seat the person accepted at the restore prompt through the same route as the printed command,
 *  for the same reason: a whole-rig restore naming the seat is refused while its siblings run. */
export async function launchFreshSeat(client: DaemonClient, logicalId: string, rigName: string): Promise<FreshSeatLaunch> {
  const ref = `${logicalId}@${rigName}`;
  try {
    const res = await client.post<Record<string, unknown>>(`/api/seat/launch/${encodeURIComponent(ref)}`,
      { fresh: true, reason: FRESH_REASON }, { timeoutMs: 120_000 });
    if (res.status < 400 && res.data["ok"] !== false) return { ok: true, message: `fresh-primed (${String(res.data["sessionName"] ?? ref)})` };
    const guidance = res.data["guidance"];
    // attention_required means a new process may be running, so "not started" would overclaim.
    const outcome = res.data["status"] === "attention_required" ? "needs attention" : "not started";
    return {
      ok: false,
      message: `${outcome} -- ${String(res.data["message"] ?? res.data["error"] ?? `HTTP ${res.status}`)}`,
      ...(typeof guidance === "string" ? { guidance } : {}),
    };
  } catch (err) {
    if (!(err instanceof DaemonTimeoutError)) throw err;
    return { ok: false, message: "outcome unknown -- the launch may still be in progress", guidance: `Check before retrying: rig seat status ${ref}` };
  }
}
