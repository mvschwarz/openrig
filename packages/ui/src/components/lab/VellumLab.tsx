// Vellum Lab — design experiment surface for the dashboard vellum
// showcase. /lab/vellum-lab.
//
// Iteration history:
//   iter 01-04 — proved backdrop-blur mechanic, then composition.
//   iter 05   — invisible sheets (no labels/borders/corners).
//   iter 06   — THREE-LAYER doctrine per founder feedback 2026-05-13:
//
//     LAYER 0  back content (z-0)         BIG BOLD BLACK ELEMENTS,
//                                          full-bleed asymmetric. NEVER
//                                          grey-by-opacity — black at full
//                                          alpha; the blur on top is what
//                                          creates the faded appearance.
//     LAYER 1  back vellum sheet (z-5)     Heavy: bg-white/40 + blur-[20px].
//                                          Covers most of canvas. Invisible
//                                          chrome — no border / label / corner.
//     LAYER 2  mid content (z-10)          Smaller recognizable elements
//                                          (diagrams, marginalia, marks)
//                                          at full black; peeks through
//                                          the back sheet.
//     LAYER 3  mid vellum sheet (z-15)     Lighter: bg-white/15 + blur-[8px].
//                                          Covers part of canvas only.
//     LAYER 4  top content (z-20)          FINE LINE CRISP. Gyroscope +
//                                          warning UR, geological wave UL,
//                                          hidden-entry redacted LR, plus
//                                          scattered tiny floats. Inky
//                                          text-shadow for printed-on-vellum feel.
//
// Cards + WELCOME BACK headline temporarily REMOVED while we dial the
// layered effect. Founder direction: bring them back once the
// background composition lands.

import { Link } from "@tanstack/react-router";
import {
  Network,
  Folder,
  Sparkles,
  FileText,
  Search,
  Cog,
} from "lucide-react";

/** Optional overrides — VellumBackgroundLab uses these to test
 *  alternate back-layer compositions + vellum blur/opacity levels
 *  without forking the whole lab page. */
interface VellumLabProps {
  backLayerOverride?: React.ReactNode;
  vellumSheetOverride?: React.ReactNode;
}
export function VellumLab({
  backLayerOverride,
  vellumSheetOverride,
}: VellumLabProps = {}) {
  return (
    <div
      data-testid="vellum-lab"
      className="relative min-h-screen overflow-hidden"
    >
      {/* LAYER 0 — back content (bold black, full bleed) */}
      {backLayerOverride ?? <BackLayerContent />}

      {/* LAYER 1 — back vellum sheet (heavy blur on most of canvas) */}
      {vellumSheetOverride ?? <BackVellumSheet />}

      {/* LAYER 2 — mid content (smaller; peeks through back sheet) */}
      <MidLayerContent />

      {/* LAYER 4 — top crisp fine-line elements (the printed top of stack) */}
      <TopLayerContent />

      {/* LAYER 5 — DESTINATIONS (clickable launcher elements). */}
      <DestinationsLayer />
    </div>
  );
}

/* ====================================================================
   LAYER 0 — BACK CONTENT
   BOLD BLACK at 100% alpha. Full-bleed asymmetric placement. The eye
   reads these as "deep blurred background" only because the back vellum
   sheet sits over them — never use opacity to fake the fade.
   ==================================================================== */
function BackLayerContent() {
  return (
    <div
      data-testid="back-layer"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
    >
      {/* OPERATOR — full bleed left edge */}
      <div className="absolute top-[14%] -left-12 font-mono text-[9rem] leading-[0.85] tracking-[-0.02em] font-black text-stone-900 whitespace-pre">
        {`OPERATOR\n04°·LIVE\n127.0.0.1`}
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
          <path id="curve-path-back" d="M 20 140 Q 260 30 500 140" />
        </defs>
        <text fontSize="58" fontFamily="'Space Grotesk', sans-serif" fontWeight="900" fill="currentColor" letterSpacing="2">
          <textPath href="#curve-path-back">Field·Realm·Map</textPath>
        </text>
      </svg>

      {/* Bottom-mid bold serial code line — full bleed bottom */}
      <div className="absolute bottom-2 left-[28%] font-mono text-[3rem] leading-none tracking-[-0.02em] font-black text-stone-900 whitespace-nowrap">
        ▪ 127.0.0.1 / RELEASE 0.3.1
      </div>
    </div>
  );
}

