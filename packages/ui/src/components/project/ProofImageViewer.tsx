import { X } from "lucide-react";
import { proofAssetUrl } from "../../hooks/useSlices.js";

export function ProofImageViewer({
  sliceName,
  relPath,
  onClose,
  testId = "proof-image-viewer",
  imageTestId = "proof-image-viewer-image",
  closeTestId = "proof-image-viewer-close",
}: {
  sliceName: string;
  relPath: string | null;
  onClose: () => void;
  testId?: string;
  imageTestId?: string;
  closeTestId?: string;
}) {
  if (!relPath) return null;
  return (
    <div
      role="dialog"
      aria-label="Screenshot preview"
      data-testid={testId}
      className="fixed bottom-0 right-0 top-14 z-[1000] flex items-center justify-center bg-stone-950/20 p-6 backdrop-blur-[2px] lg:left-[21rem]"
      onClick={onClose}
    >
      <div
        className="max-h-full max-w-[92vw] border border-white/20 bg-stone-950/70 p-2 backdrop-blur-sm"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={proofAssetUrl(sliceName, relPath)}
          alt={relPath}
          data-testid={imageTestId}
          className="max-h-[78vh] max-w-full object-contain"
        />
        <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] text-stone-50">
          <span className="truncate">{relPath}</span>
          <button
            type="button"
            data-testid={closeTestId}
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center border border-white/30 text-stone-50 hover:bg-white/10"
            aria-label="Close screenshot preview"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
