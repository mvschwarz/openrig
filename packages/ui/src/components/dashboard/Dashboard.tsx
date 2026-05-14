// V0.3.1 dashboard showcase — ported from /lab/vellum-lab iter 19 per
// founder dispatch 2026-05-14. Three-layer vellum composition:
//   Layer 0  back content (z-0)        BOLD BLACK FULL-BLEED — the
//                                       depth layer the vellum sheet blurs.
//   Layer 1  back vellum sheet (z-5)   Heavy blur, ~14-16px stagger off
//                                       page edges so the back layer peeks
//                                       sharp around the edges (object-
//                                       behind-paper trick).
//   Layer 2  mid content (z-10)        Sphere + marginalia + scattered marks.
//   Layer 4  top content (z-20)        Crisp printed top — classification
//                                       eyebrow, WELCOME BACK hero, stats,
//                                       EYES EVERYWHERE mark, footer.
//   Layer 5  destinations (z-18)       6 schematic-layout cards, clickable.
//
// Real data wired:
//   useRigSummary    → totalRigs, totalAgents (back-end source of truth)
//   usePsEntries     → activeAgents (running processes per ps)
//   useSpecLibrary   → librarySize (catalog artifact count → Library card)
//   formatHostLabel  → hostname for classification eyebrow Field Station

import { Link } from "@tanstack/react-router";
import {
  Network,
  Folder,
  Sparkles,
  FileText,
  Search,
  Cog,
} from "lucide-react";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { useSpecLibrary } from "../../hooks/useSpecLibrary.js";
import { formatHostLabel } from "../../lib/host-label.js";

export function Dashboard() {
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();
  const { data: library } = useSpecLibrary();

  const totalRigs = rigs?.length ?? 0;
  const totalAgents = rigs?.reduce((acc, r) => acc + r.nodeCount, 0) ?? 0;
  const activeAgents = psEntries?.reduce((acc, p) => acc + p.runningCount, 0) ?? 0;
  const librarySize = library?.length ?? 0;
  const hostname =
    typeof window === "undefined" ? "localhost" : window.location.hostname || "localhost";

  return (
    <div
      data-testid="dashboard-surface"
      className="relative min-h-screen overflow-hidden"
    >
      <BackLayerContent hostname={hostname} />
      <BackVellumSheet />
      <MidLayerContent hostname={hostname} />
      <TopLayerContent
        hostname={hostname}
        totalRigs={totalRigs}
        totalAgents={totalAgents}
        activeAgents={activeAgents}
      />
      <DestinationsLayer librarySize={librarySize} />
    </div>
  );
}

/* ====================================================================
   LAYER 0 — BACK CONTENT (bold black, full bleed)
   ==================================================================== */
function BackLayerContent({ hostname }: { hostname: string }) {
  return (
    <div
      data-testid="dashboard-back-layer"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
    >
      <div className="absolute top-[14%] -left-12 font-mono text-[9rem] leading-[0.85] tracking-[-0.02em] font-black text-stone-900 whitespace-pre">
        {`OPERATOR\n04°·LIVE\n${hostname}`}
      </div>

      <div className="absolute top-[42%] -right-10 font-headline font-black text-[14rem] leading-[0.82] tracking-[-0.06em] text-stone-900 whitespace-nowrap">
        RIG·OS<sup className="text-[6rem] tracking-[-0.04em] align-super">(s*)</sup>
      </div>

      <div className="absolute top-[4%] right-[8%] font-headline font-black text-[12rem] leading-none tracking-[-0.06em] text-stone-900">
        07/??
      </div>

      <div className="absolute top-[58%] left-[36%] font-headline font-black text-[7rem] leading-none tracking-[-0.04em] text-stone-900">
        ■ 04°
      </div>

      <div className="absolute top-[6%] left-[42%] font-headline font-black italic text-[9rem] leading-none tracking-[-0.06em] text-stone-900">
        VII
      </div>

      <div className="absolute -bottom-6 -right-2 font-headline font-black text-[9rem] leading-none tracking-[-0.06em] text-stone-900 uppercase">
        Phobos®
      </div>

      <div className="absolute top-[28%] left-[8%] font-headline font-black text-[24rem] leading-[0.8] tracking-[-0.06em] text-stone-900 uppercase whitespace-pre">
        {`OS·\nØ`}
      </div>

      <div className="absolute bottom-[10%] left-[48%] font-headline font-black italic text-[14rem] leading-none tracking-[-0.06em] text-stone-900">
        Ⅸ
      </div>

      <svg
        className="absolute -bottom-10 -left-10 w-[520px] h-[200px] text-stone-900"
        viewBox="0 0 520 200"
        fill="none"
      >
        <defs>
          <path id="dashboard-curve-path-back" d="M 20 140 Q 260 30 500 140" />
        </defs>
        <text
          fontSize="58"
          fontFamily="'Space Grotesk', sans-serif"
          fontWeight="900"
          fill="currentColor"
          letterSpacing="2"
        >
          <textPath href="#dashboard-curve-path-back">Field·Realm·Map</textPath>
        </text>
      </svg>

      <div className="absolute bottom-2 left-[28%] font-mono text-[3rem] leading-none tracking-[-0.02em] font-black text-stone-900 whitespace-nowrap">
        ▪ {hostname} / RELEASE 0.3.1
      </div>
    </div>
  );
}

