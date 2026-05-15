// Scattered floating text marks used in the mid + top layers.
//
// FloatingTopMarks: tiny floating top-layer annotations — sparse, fine,
// crisp. The "random pieces of text" glitch-artifact feel.
//
// ScatteredMarks: mid-tier scattered marks, slightly larger; sit on
// layer 2 (between the back vellum sheet and the destination cards).

export function FloatingTopMarks() {
  // top-[28%] left-[28%] [?] removed iter 32 — was covering the
  // TOPOLOGY card's tree diagram. Remaining marks keep the scattered
  // glitch-artifact feel.
  const marks: Array<{ pos: string; text: string; size?: string }> = [
    { pos: "top-[18%] left-[36%]", text: "▪ 03°", size: "text-[10px]" },
    { pos: "top-[24%] right-[34%]", text: "**", size: "text-base" },
    { pos: "top-[44%] left-[44%]", text: "+", size: "text-sm" },
    { pos: "top-[52%] right-[36%]", text: "(A)", size: "text-[10px]" },
    { pos: "bottom-[34%] left-[20%]", text: "[?]", size: "text-sm" },
    { pos: "bottom-[42%] right-[24%]", text: "▪ 06°", size: "text-[10px]" },
    { pos: "bottom-[18%] left-[58%]", text: "+", size: "text-sm" },
  ];
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={i}
          className={`absolute ${m.pos} ${m.size ?? "text-xs"} font-mono text-stone-900 leading-none`}
        >
          {m.text}
        </span>
      ))}
    </>
  );
}

interface ScatteredMarksProps {
  tier?: "mid" | "back";
}

export function ScatteredMarks({ tier = "mid" }: ScatteredMarksProps) {
  const sizeBase = tier === "mid" ? "text-base" : "text-2xl";
  const marks: Array<{ pos: string; text: string }> = [
    { pos: "top-[22%] left-[58%]", text: "■ 03°" },
    { pos: "top-[60%] left-[18%]", text: "+" },
    { pos: "bottom-[26%] right-[40%]", text: "■ 06°" },
    { pos: "top-[68%] right-[22%]", text: "▣" },
    { pos: "top-[72%] left-[8%]", text: "**" },
    { pos: "top-[86%] right-[5%]", text: "(A)" },
  ];
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={i}
          className={`absolute ${m.pos} ${sizeBase} font-mono text-stone-900 leading-none`}
        >
          {m.text}
        </span>
      ))}
    </>
  );
}
