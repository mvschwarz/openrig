// Slice 18 — Undo toast for For-You per-card dismiss flow.
//
// Single-action transient surface: shows a label + Undo button for
// a fixed window. Clicking Undo fires onUndo and suppresses the
// pending expire callback. If the window elapses without click,
// onExpire fires once and the toast caller is expected to unmount.

import { useEffect, useRef } from "react";

export interface UndoToastProps {
  label: string;
  onUndo: () => void;
  onExpire: () => void;
  durationMs: number;
}

export function UndoToast({ label, onUndo, onExpire, durationMs }: UndoToastProps) {
  const consumedRef = useRef(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (consumedRef.current) return;
      consumedRef.current = true;
      onExpire();
    }, durationMs);
    return () => window.clearTimeout(handle);
  }, [durationMs, onExpire]);

  const handleUndo = () => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    onUndo();
  };

  return (
    <div
      data-testid="undo-toast"
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 border border-stone-700 bg-stone-900/95 px-4 py-2 font-mono text-[11px] uppercase tracking-wide text-stone-50 backdrop-blur-sm shadow-lg"
    >
      <span>{label}</span>
      <button
        type="button"
        data-testid="undo-toast-button"
        onClick={handleUndo}
        className="border border-stone-500 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-stone-50 hover:bg-stone-800 focus:outline-none focus:ring-1 focus:ring-stone-300"
      >
        Undo
      </button>
    </div>
  );
}