/* ====================================================================
   LAYER 1 — BACK VELLUM SHEET
   Iter 08: SMALL STAGGER (12–16px) per founder feedback 2026-05-14.
   Reverted from iter 07's dramatic 70–110px inset because that made
   the vellum feel undersized; iter 06's near-full-bleed coverage was
   the right WIDTH. The fix is a TINY offset (~12–16px per side) so
   the back layer just barely peeks out around the vellum edges. The
   eye sees sharp black content at the page edge, then the SAME
   content blurred behind the vellum a few pixels inward — that thin
   sharp→blurred transition completes the "object behind paper" trick
   without sacrificing the sheet's visual width.
   Asymmetric per side for hand-placed feel.
   ==================================================================== */
function BackVellumSheet() {
  // Reverted to flat bg-white/40 per founder pick — the gradient
  // experiment (warm-to-cool diagonal) looked worse than the flat
  // sheet because the apparent "gradient" comes naturally from the
  // back-content blur showing through unevenly.
  return (
    <div
      data-testid="back-vellum-sheet"
      aria-hidden="true"
      className="absolute top-[14px] bottom-[12px] left-[16px] right-[14px] z-[5] bg-white/40 backdrop-blur-[20px] pointer-events-none"
    />
  );
}

/* ====================================================================
   LAYER 2 — MID CONTENT
   Smaller recognizable elements at full black. Sit between the two
   sheets so they're slightly hazed (only the back sheet blurs them).
   ==================================================================== */
function MidLayerContent() {
  return (
    <div
      data-testid="mid-layer"
      aria-hidden="true"
      className="absolute inset-0 z-[10] overflow-hidden pointer-events-none select-none"
    >
      {/* Brain anatomy REMOVED iter 12 per founder feedback 2026-05-14. */}

      {/* Sphere wireframe REMOVED iter 21 per founder feedback —
          competed visually with the FOR YOU card top-right. */}

      {/* Rig topology wireframe REMOVED iter 13 per founder feedback —
          was sitting behind SEARCH & AUDIT card and competing visually. */}

      {/* "06° Field Report" copy block — mid-left margin */}
      <div className="absolute top-[64%] left-[3%] font-mono text-[11px] text-stone-900 leading-tight max-w-[180px]">
        <div className="font-bold uppercase">▪ 06° Field Report</div>
        <div className="text-stone-800 mt-1">Operator session captured at field station 127.0.0.1 — release 0.3.1; daemon trace nominal.</div>
      </div>

      {/* "Data Streams" small text block */}
      <div className="absolute bottom-[8%] left-[6%] font-mono text-[11px] text-stone-900 leading-tight max-w-[180px]">
        <div className="font-bold uppercase">Data Streams ⚠⚠</div>
        <div className="text-stone-800 mt-1 text-[10px]">x-axis(1) y-axis(2) z-axis(3) — synchronized at 127.0.0.1</div>
      </div>

      {/* Scattered medium-scale marks */}
      <ScatteredMarks tier="mid" />
    </div>
  );
}

/* ====================================================================
   LAYER 5 — DESTINATIONS
   Iter 09 per founder feedback 2026-05-14: the OLD MidVellumSheet
   approach (empty vellum sheets at angles) didn't earn its keep
   because nothing was "printed on" them — they looked like floating
   sheets next to text rather than paper-with-text. Replaced with
   six clickable destination elements that USE the vellum technique
   meaningfully:
     A. Angled vellum CARDS — paper tilted at an angle, content
        rotated to match the paper (the "Polaroid on a desk" effect)
     B. Floating display elements — no card chrome, just inky type
        on the background, hover affordance via color shift
     C. Minimal stamp/badge — rotated marginalia with click affordance
   Six destinations total per existing dashboard surface: Topology,
   Project, For You, Library, Search & Audit, Settings.
   ==================================================================== */
/* DestinationsLayer iter 10 (2026-05-14):
   - Six vellum-surface cards, ALL borderless
   - Card edges implied by: (a) sharp content on the card vs blurred
     content peeking from behind through the vellum, and (b) FULL
     BLEED CHOPPED elements (text running off the edge of the card)
   - Inside each card: a big bold display anchor (like F⁷ in ref) +
     fine line crosshair marks (+, ■ NN°, [?]) + body text some of
     which is full-bleed chopped at the right edge
   - Each card sits on top of back content so the back layer peeks
     blurred through the vellum behind the card body
   - Each card is a clickable Link to its destination route */
