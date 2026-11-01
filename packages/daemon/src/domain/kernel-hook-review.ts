import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { resolveCurrentSessionAddress } from "./session-registry.js";
import { assessNativeResumeProbe } from "./native-resume-probe.js";

export interface HookReviewObservation {
  destination: string;
  episode: string;
  state: "blocked" | "clear" | "unknown";
  observedAt: string;
}

/** Read-only, visible-screen evidence for the selected kernel Codex case. No stored
 * startup error, generic attention flag or scrollback can start an alert. */
export function makeKernelHookReviewReader(deps: {
  db: Database.Database;
  tmux: Pick<TmuxAdapter, "listPanes" | "readAllPaneProcesses" | "capturePaneScreen">;
  now?: () => Date;
}): () => Promise<HookReviewObservation[]> {
  return async () => {
    const rows = deps.db.prepare(`SELECT b.id AS bindingId, b.node_id AS nodeId, b.tmux_session AS destination,
        b.tmux_pane AS pane, s.id AS sessionId
      FROM bindings b JOIN nodes n ON n.id = b.node_id JOIN rigs r ON r.id = n.rig_id
      JOIN sessions s ON s.node_id = n.id AND s.session_name = b.tmux_session
      WHERE r.name = 'kernel' AND n.runtime = 'codex' AND r.archived_at IS NULL AND b.attachment_type = 'tmux'
        AND b.tmux_pane IS NOT NULL AND s.id = (SELECT latest.id FROM sessions latest
          WHERE latest.node_id = n.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
        AND s.status NOT IN ('stopped','exited','detached','superseded')`).all() as Array<{
          bindingId: string; nodeId: string; destination: string; pane: string; sessionId: string;
        }>;
    const observations: HookReviewObservation[] = [];
    for (const row of rows) {
      let state: HookReviewObservation["state"] = "unknown";
      let pid: number | null = null;
      try {
        const owner = resolveCurrentSessionAddress(deps.db, row.destination);
        if (owner?.nodeId !== row.nodeId || owner.sessionId !== row.sessionId) throw new Error("not a current unambiguous binding");
        const before = await deps.tmux.listPanes(row.destination, true);
        if (before.some(p => p.id === row.pane)) {
          const process = (await deps.tmux.readAllPaneProcesses())?.get(row.pane);
          pid = process?.pid ?? null;
          if (!pid || process?.dead !== false || process.command !== "codex") throw new Error("native pane is not positively live Codex");
          const screen = await deps.tmux.capturePaneScreen(row.pane);
          const after = await deps.tmux.listPanes(row.destination, true);
          const current = deps.db.prepare("SELECT id, tmux_session, tmux_pane FROM bindings WHERE node_id = ?").get(row.nodeId) as
            { id: string; tmux_session: string; tmux_pane: string } | undefined;
          const session = resolveCurrentSessionAddress(deps.db, row.destination);
          const currentProcess = (await deps.tmux.readAllPaneProcesses())?.get(row.pane);
          if (currentProcess?.pid === pid && currentProcess.dead === false && currentProcess.command === "codex" && after.some(p => p.id === row.pane)
            && current?.id === row.bindingId && current.tmux_session === row.destination && current.tmux_pane === row.pane
            && session?.sessionId === row.sessionId && session.nodeId === row.nodeId && screen !== null) {
            const probe = assessNativeResumeProbe({ runtime: "codex", paneCommand: currentProcess.command, paneContent: screen });
            state = probe.code === "hook_trust_gate" ? "blocked" : probe.status === "resumed" ? "clear" : "unknown";
          }
        }
      } catch { /* Unavailable or changed observations neither ask nor resolve. */ }
      observations.push({ destination: row.destination, episode: `${row.bindingId}:${row.sessionId}:${row.pane}:${pid ?? "unknown"}`,
        state, observedAt: (deps.now ?? (() => new Date()))().toISOString() });
    }
    return observations;
  };
}
