// LAYER 0 — back content (bold black, full bleed).
//
// BOLD BLACK at 100% alpha. Full-bleed asymmetric placement. The eye
// reads these as "deep blurred background" only because the back vellum
// sheet sits over them — never use opacity to fake the fade.
//
// hostname surfaces in two places (OPERATOR block + bottom serial code
// line) so production reads the live host while the lab default keeps
// 127.0.0.1.

interface BackLayerContentProps {
  hostname?: string;
}

export function BackLayerContent({ hostname = "127.0.0.1" }: BackLayerContentProps = {}) {
  return (
    <div
      data-testid="back-layer"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
    >
      {/* OPERATOR — full bleed left edge */}
      <div className="absolute top-[14%] -left-12 font-mono text-[9rem] leading-[0.85] tracking-[-0.02em] font-black text-stone-900 whitespace-pre">
        {`OPERATOR\n04°·LIVE\n${hostname}`}
      </div>

      {/* RIG·OS(s*) — full bleed right edge, balances OPERATOR */}
      <div className="absolute top-[42%] -right-10 font-headline font-black text-[14rem] leading-[0.82] tracking-[-0.06em] text-stone-900 whitespace-nowrap">
        RIG·OS<sup className="text-[6rem] tracking-[-0.04em] align-super">(s*)</sup>
      </div>

      {/* 07/?? massive numeral — top-right anchor */}
      <div className="absolute top-[4%] right-[8%] font-headline font-black text-[12rem] leading-none tracking-[-0.06em] text-stone-900">
        07/??
      </div>

      {/* ■ 04° massive mark — mid */}
      <div className="absolute top-[58%] left-[36%] font-headline font-black text-[7rem] leading-none tracking-[-0.04em] text-stone-900">
        ■ 04°
      </div>

      {/* VII Roman numeral — left of center */}
      <div className="absolute top-[6%] left-[42%] font-headline font-black italic text-[9rem] leading-none tracking-[-0.06em] text-stone-900">
        VII
      </div>

      {/* PHOBOS® — full bleed bottom-right */}
      <div className="absolute -bottom-6 -right-2 font-headline font-black text-[9rem] leading-none tracking-[-0.06em] text-stone-900 uppercase">
        Phobos®
      </div>

      {/* OS·Ø stacked massive letterforms — back of back, mid-canvas */}
      <div className="absolute top-[28%] left-[8%] font-headline font-black text-[24rem] leading-[0.8] tracking-[-0.06em] text-stone-900 uppercase whitespace-pre">
        {`OS·\nØ`}
      </div>

      {/* Ⅸ Roman numeral atmospheric mid-bottom */}
      <div className="absolute bottom-[10%] left-[48%] font-headline font-black italic text-[14rem] leading-none tracking-[-0.06em] text-stone-900">
        Ⅸ
      </div>

      {/* Curved "Field·Realm·Map" near bottom (full-bleed left) */}
      <svg className="absolute -bottom-10 -left-10 w-[520px] h-[200px] text-stone-900" viewBox="0 0 520 200" fill="none">
        <defs>
          <path id="vellum-curve-path-back" d="M 20 140 Q 260 30 500 140" />
        </defs>
        <text fontSize="58" fontFamily="'Space Grotesk', sans-serif" fontWeight="900" fill="currentColor" letterSpacing="2">
          <textPath href="#vellum-curve-path-back">Field·Realm·Map</textPath>
        </text>
      </svg>

      {/* Bottom-mid bold serial code line — full bleed bottom */}
      <div className="absolute bottom-2 left-[28%] font-mono text-[3rem] leading-none tracking-[-0.02em] font-black text-stone-900 whitespace-nowrap">
        ▪ {hostname} / RELEASE 0.3.1
      </div>
    </div>
  );
}
