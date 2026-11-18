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
  if (ids.length > 0) {
    // A name match must not shadow retained history under the exact id of a
    // deleted rig whose id happens to equal an archived rig's name: check for
    // stored snapshots under the exact id before resolving the name.
    try {
      const kept = await client.get<unknown[]>(`/api/rigs/${encodeURIComponent(handle)}/snapshots`);
      if (kept.status === 200 && Array.isArray(kept.data) && kept.data.length > 0) return { ids: [handle], known: true };
    } catch {
      // History unreadable: the name match resolves, as before.
    }
    return { ids, known: true };
  }
  return { ids: [handle], known: false };
}
