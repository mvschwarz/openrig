// Preview Terminal v0 (PL-018) — single-seat live terminal preview pane.
//
// Renders the seat's last N lines via /api/.../preview, auto-refreshing
// at the operator-configured interval. Includes a Pin / Unpin button +
// honest "preview unavailable" fallback when the daemon doesn't have
// the route or the session is unbound.

import { useNodePreview, isNodePreviewUnavailable } from "../../hooks/useNodePreview.js";
import { usePreviewPins } from "./usePreviewPins.js";

interface PreviewPaneProps {
  rigId: string;
  rigName?: string;
  logicalId: string;
  /** Optional: override line count from settings. */
  lines?: number;
  /** Pause polling — useful for collapsed/hidden parents. */
  paused?: boolean;
  /** Opt out of the Pin button (e.g., when shown inside the Pinned stack). */
  hidePinButton?: boolean;
  /** When set, preview shrinks to a compact density. */
  compact?: boolean;
  testIdPrefix?: string;
}

export function PreviewPane({
  rigId,
  rigName,
  logicalId,
  lines,
  paused,
  hidePinButton,
  compact,
  testIdPrefix = "preview",
}: PreviewPaneProps) {
  const preview = useNodePreview({ rigId, logicalId, lines, paused });
  const { isPinned, pin, unpin } = usePreviewPins();

  const pinned = isPinned(rigId, logicalId);
  const onTogglePin = () => {
    if (pinned) {
      unpin(rigId, logicalId);
    } else {
      const sessionName = !isNodePreviewUnavailable(preview.data) ? preview.data?.sessionName ?? "" : "";
      pin({ rigId, rigName: rigName ?? rigId, logicalId, sessionName });
    }
  };

  const heightClass = compact ? "max-h-32" : "max-h-64";

  return (
    <div
      data-testid={`${testIdPrefix}-pane`}
      data-rig-id={rigId}
      data-logical-id={logicalId}
      data-paused={paused ? "true" : "false"}
      className="border border-stone-300/40 bg-white/8 px-3 py-2 space-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500 truncate">
          live preview · {logicalId}
        </span>
        {!hidePinButton && (
          <button
            type="button"
            data-testid={`${testIdPrefix}-pin-toggle`}
            data-pinned={pinned ? "true" : "false"}
            onClick={onTogglePin}
            className="font-mono text-[8px] uppercase border border-stone-300 px-1 py-0.5 hover:bg-stone-200 shrink-0"
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        )}
      </div>

      {preview.isLoading && (
        <div data-testid={`${testIdPrefix}-loading`} className="font-mono text-[9px] text-stone-400">Loading…</div>
      )}
      {preview.isError && (
        <div data-testid={`${testIdPrefix}-error`} className="font-mono text-[9px] text-red-600">
          {(preview.error as Error)?.message ?? "Preview failed."}
        </div>
      )}
      {isNodePreviewUnavailable(preview.data) && (
        <div data-testid={`${testIdPrefix}-unavailable`} className="font-mono text-[9px] text-stone-500 space-y-0.5">
          <div>Preview unavailable: {preview.data.reason}.</div>
          {preview.data.hint && <div className="text-stone-400">{preview.data.hint}</div>}
          <div className="text-stone-400">Use <code>rig capture {logicalId}</code> from terminal as a fallback.</div>
        </div>
      )}
      {!isNodePreviewUnavailable(preview.data) && preview.data && (
        <>
          <pre
            data-testid={`${testIdPrefix}-content`}
            className={`font-mono text-[9px] text-stone-800 bg-stone-50 px-2 py-1 ${heightClass} overflow-y-auto whitespace-pre-wrap break-all`}
          >
            {preview.data.content || "(empty pane)"}
          </pre>
          <div className="font-mono text-[8px] text-stone-400 flex justify-between">
            <span>captured {new Date(preview.data.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span>{preview.data.lines} lines</span>
          </div>
        </>
      )}
    </div>
  );
}
