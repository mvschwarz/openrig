// LAYER 2 — mid content.
//
// Smaller recognizable elements at full black. Sit between the two
// sheets so they're slightly hazed (only the back sheet blurs them).
//
// hostname surfaces in two places (Field Report + Data Streams copy
// blocks) so production reads the live host while the lab default
// keeps 127.0.0.1.

import { ScatteredMarks } from "./marks.js";

interface MidLayerContentProps {
  hostname?: string;
}

export function MidLayerContent({ hostname = "127.0.0.1" }: MidLayerContentProps = {}) {
  return (
    <div
      data-testid="mid-layer"
      aria-hidden="true"
      className="absolute inset-0 z-[10] overflow-hidden pointer-events-none select-none"
    >
      {/* "06° Field Report" copy block — mid-left margin */}
      <div className="absolute top-[64%] left-[3%] font-mono text-[11px] text-stone-900 leading-tight max-w-[180px]">
        <div className="font-bold uppercase">▪ 06° Field Report</div>
        <div className="text-stone-800 mt-1">
          Operator session captured at field station {hostname} — release 0.3.1; daemon trace nominal.
        </div>
      </div>

      {/* "Data Streams" small text block */}
      <div className="absolute bottom-[8%] left-[6%] font-mono text-[11px] text-stone-900 leading-tight max-w-[180px]">
        <div className="font-bold uppercase">Data Streams ⚠⚠</div>
        <div className="text-stone-800 mt-1 text-[10px]">
          x-axis(1) y-axis(2) z-axis(3) — synchronized at {hostname}
        </div>
      </div>

      {/* Scattered medium-scale marks */}
      <ScatteredMarks tier="mid" />
    </div>
  );
}