/* ====================================================================
   LAYER 1 — BACK VELLUM SHEET (~14-16px stagger off edges)
   ==================================================================== */
function BackVellumSheet() {
  return (
    <div
      data-testid="dashboard-back-vellum-sheet"
      aria-hidden="true"
      className="absolute top-[14px] bottom-[12px] left-[16px] right-[14px] z-[5] bg-white/40 backdrop-blur-[20px] pointer-events-none"
    />
  );
}

/* ====================================================================
   LAYER 2 — MID CONTENT
   ==================================================================== */
function MidLayerContent({ hostname }: { hostname: string }) {
  return (
    <div
      data-testid="dashboard-mid-layer"
      aria-hidden="true"
      className="absolute inset-0 z-[10] overflow-hidden pointer-events-none select-none"
    >
      {/* Sphere wireframe removed iter 21 per founder feedback —
          competed visually with the FOR YOU card top-right. */}

      <div className="absolute top-[64%] left-[3%] font-mono text-[11px] text-stone-900 leading-tight max-w-[180px]">
        <div className="font-bold uppercase">▪ 06° Field Report</div>
        <div className="text-stone-800 mt-1">
          Operator session captured at field station {hostname} — release 0.3.1; daemon trace nominal.
        </div>
      </div>

      <div className="absolute bottom-[8%] left-[6%] font-mono text-[11px] text-stone-900 leading-tight max-w-[180px]">
        <div className="font-bold uppercase">Data Streams ⚠⚠</div>
        <div className="text-stone-800 mt-1 text-[10px]">
          x-axis(1) y-axis(2) z-axis(3) — synchronized at {hostname}
        </div>
      </div>

      <ScatteredMarks />
    </div>
  );
}

function ScatteredMarks() {
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
          className={`absolute ${m.pos} text-base font-mono text-stone-900 leading-none`}
        >
          {m.text}
        </span>
      ))}
    </>
  );
}

/* ====================================================================
   LAYER 4 — TOP CONTENT (crisp printed top)
   ==================================================================== */