function DestinationsLayer() {
  // Tactical schematic drafting alignment per founder feedback 2026-05-14:
  // - 2 rows × 3 cols, all positions aligned, NO stagger
  // - all cards same dimensions (28% wide × 220px tall)
  // - PROJECT is the only card that keeps the "washed inky" look;
  //   every other card uses ultra-sharp text per founder direction
  //
  // Layout columns:
  //   Col 1: left-[5%]
  //   Col 2: left-[36%]   (= 5 + 28 + 3 gap)
  //   Col 3: left-[67%]   (= 5 + 28 + 3 + 28 + 3)
  // Layout rows:
  //   Top row:    top-[14%]
  //   Bottom row: top-[55%]
  return (
    <div data-testid="destinations-layer" className="absolute inset-0 z-[18] pointer-events-none">
      {/* SHADOW SPIKE iter 22 — one shadow approach per card for
          side-by-side comparison. Once a winner is picked, all 6 cards
          unify on that style. */}
      {/* Reverted to iter-15 mixed layouts per founder rollback. */}
      <VellumDestinationCard
        to="/topology"
        num="01"
        big="01"
        label="Topology"
        icon={<Network className="h-4 w-4" />}
        body="Host · Rig · Pod · Seat tree — live edges + runtimes; drill into any rig's pod graph."
        positionClass="top-[22%] left-[5%]"
        graphic={<TreeGraphic />}
        layout="numeral"
        callouts={["HOST", "RIG", "POD", "SEAT"]}
        tint="stone"
        shadow="none"
      />

      <VellumDestinationCard
        to="/project"
        num="02"
        big="02"
        label="Project"
        icon={<Folder className="h-4 w-4" />}
        body="Workspace · Mission · Slice. Browse all in-flight work by what agents are doing, not by repo."
        positionClass="top-[22%] left-[36%]"
        graphic={<StratigraphicGraphic />}
        layout="numeral"
        callouts={["WORKSPACE", "MISSION", "SLICE", "TASK"]}
        washed
        tint="stone"
        shadow="none"
      />

      <VellumDestinationCard
        to="/for-you"
        num="03"
        big="03"
        label="For You"
        icon={<Sparkles className="h-4 w-4" />}
        body="Action feed → what needs you · what shipped · what's in flight. Prioritized for the operator."
        positionClass="top-[22%] left-[67%]"
        graphic={<PulseGraphic />}
        layout="numeral"
        callouts={["NEEDS YOU", "SHIPPED", "IN-FLIGHT", "BLOCKED"]}
        accent
        tint="stone"
        shadow="none"
      />

      <VellumDestinationCard
        to="/specs"
        num="04"
        big="04"
        label="Library"
        icon={<FileText className="h-4 w-4" />}
        body="Specs · Plugins · Skills · Context packs. Field catalog 0.3.1 — 38 active artifacts."
        positionClass="top-[55%] left-[5%]"
        graphic={<SphereGraphic />}
        layout="numeral"
        callouts={["SPECS", "PLUGINS", "SKILLS", "PACKS"]}
        tint="stone"
        shadow="none"
      />

      <VellumDestinationCard
        to="/search"
        num="05"
        big="05"
        label="Search & Audit"
        icon={<Search className="h-4 w-4" />}
        body="Audit history · full artifact explorer. V1 placeholder; the full surface ships in V2."
        positionClass="top-[55%] left-[36%]"
        graphic={<MagnifierGraphic />}
        layout="numeral"
        callouts={["AUDIT", "HISTORY", "QUERY", "FILTER"]}
        tint="stone"
        shadow="none"
      />

      <VellumDestinationCard
        to="/settings"
        num="06"
        big="06"
        label="Settings"
        icon={<Cog className="h-4 w-4" />}
        body="Config · Policy · Log · Status. Operator-grade controls; ConfigStore-backed; reversible."
        positionClass="top-[55%] left-[67%]"
        graphic={<GearGraphic />}
        layout="numeral"
        callouts={["CONFIG", "POLICY", "LOG", "STATUS"]}
        tint="stone"
        shadow="none"
      />
    </div>
  );
}

/* L-shaped 90° corner bracket. Used at each of the 4 corners of a
   destination card to register the card's bounding box (print/CAD
   register marks). Replaces the "+" crosshairs from iter 12. The
   bracket "L" faces inward toward the center of the card. */
