// L-shaped 90° corner bracket. Used at each of the 4 corners of a
// destination card to register the card's bounding box (print/CAD
// register marks). The "L" leg lengths are ~10px at a 10×10 viewBox;
// the bracket faces inward so the corner-of-the-L hugs the card's
// outer corner.

interface CornerBracketProps {
  position: "tl" | "tr" | "bl" | "br";
}

export function CornerBracket({ position }: CornerBracketProps) {
  const positionClass = {
    tl: "top-1.5 left-1.5",
    tr: "top-1.5 right-1.5",
    bl: "bottom-1.5 left-1.5",
    br: "bottom-1.5 right-1.5",
  }[position];
  const path = {
    tl: "M 10 0 L 0 0 L 0 10",
    tr: "M 0 0 L 10 0 L 10 10",
    bl: "M 0 0 L 0 10 L 10 10",
    br: "M 10 0 L 10 10 L 0 10",
  }[position];
  return (
    <svg
      className={`absolute ${positionClass} w-2.5 h-2.5 text-stone-900 pointer-events-none select-none`}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <path d={path} />
    </svg>
  );
}