interface TopLayerProps {
  hostname: string;
  totalRigs: number;
  totalAgents: number;
  activeAgents: number;
}
function TopLayerContent({ hostname, totalRigs, totalAgents, activeAgents }: TopLayerProps) {
  return (
    <div
      data-testid="dashboard-top-layer"
      className="absolute inset-0 z-20 pointer-events-none select-none"
    >
      {/* Classification eyebrow — top of page */}
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
          identification already lives in the classification eyebrow above
          so we don't repeat it here. */}
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

      {/* EYES EVERYWHERE — bottom-right printed mark */}
      <div className="absolute bottom-8 right-10 rotate-[-4deg] origin-bottom-right">
        <span className="font-headline font-black text-[13px] tracking-[0.02em] text-stone-900 uppercase inky-text">
          Eyes Everywhere
        </span>
      </div>

      {/* Scattered floating top-layer marks */}
      <FloatingTopMarks />

      {/* AUTHOR REDACTED rotated marginalia — left margin */}
      <div className="absolute left-2 top-[42%] font-mono text-[9px] uppercase tracking-[0.2em] text-stone-600 rotate-[-90deg] origin-top-left whitespace-nowrap">
        ▪ Author redacted · entry 04°
      </div>

      {/* Footer marginalia — bottom */}
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

function FloatingTopMarks() {
  const marks: Array<{ pos: string; text: string; size?: string }> = [
    { pos: "top-[18%] left-[36%]", text: "▪ 03°", size: "text-[10px]" },
    { pos: "top-[28%] left-[28%]", text: "[?]", size: "text-sm" },
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

/* ====================================================================
   LAYER 5 — DESTINATIONS (6 schematic cards)
   ==================================================================== */
function DestinationsLayer({ librarySize }: { librarySize: number }) {
  // Library card body wires the live artifact count
  const libraryBody =
    librarySize > 0
      ? `Specs · Plugins · Skills · Context packs. Field catalog 0.3.1 — ${librarySize} active artifacts.`
      : "Specs · Plugins · Skills · Context packs. Field catalog 0.3.1.";

  return (
    <div
      data-testid="dashboard-destinations-layer"
      className="absolute inset-0 z-[18] pointer-events-none"
    >
      <VellumDestinationCard
        to="/topology"
        num="01"
        label="Topology"
        icon={<Network className="h-4 w-4" />}
        body="Host · Rig · Pod · Seat tree — live edges + runtimes; drill into any rig's pod graph."
        positionClass="top-[22%] left-[5%]"
        graphic={<TreeGraphic />}
        callouts={["HOST", "RIG", "POD", "SEAT"]}
      />

      <VellumDestinationCard
        to="/project"
        num="02"
        label="Project"
        icon={<Folder className="h-4 w-4" />}
        body="Workspace · Mission · Slice. Browse all in-flight work by what agents are doing, not by repo."
        positionClass="top-[22%] left-[36%]"
        graphic={<StratigraphicGraphic />}
        callouts={["WORKSPACE", "MISSION", "SLICE", "TASK"]}
        washed
      />

      <VellumDestinationCard
        to="/for-you"
        num="03"
        label="For You"
        icon={<Sparkles className="h-4 w-4" />}
        body="Action feed → what needs you · what shipped · what's in flight. Prioritized for the operator."
        positionClass="top-[22%] left-[67%]"
        graphic={<PulseGraphic />}
        callouts={["NEEDS YOU", "SHIPPED", "IN-FLIGHT", "BLOCKED"]}
        accent
      />

      <VellumDestinationCard
        to="/specs"
        num="04"
        label="Library"
        icon={<FileText className="h-4 w-4" />}
        body={libraryBody}
        positionClass="top-[55%] left-[5%]"
        graphic={<SphereGraphic />}
        callouts={["SPECS", "PLUGINS", "SKILLS", "PACKS"]}
      />

      <VellumDestinationCard
        to="/search"
        num="05"
        label="Search & Audit"
        icon={<Search className="h-4 w-4" />}
        body="Audit history · full artifact explorer. V1 placeholder; the full surface ships in V2."
        positionClass="top-[55%] left-[36%]"
        graphic={<MagnifierGraphic />}
        callouts={["AUDIT", "HISTORY", "QUERY", "FILTER"]}
      />

      <VellumDestinationCard
        to="/settings"
        num="06"
        label="Settings"
        icon={<Cog className="h-4 w-4" />}
        body="Config · Policy · Log · Status. Operator-grade controls; ConfigStore-backed; reversible."
        positionClass="top-[55%] left-[67%]"
        graphic={<GearGraphic />}
        callouts={["CONFIG", "POLICY", "LOG", "STATUS"]}
      />
    </div>
  );
}

/* L-shaped 90° corner bracket. */
function CornerBracket({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
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

/* Per-destination wireframe graphics — small technical line drawings. */
function StratigraphicGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M2 26 Q 18 18 30 22 T 58 18" />
      <path d="M2 36 Q 18 28 30 32 T 58 28" strokeDasharray="2 2" />
      <path d="M2 46 Q 18 40 30 42 T 58 38" strokeDasharray="2 2" />
      <circle cx="30" cy="22" r="2" fill="currentColor" />
      <line x1="30" y1="22" x2="30" y2="10" />
      <text x="34" y="12" fontSize="6" fontFamily="monospace" fill="currentColor" fontWeight="bold">[01]</text>
    </svg>
  );
}

function TreeGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="22" y="6" width="16" height="8" />
      <rect x="6" y="28" width="14" height="8" />
      <rect x="40" y="28" width="14" height="8" />
      <rect x="6" y="48" width="14" height="6" />
      <rect x="22" y="48" width="14" height="6" />
      <rect x="40" y="48" width="14" height="6" />
      <line x1="30" y1="14" x2="13" y2="28" />
      <line x1="30" y1="14" x2="47" y2="28" />
      <line x1="13" y1="36" x2="13" y2="48" />
      <line x1="47" y1="36" x2="47" y2="48" />
      <line x1="13" y1="44" x2="29" y2="48" />
      <line x1="47" y1="44" x2="29" y2="48" />
    </svg>
  );
}

function PulseGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <circle cx="30" cy="30" r="4" fill="currentColor" />
      <circle cx="30" cy="30" r="12" />
      <circle cx="30" cy="30" r="20" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="27" strokeDasharray="2 4" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
    </svg>
  );
}

function SphereGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <circle cx="30" cy="30" r="26" />
      <ellipse cx="30" cy="30" rx="26" ry="9" />
      <ellipse cx="30" cy="30" rx="9" ry="26" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="3" fill="currentColor" />
    </svg>
  );
}

function MagnifierGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="24" cy="24" r="14" />
      <line x1="20" y1="24" x2="28" y2="24" />
      <line x1="24" y1="20" x2="24" y2="28" />
      <line x1="34" y1="34" x2="52" y2="52" strokeWidth="1.6" />
      <line x1="48" y1="48" x2="55" y2="48" />
      <line x1="48" y1="48" x2="48" y2="55" />
    </svg>
  );
}

function GearGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <circle cx="30" cy="30" r="20" />
      <circle cx="30" cy="30" r="12" />
      <circle cx="30" cy="30" r="3" fill="currentColor" />
      <line x1="30" y1="6" x2="30" y2="11" strokeWidth="1.5" />
      <line x1="30" y1="49" x2="30" y2="54" strokeWidth="1.5" />
      <line x1="6" y1="30" x2="11" y2="30" strokeWidth="1.5" />
      <line x1="49" y1="30" x2="54" y2="30" strokeWidth="1.5" />
      <line x1="13" y1="13" x2="17" y2="17" strokeWidth="1.5" />
      <line x1="43" y1="13" x2="47" y2="17" strokeWidth="1.5" />
      <line x1="13" y1="47" x2="17" y2="43" strokeWidth="1.5" />
      <line x1="43" y1="47" x2="47" y2="43" strokeWidth="1.5" />
    </svg>
  );
}

/* Vellum destination card — schematic layout. */
interface VellumDestinationCardProps {
  to: string;
  num: string;
  label: string;
  icon: React.ReactNode;
  body: string;
  graphic: React.ReactNode;
  positionClass: string;
  callouts: [string, string, string, string];
  accent?: boolean;
  washed?: boolean;
}
function VellumDestinationCard(props: VellumDestinationCardProps) {
  const { to, num, label, icon, body, graphic, positionClass, accent, washed, callouts } = props;
  return (
    <Link
      to={to}
      data-testid={`dashboard-card-${num}`}
      className={`absolute ${positionClass} w-[28%] h-[220px] pointer-events-auto group block`}
    >
      <article
        className="relative h-full bg-stone-100/45 backdrop-blur-[10px] overflow-hidden transition-transform duration-300 ease-tactical group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
      >
        <CornerBracket position="tl" />
        <CornerBracket position="tr" />
        <CornerBracket position="bl" />
        <CornerBracket position="br" />

        <span className="absolute top-2 right-6 font-mono text-[9px] uppercase tracking-[0.18em] text-stone-700 select-none">
          ■ {num}°
        </span>

        <SchematicLayout
          label={label}
          num={num}
          icon={icon}
          body={body}
          graphic={graphic}
          to={to}
          accent={accent}
          washed={washed}
          callouts={callouts}
        />

        {accent && (
          <div className="absolute bottom-[88px] right-[-14px] w-[156px] border border-tertiary text-tertiary font-mono text-[7.5px] uppercase tracking-[0.18em] px-1.5 py-[2px] flex items-center gap-1 bg-background/30">
            <span className="inline-block w-[3px] h-[3px] bg-tertiary rounded-full" />
            Warning · Operator Live
          </div>
        )}
      </article>
    </Link>
  );
}

interface SchematicLayoutProps {
  label: string;
  num: string;
  icon: React.ReactNode;
  body: string;
  graphic: React.ReactNode;
  to: string;
  accent?: boolean;
  washed?: boolean;
  callouts: [string, string, string, string];
}
function SchematicLayout({ label, num, icon, body, graphic, to, accent, washed, callouts }: SchematicLayoutProps) {
  const textClass = washed ? "inky-text" : "";
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 select-none">
        ▪ {label} · {num}°
      </div>

      <div className="absolute top-7 left-1/2 -translate-x-1/2 w-[110px] h-[110px]">
        {graphic}
      </div>

      <Callout num=".01" label={callouts[0]} positionClass="top-[42px] left-3" align="left" />
      <Callout num=".02" label={callouts[1]} positionClass="top-[42px] right-3" align="right" />
      <Callout num=".03" label={callouts[2]} positionClass="top-[98px] left-3" align="left" />
      <Callout num=".04" label={callouts[3]} positionClass="top-[98px] right-3" align="right" />

      <p className={`absolute bottom-12 left-3 right-3 font-mono text-[8px] leading-[1.3] uppercase text-stone-800 text-center ${textClass}`}>
        {body}
      </p>

      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-stone-900"}>{icon}</span>
        <h2 className={`font-headline font-black text-[15px] leading-none uppercase tracking-tight ${washed ? "inky-text" : ""} ${accent ? "text-tertiary" : "text-stone-900"}`}>
          {label}
        </h2>
        <span className="ml-auto font-mono text-[9px] tracking-tight text-stone-500">
          [{to}] →
        </span>
      </div>
    </>
  );
}

function Callout({ num, label, positionClass, align }: { num: string; label: string; positionClass: string; align: "left" | "right" }) {
  return (
    <div className={`absolute ${positionClass} font-mono text-[8px] text-stone-700 ${align === "right" ? "text-right" : "text-left"}`}>
      <span className="block">{num}</span>
      <span className="block tabular-nums text-stone-900">{label}</span>
    </div>
  );
}
