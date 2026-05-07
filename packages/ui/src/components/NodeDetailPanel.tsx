import { useNavigate } from "@tanstack/react-router";
import { useNodeDetail } from "../hooks/useNodeDetail.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import { copyText } from "../lib/copy-text.js";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { LiveIdentityDisplay } from "./LiveIdentityDisplay.js";
import { PreviewPane } from "./preview/PreviewPane.js";

interface NodeDetailPanelProps {
  rigId: string;
  logicalId: string;
  onClose: () => void;
}

function statusColor(status: string | null): string {
  switch (status) {
    case "ready": return "text-green-600";
    case "pending": return "text-amber-600";
    case "attention_required": return "text-orange-600";
    case "failed": return "text-red-600";
    default: return "text-stone-400";
  }
}

function startupStatusLabel(status: string | null): string {
  switch (status) {
    case "attention_required": return "attention required";
    default: return status ?? "stopped";
  }
}

export function NodeDetailPanel({ rigId, logicalId, onClose }: NodeDetailPanelProps) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useNodeDetail(rigId, logicalId);
  const headerName = data?.canonicalSessionName ?? logicalId;

  const handleCopyAttach = async () => {
    if (data?.tmuxAttachCommand) await copyText(data.tmuxAttachCommand);
  };

  const handleOpenCmux = async () => {
    try {
      await fetch(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/open-cmux`, { method: "POST" });
    } catch { /* best-effort */ }
  };

  const handleCopyResume = async () => {
    if (data?.resumeCommand) await copyText(data.resumeCommand);
  };

  return (
    // V1 attempt-3 Phase 5 P5-9 ship-gate bounce P0-2: switch from
    // `absolute inset-y-0 right-0 z-20 w-80` legacy self-pinning (which
    // left ~288px orphan whitespace inside the 38rem drawer because the
    // panel pinned itself to viewport-right with w-80=320px) to
    // `relative w-full h-full` fill-parent. Only production caller is
    // SeatDetailViewer (verified via grep `<NodeDetailPanel`) which mounts
    // inside the canonical 38rem VellumSheet drawer chrome and supplies
    // its own width context. Background + backdrop preserved.
    <aside
      data-testid="node-detail-panel"
      className="relative w-full h-full bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex justify-between items-center px-4 py-3 border-b border-stone-300/35 shrink-0">
        <span className="font-mono text-xs font-bold text-stone-900 truncate">{headerName}</span>
        <button onClick={onClose} className="text-stone-400 hover:text-stone-900 text-sm" data-testid="detail-close">&times;</button>
      </div>

      {isLoading && <div className="p-4 font-mono text-[9px] text-stone-400">Loading...</div>}
      {error && <div className="p-4 font-mono text-[9px] text-red-500">Failed to load node detail</div>}

      {data && (
        <div className="flex-1 overflow-y-auto flex flex-col gap-0">
          {/* Identity */}
          <section className="px-4 py-3 border-b border-stone-100">
            <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Identity</div>
            <div className="space-y-1 font-mono text-[10px]">
              <div className="flex justify-between"><span className="text-stone-500">Rig</span><span className="text-stone-900">{data.rigName}</span></div>
              <div className="flex justify-between"><span className="text-stone-500">Logical ID</span><span className="text-stone-900">{logicalId}</span></div>
              <div className="flex justify-between"><span className="text-stone-500">Pod</span><span className="text-stone-900">{data.podNamespace ?? inferPodName(logicalId) ?? displayPodName(data.podId)}</span></div>
              <div className="flex justify-between"><span className="text-stone-500">Session</span><span className="text-stone-900 truncate ml-2">{data.canonicalSessionName ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-stone-500">Runtime</span><span className="text-stone-900">{data.runtime ?? "—"}</span></div>
              {data.cwd && (
                <div className="flex justify-between"><span className="text-stone-500">CWD</span><span className="text-stone-900 truncate ml-2">{data.cwd}</span></div>
              )}
            </div>
          </section>

          {/* Edges, Peers, Transcript, Compact Spec, Context */}
          {data.peers && (
            <LiveIdentityDisplay
              peers={data.peers}
              edges={data.edges}
              transcript={data.transcript}
              compactSpec={data.compactSpec}
              contextUsage={data.contextUsage}
            />
          )}

          {/* Status */}
          <section className="px-4 py-3 border-b border-stone-100">
            <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Status</div>
            <div className="space-y-1 font-mono text-[10px]">
              <div className="flex justify-between">
                <span className="text-stone-500">Startup</span>
                <span className={statusColor(data.startupStatus)} data-testid="detail-startup-status">{startupStatusLabel(data.startupStatus)}</span>
              </div>
              {/* Restore outcome — prominent */}
              <div className="flex justify-between items-center">
                <span className="text-stone-500">Restore</span>
                <span
                  className={`font-bold text-xs ${getRestoreStatusColorClass(data.restoreOutcome)}`}
                  data-testid="detail-restore-outcome"
                >
                  {data.restoreOutcome}
                </span>
              </div>
              {/* Failure banner with actionable guidance */}
              {(data.startupStatus === "failed" || data.startupStatus === "attention_required" || data.latestError) && (
                <div
                  className={`mt-2 p-2 border ${
                    data.startupStatus === "attention_required"
                      ? "bg-orange-50 border-orange-200"
                      : "bg-red-50 border-red-200"
                  }`}
                  data-testid="detail-failure-banner"
                >
                  <div
                    className={`font-mono text-[9px] font-bold mb-1 ${
                      data.startupStatus === "attention_required" ? "text-orange-700" : "text-red-700"
                    }`}
                  >
                    {data.startupStatus === "attention_required"
                      ? "Attention Required"
                      : data.startupStatus === "failed"
                        ? "Startup Failed"
                        : "Error"}
                  </div>
                  {data.latestError && (
                    <div
                      className={`font-mono text-[9px] mb-1 ${
                        data.startupStatus === "attention_required" ? "text-orange-700" : "text-red-600"
                      }`}
                    >
                      {data.latestError}
                    </div>
                  )}
                  <div className="font-mono text-[8px] text-stone-500">
                    {data.startupStatus === "attention_required"
                      ? `Use rig capture ${data.canonicalSessionName ?? "<session>"} to inspect the prompt, then rig send ${data.canonicalSessionName ?? "<session>"} to clear it.`
                      : data.startupStatus === "failed"
                        ? "Check logs with: rig ps --nodes, or restart with: rig up"
                        : "Try: rig restore <snapshotId>"}
                  </div>
                  {data.recoveryGuidance && (
                    <div className="mt-2 border-t border-stone-200 pt-2" data-testid="detail-recovery-guidance">
                      <div className="font-mono text-[8px] font-bold text-stone-700 mb-1">Recovery</div>
                      <div className="font-mono text-[8px] text-stone-600 mb-1">{data.recoveryGuidance.summary}</div>
                      <div className="space-y-0.5 mb-1">
                        {data.recoveryGuidance.commands.map((command, index) => (
                          <code key={`${command}-${index}`} className="font-mono text-[8px] text-stone-800 bg-stone-100 px-1 py-0.5 block">
                            {command}
                          </code>
                        ))}
                      </div>
                      <div className="space-y-0.5">
                        {data.recoveryGuidance.notes.map((note, index) => (
                          <div key={`${note}-${index}`} className="font-mono text-[8px] text-stone-500">
                            {note}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Preview Terminal v0 (PL-018) — live preview pane */}
          {data.canonicalSessionName && (
            <section className="px-4 py-3 border-b border-stone-100">
              <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Preview</div>
              <PreviewPane
                rigId={rigId}
                rigName={data.rigName}
                logicalId={logicalId}
                testIdPrefix="detail-preview"
              />
            </section>
          )}

          {/* Actions */}
          <section className="px-4 py-3 border-b border-stone-100">
            <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Actions</div>
            <div className="flex flex-col gap-1">
              {data.tmuxAttachCommand && (
                <button onClick={handleCopyAttach} data-testid="detail-copy-attach" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left truncate">
                  Copy tmux attach
                </button>
              )}
              <button onClick={handleOpenCmux} data-testid="detail-cmux-open" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left">
                Open CMUX
              </button>
              {data.resumeCommand && (
                <button onClick={handleCopyResume} data-testid="detail-copy-resume" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left truncate">
                  Copy resume command
                </button>
              )}
              <button
                onClick={() => navigate({ to: "/rigs/$rigId/nodes/$logicalId", params: { rigId, logicalId: encodeURIComponent(logicalId) } })}
                data-testid="detail-open-full"
                className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left font-bold"
              >
                Open Full Details
              </button>
            </div>
          </section>

          {/* Infrastructure startup command */}
          {data.nodeKind === "infrastructure" && data.infrastructureStartupCommand && (
            <section className="px-4 py-3 border-b border-stone-100">
              <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Startup Command</div>
              <code className="font-mono text-[9px] text-stone-700 bg-stone-100 px-2 py-1 block">{data.infrastructureStartupCommand}</code>
            </section>
          )}

          {/* Startup Files */}
          {data.startupFiles.length > 0 && (
            <section className="px-4 py-3 border-b border-stone-100">
              <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Startup Files</div>
              <ol className="list-decimal list-inside space-y-0.5">
                {data.startupFiles.map((f, i) => (
                  <li key={i} className="font-mono text-[9px] text-stone-700 truncate">
                    {f.path} <span className="text-stone-400">({f.deliveryHint})</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Recent Events */}
          {data.recentEvents.length > 0 && (
            <section className="px-4 py-3">
              <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Recent Events</div>
              <div className="space-y-0.5">
                {data.recentEvents.slice(0, 10).map((e, i) => (
                  <div key={i} className="font-mono text-[9px] flex justify-between">
                    <span className="text-stone-700 truncate">{e.type}</span>
                    <span className="text-stone-400 ml-2 shrink-0">{e.createdAt}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
