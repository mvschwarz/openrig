// LAYER 1 — back vellum sheet.
//
// Small stagger (12–16px) inset off the page edges so the back layer
// just barely peeks out around the vellum edges. The eye sees sharp
// black content at the page edge, then the SAME content blurred behind
// the vellum a few pixels inward — that thin sharp→blurred transition
// completes the "object behind paper" trick without sacrificing sheet
// width. Asymmetric per side for hand-placed feel.
//
// Flat bg-white/40 + backdrop-blur-[20px] per founder pick. The visual
// gradient appears naturally from the back-content blur showing through
// unevenly.

export function BackVellumSheet() {
  return (
    <div
      data-testid="back-vellum-sheet"
      aria-hidden="true"
      className="absolute top-[14px] bottom-[12px] left-[16px] right-[14px] z-[5] bg-white/40 backdrop-blur-[20px] pointer-events-none"
    />
  );
}
