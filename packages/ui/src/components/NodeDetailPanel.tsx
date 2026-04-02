import { useNodeDetail } from "../hooks/useNodeDetail.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import { copyText } from "../lib/copy-text.js";
import { displayPodName, inferPodName } from "../lib/display-name.js";

interface NodeDetailPanelProps {
  rigId: string;
  logicalId: string;
  onClose: () => void;
}

function statusColor(status: string | null): string {
  switch (status) {
    case "ready": return "text-green-600";
    case "pending": return "text-amber-600";
    case "failed": return "text-red-600";
    default: return "text-stone-400";
  }
}

export function NodeDetailPanel({ rigId, logicalId, onClose }: NodeDetailPanelProps) {
  const { data, isLoading, error } = useNodeDetail(rigId, logicalId);
  const headerName = data?.canonicalSessionName ?? logicalId;

  const handleCopyAttach = async () => {
    if (data?.tmuxAttachCommand) await copyText(data.tmuxAttachCommand);
  };

  const handleFocusCmux = async () => {
    try {
      await fetch(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/focus`, { method: "POST" });
    } catch { /* best-effort */ }
  };

  const handleCopyResume = async () => {
    if (data?.resumeCommand) await copyText(data.resumeCommand);
  };

  return (
    <aside
      data-testid="node-detail-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-stone-300/25 bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
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
              <div className="flex justify-between"><span className="text-stone-500">Pod</span><span className="text-stone-900">{inferPodName(logicalId) ?? displayPodName(data.podId)}</span></div>
              <div className="flex justify-between"><span className="text-stone-500">Runtime</span><span className="text-stone-900">{data.runtime ?? "—"}</span></div>
              {data.nodeKind !== "infrastructure" && (
                <>
                  <div className="flex justify-between"><span className="text-stone-500">Agent Spec</span><span className="text-stone-900">{data.resolvedSpecName ?? "—"}</span></div>
                  <div className="flex justify-between"><span className="text-stone-500">Profile</span><span className="text-stone-900">{data.profile ?? "—"}</span></div>
                </>
              )}
            </div>
          </section>

          {/* Status */}
          <section className="px-4 py-3 border-b border-stone-100">
            <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Status</div>
            <div className="space-y-1 font-mono text-[10px]">
              <div className="flex justify-between">
                <span className="text-stone-500">Startup</span>
                <span className={statusColor(data.startupStatus)} data-testid="detail-startup-status">{data.startupStatus ?? "stopped"}</span>
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
              {(data.startupStatus === "failed" || data.latestError) && (
                <div className="mt-2 p-2 bg-red-50 border border-red-200" data-testid="detail-failure-banner">
                  <div className="font-mono text-[9px] text-red-700 font-bold mb-1">
                    {data.startupStatus === "failed" ? "Startup Failed" : "Error"}
                  </div>
                  {data.latestError && (
                    <div className="font-mono text-[9px] text-red-600 mb-1">{data.latestError}</div>
                  )}
                  <div className="font-mono text-[8px] text-stone-500">
                    {data.startupStatus === "failed"
                      ? "Check logs with: rigged ps --nodes, or restart with: rigged up"
                      : "Try: rigged restore <snapshotId>"}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Actions */}
          <section className="px-4 py-3 border-b border-stone-100">
            <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Actions</div>
            <div className="flex flex-col gap-1">
              {data.tmuxAttachCommand && (
                <button onClick={handleCopyAttach} data-testid="detail-copy-attach" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left truncate">
                  Copy tmux attach
                </button>
              )}
              <button onClick={handleFocusCmux} data-testid="detail-cmux-focus" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left">
                Open in cmux
              </button>
              {data.resumeCommand && (
                <button onClick={handleCopyResume} data-testid="detail-copy-resume" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left truncate">
                  Copy resume command
                </button>
              )}
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
