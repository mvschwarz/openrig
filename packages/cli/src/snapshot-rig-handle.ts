import type { DaemonClient } from "./client.js";

/** Snapshot history follows a name across archived identities; an exact id stays scoped to that id.
 *  `unreadable` is set when retained history under an exact id could not be
 *  read: callers must STOP and report it — silently resolving the name instead
 *  could list or restore another rig's history under this handle. */
export interface SnapshotRigIds {
  ids: string[];
  known: boolean;
  unreadable?: string;
}

export async function snapshotRigIds(
  client: DaemonClient,
  handle: string,
): Promise<SnapshotRigIds> {
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
    // URL normalization removes literal dot segments; these names need their resolved database ids.
    if (handle === "." || handle === "..") return { ids, known: true };
    // A name match must not shadow retained history under the exact id of a
    // deleted rig whose id happens to equal an archived rig's name: check for
    // stored snapshots under the exact id before resolving the name.
    let kept: Awaited<ReturnType<typeof client.get>>;
    try {
      kept = await client.get<unknown[]>(`/api/rigs/${encodeURIComponent(handle)}/snapshots`);
    } catch (err) {
      return { ids, known: true, unreadable: `retained history under id "${handle}" could not be read (${(err as Error).message})` };
    }
    if (kept.status !== 200) {
      return { ids, known: true, unreadable: `retained history under id "${handle}" could not be read (HTTP ${kept.status})` };
    }
    if (Array.isArray(kept.data) && kept.data.length > 0) return { ids: [handle], known: true };
    return { ids, known: true };
  }
  return { ids: [handle], known: false };
}
