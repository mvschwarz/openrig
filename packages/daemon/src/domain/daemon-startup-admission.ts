import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { StartupAdmission, type StartupAdmissionSnapshot } from "./startup-admission.js";
import { observeStartupMemory } from "./startup-memory.js";
import { verifyPaneIdleShell } from "./native-process-lineage.js";

/** Install once on the shared adapter; nested launch/restore services must reuse this instance. */
export function daemonStartupAdmission(db: Database.Database, events: EventBus, registry: SessionRegistry, tmux: TmuxAdapter): StartupAdmission {
  return new StartupAdmission({
    observe: observeStartupMemory,
    ownsLifecycle: nodeId => tmux.deliveryGuard?.ownsLifecycle(nodeId) ?? false,
    lifecycle: (nodeId, work) => tmux.deliveryGuard ? tmux.deliveryGuard.lifecycle([nodeId], work) : work(),
    selection: nodeId => JSON.stringify({ generation: registry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
      node: db.prepare("SELECT runtime,model,effort,effort_choice,cwd,codex_config_profile FROM nodes WHERE id=?").get(nodeId),
      binding: registry.getBindingForNode(nodeId) }),
    history: () => {
      const rows = db.prepare(`SELECT e.seq,e.payload FROM events e JOIN
        (SELECT node_id,MAX(seq) seq FROM events WHERE type='node.startup_admission' GROUP BY node_id) l ON e.seq=l.seq`).all() as Array<{seq: number; payload: string}>;
      return rows.map(row => {
        const snapshot = (JSON.parse(row.payload) as { admission: StartupAdmissionSnapshot }).admission;
        return { ...snapshot, ...(snapshot.phase === "starting" ? { dispatchSeq: row.seq } : {}) };
      });
    },
    persist: admission => {
      const node = db.prepare("SELECT rig_id FROM nodes WHERE id=?").get(admission.nodeId) as { rig_id: string } | undefined;
      if (!node) throw new Error("The startup seat no longer exists");
      return events.emit({ type: "node.startup_admission", rigId: node.rig_id, nodeId: admission.nodeId, admission }).seq;
    },
    reconcile: async snapshot => {
      const binding = registry.getBindingForNode(snapshot.nodeId);
      const targets = snapshot.nativeTargets?.length ? snapshot.nativeTargets : [snapshot.nativeTarget ?? binding?.tmuxSession].filter((value): value is string => Boolean(value));
      if (!targets.length) return "unknown";
      // Ready evidence must be newer than this actual dispatch, never the previous occupant's ready bit.
      if (snapshot.dispatchSeq !== undefined) {
        const ready = db.prepare("SELECT 1 FROM events WHERE node_id=? AND type='node.startup_ready' AND seq>? LIMIT 1")
          .get(snapshot.nodeId, snapshot.dispatchSeq);
        if (ready && !snapshot.kind.includes("successor") && snapshot.kind !== "in-place restart") return "ready";
      }
      if (tmux.probeSession) {
        for (const target of targets) {
          const probe = await tmux.probeSession(target);
          if (probe.state === "absent") continue;
          if (probe.state !== "present") return "unknown";
          if (!await verifyPaneIdleShell({ target, tmux })) return "live";
        }
        return "absent";
      }
      return "unknown";
    },
  });
}
