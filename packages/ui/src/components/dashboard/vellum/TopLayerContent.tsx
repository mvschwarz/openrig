// LAYER 4 — top content (crisp printed top of stack).
//
// Fine line crisp elements only:
//   - Classification eyebrow (top): Operator + OpenRig version + Field Station hostname
//   - Hero block: WELCOME BACK + stats line (rigs / agents / active)
//   - EYES EVERYWHERE bottom-right printed mark
//   - AUTHOR REDACTED rotated marginalia (left margin)
//   - Footer marginalia (bottom): End Surface · Dashboard · 01°
//   - Scattered floating top-layer marks
//
// All four real-data inputs (hostname / totalRigs / totalAgents /
// activeAgents) flow in as props. Lab defaults preserve the hardcoded
// 127.0.0.1 + placeholder counts (01 / 04 / 04 active).

import { FloatingTopMarks } from "./marks.js";

interface TopLayerContentProps {
  hostname?: string;
  totalRigs?: number;
  totalAgents?: number;
  activeAgents?: number;
}

export function TopLayerContent({
  hostname = "127.0.0.1",
  totalRigs = 1,
  totalAgents = 4,
  activeAgents = 4,
}: TopLayerContentProps = {}) {
  return (
    <div
      data-testid="top-layer"
      className="absolute inset-0 z-20 pointer-events-none select-none"
    >
      {/* Classification eyebrow — top of page. */}
      <div
        data-testid="dashboard-classification"
        className="absolute top-0 inset-x-0 border-b border-stone-900/40 bg-background/40 backdrop-blur-[6px]"
      >
        <div className="mx-auto max-w-[1180px] px-6 py-2 flex items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.32em] text-stone-700">
          <span className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 bg-success rounded-none" />
            Operator
          </span>
          <span className="hidden sm:inline">▪ OpenRig · 0.3.1</span>
          <span className="hidden md:inline">▪ Field Station {hostname}</span>
          <span className="hidden md:inline">▪ Session 04°</span>
          <span className="text-stone-500">04°</span>
        </div>
      </div>

      {/* Hero block — WELCOME BACK + stats. Operator + Field Station
          identification already lives in the classification eyebrow
          above so we don't repeat it here. */}
      <div className="absolute top-[44px] left-[5%] right-[5%] z-20 pointer-events-none">
        <h1
          data-testid="dashboard-greeting"
          className="font-headline text-[44px] font-black tracking-tight uppercase text-stone-900 leading-[0.95] inky-display"
        >
          Welcome back<sup className="text-[22px] tracking-tight align-super">(s*)</sup>
        </h1>
        <div
          data-testid="dashboard-stats"
          className="font-mono text-xs text-stone-700 mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1"
        >
          <span data-testid="stat-rigs" className="inline-flex items-baseline gap-1.5">
            <span className="text-stone-900 font-bold tabular-nums text-sm">
              {String(totalRigs).padStart(2, "0")}
            </span>
            <span className="uppercase tracking-[0.12em] text-[10px]">rigs</span>
          </span>
          <span aria-hidden="true" className="text-stone-300">·</span>
          <span data-testid="stat-agents" className="inline-flex items-baseline gap-1.5">
            <span className="text-stone-900 font-bold tabular-nums text-sm">
              {String(totalAgents).padStart(2, "0")}
            </span>
            <span className="uppercase tracking-[0.12em] text-[10px]">agents</span>
            <span className="ml-1 text-stone-600">(</span>
            <span className="text-success font-bold tabular-nums">
              {String(activeAgents).padStart(2, "0")}
            </span>
            <span className="uppercase tracking-[0.12em] text-[10px] text-success">active</span>
            <span className="text-stone-600">)</span>
          </span>
        </div>
      </div>

      {/* EYES EVERYWHERE — bottom-right printed mark. NO circle/pill
          border per founder iter-15 — just bold serif text with
          smudged inky look + slight angle. */}
      <div className="absolute bottom-8 right-10 rotate-[-4deg] origin-bottom-right">
        <span className="font-headline font-black text-[13px] tracking-[0.02em] text-stone-900 uppercase inky-text">
          Eyes Everywhere
        </span>
      </div>

      {/* Scattered floating top-layer marks. */}
      <FloatingTopMarks />

      {/* AUTHOR REDACTED rotated marginalia — left margin. */}
      <div className="absolute left-2 top-[42%] font-mono text-[9px] uppercase tracking-[0.2em] text-stone-600 rotate-[-90deg] origin-top-left whitespace-nowrap">
        ▪ Author redacted · entry 04°
      </div>

      {/* Footer marginalia — bottom of page. */}
      <div
        data-testid="dashboard-footer-marginalia"
        className="absolute bottom-0 inset-x-0 border-t border-stone-900/40 bg-background/40 backdrop-blur-[6px]"
      >
        <div className="mx-auto max-w-[1180px] px-6 py-2 flex items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.24em] text-stone-700">
          <span>▪▪▪ End Surface · Dashboard · 01°</span>
          <span className="hidden sm:inline">Operator-Grade · ConfigStore-Backed</span>
          <span>OpenRig · 0.3.1</span>
        </div>
      </div>
    </div>
  );
}
