import type { DaemonClient } from "./client.js";

/** Snapshot history follows a name across archived identities; an exact id stays scoped to that id. */
export async function snapshotRigIds(
  client: DaemonClient,
  handle: string,
): Promise<{ ids: string[]; known: boolean }> {
  let rigs: Array<{ id: string; name: string }>;
  try {
    const res = await client.get<Array<{ id: string; name: string }>>("/api/rigs/summary?includeArchived=true");
    if (res.status !== 200 || !Array.isArray(res.data)) return { ids: [handle], known: true };
    rigs = res.data;
  } catch {
    // Preserve the existing exact-id path when the summary is unavailable.
    return { ids: [handle], known: true };
  }
  if (rigs.some((rig) => rig.id === handle)) return { ids: [handle], known: true };
  const ids = rigs.filter((rig) => rig.name === handle).map((rig) => rig.id);
  // Deleted rigs can still have snapshots stored under their exact id.
  return ids.length > 0 ? { ids, known: true } : { ids: [handle], known: false };
}
