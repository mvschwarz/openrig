import type { AttentionItem, AttentionRead } from "@openrig/daemon/attention";

/** The aggregate's declared dependencies, not a classification of queue intent. */
function dependsOn(item: AttentionItem, source: string): boolean {
  if (source === "queue") return item.id.startsWith("queue:");
  if (source === "queue updates") return item.id.startsWith("queue-update:");
  if (source === "health") return item.id.startsWith("health:");
  if (source === "mission outcomes") return item.id.startsWith("workflow:");
  if (source === "project catalog") return item.id.startsWith("proof:") || item.id.startsWith("workflow:");
  if (!item.id.startsWith("proof:") || !item.project) return false;
  const project = `proof: project ${item.project.id}`;
  if (source === project) return true;
  if (!source.startsWith(project + "/")) return false;
  const [mission, slice] = source.slice(project.length + 1).split("/");
  return item.id.startsWith(`proof:${item.project.id}:${mission}/${slice ? `slices/${slice}:` : ""}`);
}

/** Merge only unavailable dependencies. A successful empty or bounded partial
 * window is a new answer and must remove old items. The caller owns page scope. */
export function retainAttentionSources(read: AttentionRead, prior?: AttentionRead) {
  const failed = read.sources.filter(s => s.state === "unavailable");
  const affected = (item: AttentionItem) => failed.some(s => dependsOn(item, s.source));
  // An unavailable aggregate can still supply fresh items from its working readers.
  const currentIds = new Set(read.items.map(item => item.id));
  const retained = prior?.items.filter(item => affected(item) && !currentIds.has(item.id)) ?? [];
  const detail = !read.detail && prior?.detail && affected(prior.detail.item) ? prior.detail : null;
  const didRetain = retained.length > 0 || detail !== null;
  return {
    read: !prior || !failed.length ? read : { ...read,
      items: [...read.items, ...retained],
      ...(detail ? { detail, detailError: null } : {}),
    },
    errors: failed.map(s => `Feed ${s.source}: ${s.detail}`),
    retained: didRetain,
  };
}
