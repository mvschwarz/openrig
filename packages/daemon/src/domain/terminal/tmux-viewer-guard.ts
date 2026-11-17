/** Values admitted into tmux's format and nested-command grammars, not shell text. */
export interface TmuxViewerIdentity {
  sessionId: string;
  sessionName: string;
  nonce: string;
  windowIds: readonly string[];
  paneIds: readonly string[];
  /** Encoded original proof, when session-option ownership is used. */
  proof?: string;
}

export const TMUX_VIEWER_PROOF_OPTION = "@openrig_rig_viewer_proof";
export interface TmuxViewerProof extends TmuxViewerIdentity { view: string; endpoint: string }

/** One complete option plus the nonce marker. Partial writes grant no close authority. */
export function encodeTmuxViewerProof(viewer: TmuxViewerProof): string {
  return Buffer.from(JSON.stringify({ version: 1, sessionId: viewer.sessionId, sessionName: viewer.sessionName,
    nonce: viewer.nonce, windowIds: viewer.windowIds, paneIds: viewer.paneIds, view: viewer.view, endpoint: viewer.endpoint })).toString("base64url");
}

export function parseTmuxViewerProof(proof: string): TmuxViewerProof | null {
  if (!/^[A-Za-z0-9_-]+$/.test(proof) || proof.length > 32768) return null;
  try {
    const value = JSON.parse(Buffer.from(proof, "base64url").toString("utf8"));
    if (!value || value.version !== 1 || typeof value.sessionId !== "string" || typeof value.sessionName !== "string"
      || typeof value.nonce !== "string" || !Array.isArray(value.windowIds) || !Array.isArray(value.paneIds)
      || !value.windowIds.every((id: unknown) => typeof id === "string") || !value.paneIds.every((id: unknown) => typeof id === "string")
      || typeof value.view !== "string" || !/^rig:.+/.test(value.view) || /[\x00-\x1f\x7f]/.test(value.view)
      || typeof value.endpoint !== "string" || !value.endpoint.startsWith("tmux:") || !qualifiesTmuxViewer(value)) return null;
    return { sessionId: value.sessionId, sessionName: value.sessionName, nonce: value.nonce,
      windowIds: value.windowIds, paneIds: value.paneIds, view: value.view, endpoint: value.endpoint, proof };
  } catch { return null; }
}

const safeText = (value: string) => value.length > 0 && !/[^A-Za-z0-9_.:-]/.test(value);
const ids = (values: readonly string[], pattern: RegExp) => values.length > 0
  && new Set(values).size === values.length && values.every(value => pattern.test(value) && !/\s/.test(value));

export function qualifiesTmuxViewer(viewer: TmuxViewerIdentity): boolean {
  return /^\$[0-9]+$/.test(viewer.sessionId) && !/\s/.test(viewer.sessionId) && safeText(viewer.sessionName)
    && safeText(viewer.nonce) && ids(viewer.windowIds, /^@[0-9]+$/) && ids(viewer.paneIds, /^%[0-9]+$/);
}

const windows = "#{W:#{window_id};}";
const panes = "#{W:#{P:#{pane_id};}}";
export const TMUX_VIEWER_SNAPSHOT = `#{session_id}|#{session_name}|#{@openrig_rig_viewer}|${windows}|${panes}|#{session_attached}`;
export const TMUX_VIEWER_OPTION_SNAPSHOT = `${TMUX_VIEWER_SNAPSHOT}|#{${TMUX_VIEWER_PROOF_OPTION}}`;
export const TMUX_VIEWER_KEPT = "openrig-viewer-kept";

/** A snapshot is useful only if it still describes exactly the recorded viewer. */
export function tmuxViewerCloseArgs(viewer: TmuxViewerIdentity, snapshot: string, requireDetached = false): string[] | null {
  if (!qualifiesTmuxViewer(viewer)) return null;
  const fields = snapshot.trim().split("|");
  if (fields.length !== (viewer.proof === undefined ? 6 : 7)) return null;
  if (viewer.proof !== undefined && (!/^[A-Za-z0-9_-]+$/.test(viewer.proof) || fields[6] !== viewer.proof)) return null;
  const [sessionId, sessionName, nonce, windowList, paneList, attached] = fields as [string, string, string, string, string, string];
  if (sessionId !== viewer.sessionId || sessionName !== viewer.sessionName || nonce !== viewer.nonce
    || !/^(?:@[0-9]+;)+$/.test(windowList) || !/^(?:%[0-9]+;)+$/.test(paneList)
    || !/^[0-9]+$/.test(attached) || (requireDetached && attached !== "0")) return null;
  const equal = (text: string, expected: readonly string[]) => {
    const values = text.slice(0, -1).split(";");
    return values.length === expected.length && new Set(values).size === values.length && values.every(id => expected.includes(id));
  };
  if (!equal(windowList, viewer.windowIds) || !equal(paneList, viewer.paneIds)) return null;
  const checks = [
    `#{==:#{session_id},${sessionId}}`,
    `#{==:#{session_name},${sessionName}}`,
    `#{==:#{@openrig_rig_viewer},${nonce}}`,
    `#{==:${windows},${windowList}}`,
    `#{==:${panes},${paneList}}`,
    ...(viewer.proof === undefined ? [] : [`#{==:#{${TMUX_VIEWER_PROOF_OPTION}},${viewer.proof}}`]),
    ...(requireDetached ? ["#{==:#{session_attached},0}"] : []),
  ];
  const condition = checks.reduce((left, right) => `#{&&:${left},${right}}`);
  // -F chooses the next command on tmux's own queue, without a shell job.
  return ["if-shell", "-F", "-t", sessionId, condition, `kill-session -t '${sessionId}'`, `display-message -p ${TMUX_VIEWER_KEPT}`];
}
