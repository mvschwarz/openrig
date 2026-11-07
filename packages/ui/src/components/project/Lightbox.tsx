// The LIVE image lightbox (extracted verbatim from ProofTab for reuse by the
// Review surface — OPR.0.4.4.20 FR-11 item 2). This is the one image-viewer
// family; the unmounted ProofImageViewer / TestsVerificationTab viewer /
// DocsTab remain dead code and are deliberately NOT resurrected.

export function Lightbox({ src, alt, onClose }: { src: string | null; alt: string; onClose: () => void }) {
  if (!src) return null;
  return (
    <div
      role="dialog"
      aria-label="Proof capture preview"
      data-testid="proof-lightbox"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-stone-950/40 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div className="max-h-full max-w-[92vw] border border-white/20 bg-stone-950/70 p-2" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} data-testid="proof-lightbox-image" className="max-h-[80vh] max-w-full object-contain" />
        <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[11px] text-stone-50">
          <span className="truncate">{alt}</span>
          <button
            type="button"
            data-testid="proof-lightbox-close"
            onClick={onClose}
            className="border border-white/30 px-2 py-0.5 hover:bg-white/10"
            aria-label="Close preview"
          >
            close
          </button>
        </div>
      </div>
    </div>
  );
}
