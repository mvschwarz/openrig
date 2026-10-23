import { createHash } from "node:crypto";
import type { TmuxAdapter, TmuxPane } from "../adapters/tmux.js";
import type { NativeResumeProbeResult } from "./native-resume-probe.js";

const GEOMETRY_TIMEOUT_MS = 250;

/** Bounded metadata from the exact capture assessed by the probe; never its text or detail. */
export interface NativeResumeProbeEvidence {
  status: NativeResumeProbeResult["status"];
  code: string;
  loginRefusal?: NonNullable<NativeResumeProbeResult["loginRefusal"]>;
  capture: {
    lines: number;
    bytes: number;
    sha256: string;
    /** Geometry observed after the capture; null when unavailable within the diagnostic deadline. */
    columns: number | null;
    rows: number | null;
  };
}

/** Read geometry best-effort, without re-capturing or changing the probe's decision. */
export async function resumeProbeEvidence(
  probe: NativeResumeProbeResult,
  content: string,
  tmux: Pick<TmuxAdapter, "listPanes">,
  target: string,
): Promise<NativeResumeProbeEvidence> {
  let columns: number | null = null;
  let rows: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const dimension = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0 ? value! : null;
  try {
    // Geometry is optional: a stuck tmux read must not hold up an already-decided failure or its event.
    const panes = await Promise.race([
      tmux.listPanes(target),
      new Promise<TmuxPane[]>(resolve => { timeout = setTimeout(() => resolve([]), GEOMETRY_TIMEOUT_MS); }),
    ]);
    const pane = /^%\d+$/.test(target) ? panes.find(pane => pane.id === target) : panes.length === 1 ? panes[0] : undefined;
    columns = dimension(pane?.width);
    rows = dimension(pane?.height);
  } catch { /* Diagnostics must not replace the original failure when geometry is unavailable. */ }
  finally { if (timeout !== undefined) clearTimeout(timeout); }
  return {
    status: probe.status,
    code: probe.code,
    ...(probe.loginRefusal ? { loginRefusal: probe.loginRefusal } : {}),
    capture: {
      lines: content.length ? content.split(/\r?\n/).length : 0,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      columns,
      rows,
    },
  };
}
