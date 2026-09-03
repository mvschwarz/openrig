import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SeatIdentityVerdict } from "./types.js";

export type PaneBindingObservation =
  | { ok: true; pane: string }
  | {
      ok: false;
      code: "pane_missing" | "pane_ambiguous" | "tmux_unavailable";
      detail: string;
    };

/** Observe the sole pane of one tmux session without mutating either tmux or DB. */
export async function observeSolePane(
  tmux: Pick<TmuxAdapter, "listPanes">,
  sessionName: string,
): Promise<PaneBindingObservation> {
  try {
    const panes = await tmux.listPanes(sessionName);
    if (panes.length === 1) return { ok: true, pane: panes[0]!.id };
    if (panes.length === 0) {
      return {
        ok: false,
        code: "pane_missing",
        detail: `tmux session '${sessionName}' has no attachable pane`,
      };
    }
    return {
      ok: false,
      code: "pane_ambiguous",
      detail: `tmux session '${sessionName}' has ${panes.length} panes; the seat pane is ambiguous`,
    };
  } catch (error) {
    return {
      ok: false,
      code: "tmux_unavailable",
      detail: `tmux pane lookup for '${sessionName}' failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Durable named state for a launch/adopt/refresh ingress that cannot resolve a sole pane. */
export function paneObservationVerdict(input: {
  nodeId: string;
  sessionName: string;
  observation: Exclude<PaneBindingObservation, { ok: true }>;
  observedAt?: string;
}): SeatIdentityVerdict {
  const { observation } = input;
  return {
    nodeId: input.nodeId,
    verdict: observation.code === "pane_ambiguous"
      ? "mismatch"
      : observation.code === "tmux_unavailable"
        ? "tmux_unavailable"
        : "pane_missing",
    evidenceSource: observation.code === "tmux_unavailable" ? null : "tmux_session",
    reason: observation.code === "pane_ambiguous"
      ? "pane_ambiguous"
      : observation.code === "tmux_unavailable"
        ? "tmux_unavailable"
        : "pane_pid_gone",
    evidence: {
      registeredPane: null,
      observedPid: null,
      observedCommand: null,
      matchedLayer: null,
    },
    sessionName: input.sessionName,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}