interface CornerBracketProps {
  position: "tl" | "tr" | "bl" | "br";
}
function CornerBracket({ position }: CornerBracketProps) {
  const positionClass = {
    tl: "top-1.5 left-1.5",
    tr: "top-1.5 right-1.5",
    bl: "bottom-1.5 left-1.5",
    br: "bottom-1.5 right-1.5",
  }[position];
  // SVG paths for L-brackets at each corner. The "L" leg lengths are
  // ~10px each at a 10×10 viewBox; the bracket faces inward so the
  // corner-of-the-L hugs the card's outer corner.
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

/* Per-destination wireframe graphics — small technical line drawings,
   one per card. Each ~60×60 viewBox, sharp 1px stroke, fill-none. The
   LIBRARY sphere is the anchor pattern (founder said "I like this");
   the others follow that visual language for each destination. */

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
  // Gyroscope-style globe per founder pick 2026-05-14: outer circle +
  // crossed ellipses (equator + meridian) + crosshair dashed lines
  // extending across the full canvas + filled center dot. Same shape
  // as the bottom-right "02° GYRO" instrument.
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
      {/* 8 gear teeth */}
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

/* Vellum destination card — unified composition iter 12.
   Every card has the same shape:
     - Big stacked numeral on left
     - Per-destination wireframe graphic top-right
     - "[?]" bracket mark mid
     - Body text below graphic on right (full-bleed CHOPPED at edge)
     - Label + icon at bottom-left
     - Route slug at bottom-right
     - "+" crosshairs at three corners
     - "■ NN°" annotation top-right next to graphic
     - WARNING bar (only when accent=true) chopped at right edge
   Inky text-shadow only when washed=true (PROJECT only). */
interface VellumDestinationCardProps {
  to: string;
  num: string;
  big: string;
  label: string;
  icon: React.ReactNode;
  body: string;
  graphic: React.ReactNode;
  positionClass: string;
  /** Tertiary accent on label + a chopped WARNING bar (FOR YOU only). */
  accent?: boolean;
  /** Inky/washed text-shadow on the big numeral + body (PROJECT only). */
  washed?: boolean;
  /** Iter 17: schematic layout is the winner. All 6 cards use it.
   *  Other variants kept available for spike comparison. */
  layout?: "numeral" | "headline" | "stat" | "coordinate" | "schematic";
  /** 4-item callout array for the schematic layout — one label per
   *  quadrant of the graphic. Numbered .01–.04 implicitly. */
  callouts?: [string, string, string, string];
  /** Subtle color tint on the card surface. Each value is a different
   *  paper grade — the vellum effect still works because the bg is
   *  translucent + backdrop-blurred. Defaults to "white" (untinted). */
  tint?: "white" | "cream" | "stone" | "rose" | "slate" | "sepia" | "mint";
  /** Iter 22 — drop-shadow experiment per founder dispatch 2026-05-14.
   *  Six approaches tested in parallel (one per destination card):
   *    "soft"      — gentle ambient lift (Material Design feel)
   *    "hard"      — tactical hard-shadow restored (original aesthetic)
   *    "paper"     — multi-layer paper shadow (most realistic)
   *    "long"      — long angled diffuse shadow
   *    "inset"     — inset bevel + faint outer glow
   *    "halo"      — floating glow halo
   *    "none"      — no shadow (control). */
  shadow?: "soft" | "hard" | "paper" | "long" | "inset" | "halo" | "ambient" | "none";
}
function VellumDestinationCard(props: VellumDestinationCardProps) {
  const { to, num, big, label, icon, body, graphic, positionClass, accent, washed, layout = "numeral", callouts, tint = "white", shadow = "none" } = props;
  const numClass = washed ? "inky-display" : "";
  const textClass = washed ? "inky-text" : "";
  // Subtle tints — each is a different paper grade. All at ~/35–/40
  // alpha so backdrop-blur still does the vellum work but the surface
  // picks up a soft warm/cool cast.
  // Restored to iter-15 values per founder rollback request 2026-05-14.
  const tintBg: Record<string, string> = {
    white: "bg-white/30",
    cream: "bg-amber-50/45",
    stone: "bg-stone-100/45",
    rose:  "bg-rose-50/45",
    slate: "bg-slate-50/50",
    sepia: "bg-yellow-50/45",
    mint:  "bg-emerald-50/40",
  };
  // Iter 23 — AMBIENT shadow (all 4 sides defined). Multi-stop combo:
  // tiny downward key shadow for natural weight + non-directional
  // ambient halo so every card edge reads as a clean paper edge.
  // (Other approaches kept in the map for spike comparison.)
  const shadowStyle: Record<string, React.CSSProperties> = {
    none: {},
    soft: { boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)" },
    hard: { boxShadow: "3px 3px 0px #2e342e" },
    paper: { boxShadow: "0 2px 6px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.07)" },
    long: { boxShadow: "6px 6px 18px rgba(0, 0, 0, 0.1)" },
    inset: { boxShadow: "inset 0 1px 2px rgba(255,255,255,0.7), 0 2px 4px rgba(0,0,0,0.04)" },
    halo: { boxShadow: "0 0 24px rgba(0, 0, 0, 0.12)" },
    ambient: {
      // Iter 24 — boosted intensity per founder request. Roughly 2×
      // opacity + larger blur radii so the card edges are clearly
      // defined on all 4 sides through the vellum.
      boxShadow: [
        "0 2px 4px rgba(0, 0, 0, 0.14)",   // tight key shadow
        "0 8px 20px rgba(0, 0, 0, 0.16)",  // mid spread
        "0 0 40px rgba(0, 0, 0, 0.12)",    // ambient halo (all sides)
      ].join(", "),
    },
  };
  return (
    <Link
      to={to}
      className={`absolute ${positionClass} w-[28%] h-[220px] pointer-events-auto group block`}
    >
      <article
        data-testid={`destination-${num}`}
        style={shadowStyle[shadow]}
        className={`relative h-full ${tintBg[tint]} backdrop-blur-[10px] overflow-hidden transition-transform duration-300 ease-tactical group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0`}
      >
        {/* 90° corner brackets at all four corners */}
        <CornerBracket position="tl" />
        <CornerBracket position="tr" />
        <CornerBracket position="bl" />
        <CornerBracket position="br" />

        {/* "■ NN°" annotation mark */}
        <span className="absolute top-2 right-6 font-mono text-[9px] uppercase tracking-[0.18em] text-stone-700 select-none">
          ■ {num}°
        </span>

        {layout === "headline" && (
          <HeadlineLayout label={label} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} />
        )}
        {layout === "stat" && (
          <StatLayout label={label} num={num} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} />
        )}
        {layout === "coordinate" && (
          <CoordinateLayout label={label} num={num} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} />
        )}
        {layout === "schematic" && (
          <SchematicLayout label={label} num={num} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} callouts={callouts} washed={washed} />
        )}
        {(layout === "numeral" || !layout) && (
          <NumeralLayout big={big} numClass={numClass} graphic={graphic} body={body} label={label} icon={icon} to={to} accent={accent} textClass={textClass} />
        )}

        {/* WARNING bar — accent only (FOR YOU). */}
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

