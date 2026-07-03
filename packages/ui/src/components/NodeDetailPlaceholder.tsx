/**
 * Placeholder detail panel — proves selection wiring for NS-T10.
 * NS-T11 replaces this with the full NodeDetailPanel.
 */
export function NodeDetailPlaceholder({ rigId, logicalId, onClose }: {
  rigId: string;
  logicalId: string;
  onClose: () => void;
}) {
  const handleFocus = async () => {
    try {
      await fetch(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/focus`, {
        method: "POST",
      });
    } catch { /* best-effort */ }
  };

  return (
    <div
      data-testid="node-detail-placeholder"
      className="w-72 border-l border-outline-variant bg-background p-4 flex flex-col gap-3 shrink-0"
    >
      <div className="flex justify-between items-center">
        <span className="font-mono text-xs font-bold text-on-surface uppercase">{logicalId}</span>
        <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface text-sm">&times;</button>
      </div>
      <div className="font-mono text-[9px] text-on-surface-variant">
        Rig: {rigId}
      </div>
      <button
        onClick={handleFocus}
        data-testid="focus-cmux"
        className="px-3 py-1.5 border border-outline-variant font-mono text-[9px] uppercase hover:bg-surface-high transition-colors"
      >
        Focus in cmux
      </button>
      <div className="font-mono text-[8px] text-on-surface-variant mt-auto">
        Full detail panel in NS-T11
      </div>
    </div>
  );
}