/* NUMERAL layout — the iter 10–14 design: big 0¹ stacked numeral
   hero on left, graphic top-right, body text right-side full-bleed
   chopped, destination label + icon + route at bottom. */
interface NumeralLayoutProps {
  big: string;
  numClass: string;
  graphic: React.ReactNode;
  body: string;
  label: string;
  icon: React.ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function NumeralLayout({ big, numClass, graphic, body, label, icon, to, accent, textClass }: NumeralLayoutProps) {
  return (
    <>
      {/* Per-card annotation mark removed iter 32 — its uniform position
          on every card made it read as intentional UI rather than the
          intended "glitch / artifact" feel. Floating marks live in
          TopLayerContent's FloatingTopMarks instead, where they're
          scattered at random-looking positions. */}
      <div className={`absolute top-7 left-3 font-headline font-black text-[110px] leading-[0.82] tracking-[-0.06em] text-stone-900 select-none ${numClass}`}>
        {big[0]}
        <sup className="text-[55px] tracking-tight align-super">{big[1]}</sup>
      </div>
      <div className="absolute top-7 right-7 w-[58px] h-[58px]">{graphic}</div>
      <p className={`absolute bottom-12 right-1 w-[140px] font-mono text-[8.5px] leading-[1.35] uppercase text-stone-900 ${textClass}`}>
        {body}
      </p>
      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-stone-900"}>{icon}</span>
        <h2 className={`font-headline font-black text-[17px] leading-none uppercase tracking-tight ${textClass} ${accent ? "text-tertiary" : "text-stone-900"}`}>
          {label}
        </h2>
        <span className={`ml-auto font-mono text-[9px] tracking-tight text-stone-500 ${textClass}`}>
          [{to}] →
        </span>
      </div>
    </>
  );
}

/* STAT layout — iter 16 variant C. Real data number is the hero
   (functional, not decorative). Big primary stat dominates; secondary
   stats line below; destination name as small label at bottom. */
interface StatLayoutProps {
  label: string;
  num: string;
  icon: React.ReactNode;
  body: string;
  graphic: React.ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function StatLayout({ label, num, icon, body, graphic, to, accent, textClass }: StatLayoutProps) {
  // Stat values are placeholders — would be wired to real data when
  // this layout ports back to the production dashboard. For lab purposes
  // they show the visual hierarchy clearly.
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 select-none">
        ▪ {label} · {num}°
      </div>

      <div className="absolute top-9 right-9 w-[36px] h-[36px]">
        {graphic}
      </div>

      <div className="absolute top-[44px] left-3 flex items-baseline gap-3">
        <span className={`font-headline font-black text-[64px] leading-[0.82] tracking-[-0.04em] text-stone-900 tabular-nums ${textClass}`}>
          38
        </span>
        <div className="flex flex-col leading-tight">
          <span className="font-mono text-[10px] uppercase tracking-wide text-stone-900">Active</span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-stone-700">Artifacts</span>
        </div>
      </div>

      <div className="absolute top-[120px] left-3 right-3 grid grid-cols-3 gap-0">
        <StatCell big="12" small="Specs" />
        <StatCell big="08" small="Plugins" />
        <StatCell big="18" small="Skills" />
      </div>

      <p className={`absolute bottom-12 left-3 right-1 font-mono text-[8px] leading-[1.3] uppercase text-stone-800 ${textClass}`}>
        {body}
      </p>

      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-stone-900"}>{icon}</span>
        <h2 className={`font-headline font-black text-[15px] leading-none uppercase tracking-tight ${accent ? "text-tertiary" : "text-stone-900"}`}>
          {label}
        </h2>
        <span className="ml-auto font-mono text-[9px] tracking-tight text-stone-500">
          [{to}] →
        </span>
      </div>
    </>
  );
}
function StatCell({ big, small }: { big: string; small: string }) {
  return (
    <div className="border-l border-stone-900/30 first:border-l-0 pl-2">
      <div className="font-mono text-[14px] font-bold tabular-nums text-stone-900 leading-none">{big}</div>
      <div className="font-mono text-[8px] uppercase tracking-wide text-stone-600 mt-0.5">{small}</div>
    </div>
  );
}

/* COORDINATE layout — iter 16 variant D. Graphic centered in a
   precision coordinate-frame with ruler tick marks at the edges +
   crosshair through the graphic's anchor point. Reads as a technical
   measurement / instrument card. */
interface CoordinateLayoutProps extends StatLayoutProps {}
function CoordinateLayout({ label, num, icon, body, graphic, to, accent, textClass }: CoordinateLayoutProps) {
  // Edge ruler tick marks built from a small repeating pattern.
  const ticks = Array.from({ length: 12 });
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 select-none">
        ▪ {label} · {num}°
      </div>

      {/* Top ruler */}
      <div className="absolute top-7 left-6 right-6 flex justify-between">
        {ticks.map((_, i) => (
          <span key={i} className={`w-px h-[6px] ${i % 3 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>
      {/* Bottom ruler */}
      <div className="absolute bottom-12 left-6 right-6 flex justify-between">
        {ticks.map((_, i) => (
          <span key={i} className={`w-px h-[6px] ${i % 3 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>
      {/* Left ruler */}
      <div className="absolute top-12 bottom-16 left-3 flex flex-col justify-between">
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className={`h-px w-[6px] ${i % 2 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>
      {/* Right ruler */}
      <div className="absolute top-12 bottom-16 right-3 flex flex-col justify-between">
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className={`h-px w-[6px] ${i % 2 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>

      {/* Graphic centered in the coordinate frame */}
      <div className="absolute top-[40px] left-1/2 -translate-x-1/2 w-[72px] h-[72px]">
        {graphic}
      </div>

      {/* Crosshair lines through anchor */}
      <div className="absolute top-[76px] left-6 right-6 h-px bg-stone-900/30" />
      <div className="absolute top-[40px] bottom-[80px] left-1/2 w-px bg-stone-900/30" />

      {/* Anchor coordinate annotation */}
      <span className="absolute top-[120px] left-1/2 ml-1 font-mono text-[8px] text-stone-700">
        ⟨x: 24, y: 18⟩
      </span>

      <p className={`absolute bottom-[60px] left-6 right-6 font-mono text-[8px] leading-[1.3] uppercase text-stone-800 text-center ${textClass}`}>
        {body}
      </p>

      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-stone-900"}>{icon}</span>
        <h2 className="font-headline font-black text-[15px] leading-none uppercase tracking-tight text-stone-900">
          {label}
        </h2>
        <span className="ml-auto font-mono text-[9px] tracking-tight text-stone-500">
          [{to}] →
        </span>
      </div>
    </>
  );
}

/* SCHEMATIC layout — iter 17 (founder pick): the winning layout used
   by all 6 destination cards. Graphic dominates center; 4 quadrant
   callouts (numbered .01–.04) label sub-destinations or facets of the
   destination; destination name + icon + route at bottom; body text
   as caption above bottom strip. */
interface SchematicLayoutProps extends StatLayoutProps {
  callouts?: [string, string, string, string];
  washed?: boolean;
}
function SchematicLayout({ label, num, icon, body, graphic, to, accent, textClass, callouts, washed }: SchematicLayoutProps) {
  // Default callouts if none provided (will be overridden per card).
  const items = callouts ?? ["A", "B", "C", "D"];
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 select-none">
        ▪ {label} · {num}°
      </div>

      {/* Dominant graphic — center */}
      <div className="absolute top-7 left-1/2 -translate-x-1/2 w-[110px] h-[110px]">
        {graphic}
      </div>

      {/* 4 callouts in the four corners of the graphic */}
      <Callout num=".01" label={items[0]} positionClass="top-[42px] left-3" align="left" />
      <Callout num=".02" label={items[1]} positionClass="top-[42px] right-3" align="right" />
      <Callout num=".03" label={items[2]} positionClass="top-[98px] left-3" align="left" />
      <Callout num=".04" label={items[3]} positionClass="top-[98px] right-3" align="right" />

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

/* HEADLINE layout — iter 16 spike per founder: destination name is
   the hero element (more useful info than a number). Big TOPOLOGY
   headline takes top half; graphic + body text below in two columns;
   route slug bottom-right. No big stacked numeral. */
interface HeadlineLayoutProps {
  label: string;
  icon: React.ReactNode;
  body: string;
  graphic: React.ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function HeadlineLayout({ label, icon, body, graphic, to, accent, textClass }: HeadlineLayoutProps) {
  return (
    <>
      {/* Big destination headline — hero element, top of card */}
      <h2
        className={`absolute top-6 left-3 right-3 font-headline font-black text-[40px] leading-[0.95] uppercase tracking-tight text-stone-900 ${textClass} ${accent ? "text-tertiary" : ""}`}
      >
        {label}
      </h2>

      {/* Thin divider between headline and lower content */}
      <div className="absolute top-[88px] left-3 right-3 h-px bg-stone-900/30" />

      {/* Lower zone — graphic LEFT, body text RIGHT */}
      <div className="absolute top-[100px] left-3 w-[60px] h-[60px]">
        {graphic}
      </div>
      <p className={`absolute top-[100px] left-[80px] right-1 font-mono text-[8.5px] leading-[1.35] uppercase text-stone-900 ${textClass}`}>
        {body}
      </p>

      {/* Bottom strip: icon + route slug (no duplicated label) */}
      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-stone-900"}>{icon}</span>
        <span className={`font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 ${textClass}`}>
          Destination · 01°
        </span>
        <span className={`ml-auto font-mono text-[9px] tracking-tight text-stone-500 ${textClass}`}>
          [{to}] →
        </span>
      </div>
    </>
  );
}

/* ====================================================================
   LAYER 4 — TOP CONTENT (the printed top of the stack)
   Fine line crisp elements only. These are what the user described:
     - upper-right: gyroscope/instrument illustration + warning tag
     - upper-left: geological wave/cross-section
     - lower-right: hidden-entry redacted bars
     - scattered: small floating text annotations + marks
   With inky text-shadow on heavy text per the ANGEL(s*) reference.
   ==================================================================== */
function TopLayerContent() {
  return (
    <div
      data-testid="top-layer"
      className="absolute inset-0 z-20 pointer-events-none select-none"
    >
      {/* Classification eyebrow — top of page (production copy). */}
      <div className="absolute top-0 inset-x-0 border-b border-stone-900/40 bg-background/40 backdrop-blur-[6px]">
        <div className="mx-auto max-w-[1180px] px-6 py-2 flex items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.32em] text-stone-700">
          <span className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 bg-success rounded-none" />
            Operator
          </span>
          <span className="hidden sm:inline">▪ OpenRig · 0.3.1</span>
          <span className="hidden md:inline">▪ Field Station 127.0.0.1</span>
          <span className="hidden md:inline">▪ Session 04°</span>
          <span className="text-stone-500">04°</span>
        </div>
      </div>

      {/* Hero block — WELCOME BACK + stats line. Operator + Field Station
          identification already lives in the classification eyebrow above
          (per founder iter 19), so we don't repeat it here. */}
      <div className="absolute top-[44px] left-[5%] right-[5%] z-20 pointer-events-none">
        <h1 className="font-headline text-[44px] font-black tracking-tight uppercase text-stone-900 leading-[0.95] inky-display">
          Welcome back<sup className="text-[22px] tracking-tight align-super">(s*)</sup>
        </h1>
        <div className="font-mono text-xs text-stone-700 mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-stone-900 font-bold tabular-nums text-sm">01</span>
            <span className="uppercase tracking-[0.12em] text-[10px]">rigs</span>
          </span>
          <span aria-hidden="true" className="text-stone-300">·</span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-stone-900 font-bold tabular-nums text-sm">04</span>
            <span className="uppercase tracking-[0.12em] text-[10px]">agents</span>
            <span className="ml-1 text-stone-600">(</span>
            <span className="text-success font-bold tabular-nums">04</span>
            <span className="uppercase tracking-[0.12em] text-[10px] text-success">active</span>
            <span className="text-stone-600">)</span>
          </span>
        </div>
      </div>

      {/* === STRATIGRAPHIC CROSS-SECTION REMOVED iter 12 per founder
            feedback — the small version is now baked into the TOPOLOGY
            card as its wireframe graphic. */}

      {/* === BOTTOM-RIGHT BELOW CARDS: EYES EVERYWHERE text mark.
            Iter 15 fix per founder: NO CIRCLE/PILL BORDER — just the
            bold serif text with smudged inky look + slight angle.
            Matches the founder reference (degraded ink-on-vellum print). */}
      <div className="absolute bottom-8 right-10 rotate-[-4deg] origin-bottom-right">
        <span className="font-headline font-black text-[13px] tracking-[0.02em] text-stone-900 uppercase inky-text">
          Eyes Everywhere
        </span>
      </div>

      {/* === SCATTERED FLOATING TEXT (sparse, fine, top layer) === */}
      <FloatingTopMarks />

      {/* AUTHOR REDACTED rotated marginalia — left margin */}
      <div className="absolute left-2 top-[42%] font-mono text-[9px] uppercase tracking-[0.2em] text-stone-600 rotate-[-90deg] origin-top-left whitespace-nowrap ">
        ▪ Author redacted · entry 04°
      </div>

      {/* Footer marginalia — bottom of page (production copy). */}
      <div className="absolute bottom-0 inset-x-0 border-t border-stone-900/40 bg-background/40 backdrop-blur-[6px]">
        <div className="mx-auto max-w-[1180px] px-6 py-2 flex items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.24em] text-stone-700">
          <span>▪▪▪ End Surface · Dashboard · 01°</span>
          <span className="hidden sm:inline">Operator-Grade · ConfigStore-Backed</span>
          <span>OpenRig · 0.3.1</span>
        </div>
      </div>
    </div>
  );
}

/* Tiny floating top-layer text annotations — sparse, fine, crisp.
   These are the "random pieces of text" the founder mentioned. */
function FloatingTopMarks() {
  const marks: Array<{ pos: string; text: string; size?: string }> = [
    { pos: "top-[18%] left-[36%]", text: "▪ 03°", size: "text-[10px]" },
    // [?] at top-[28%] left-[28%] removed iter 32 — was covering the
    // TOPOLOGY card's tree diagram. The other floating marks stay so
    // the dashboard still has the scattered "glitch artifact" feel.
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

/* Mid-tier scattered marks (slightly larger, sit on layer 2). */
interface ScatteredMarksProps {
  tier: "mid" | "back";
}
function ScatteredMarks({ tier }: ScatteredMarksProps) {
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
