// Vellum destination card + layout dispatchers.
//
// Card wraps a Link with a vellum surface (translucent tint +
// backdrop-blur) and renders one of 5 layouts. SchematicLayout is the
// iter-17 founder pick (4-quadrant callouts around a central graphic);
// the other layouts (numeral / headline / stat / coordinate) ship for
// spike comparison so /lab/vellum-lab can A/B them.
//
// Production dashboard uses layout="numeral" — that's the iter-15-clean
// reference visual: big stacked numeral (0¹ / 0² / etc) on the left,
// graphic top-right, body text right-side full-bleed chopped, label +
// icon + route bottom strip.

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CornerBracket } from "./CornerBracket.js";

export type VellumCardLayout = "numeral" | "headline" | "stat" | "coordinate" | "schematic";
export type VellumCardTint = "white" | "cream" | "stone" | "rose" | "slate" | "sepia" | "mint";
export type VellumCardShadow = "soft" | "hard" | "paper" | "long" | "inset" | "halo" | "ambient" | "none";

export interface VellumDestinationCardProps {
  to: string;
  num: string;
  /** Two-character stacked numeral for the numeral layout (e.g. "01"). */
  big?: string;
  label: string;
  icon: ReactNode;
  body: string;
  graphic: ReactNode;
  positionClass: string;
  /** Tertiary accent on label + a chopped WARNING bar (e.g. FOR YOU). */
  accent?: boolean;
  /** Inky/washed text-shadow on the big numeral + body (e.g. PROJECT). */
  washed?: boolean;
  layout?: VellumCardLayout;
  /** 4-item callout array for the schematic layout. */
  callouts?: [string, string, string, string];
  /** Soft paper tint on the card surface. Defaults to "white". */
  tint?: VellumCardTint;
  /** Drop-shadow style. Defaults to "none". */
  shadow?: VellumCardShadow;
}

export function VellumDestinationCard(props: VellumDestinationCardProps) {
  const {
    to, num, big, label, icon, body, graphic, positionClass,
    accent, washed,
    layout = "numeral",
    callouts,
    tint = "white",
    shadow = "none",
  } = props;

  const numClass = washed ? "inky-display" : "";
  const textClass = washed ? "inky-text" : "";

  // Paper tints. All ~/35–/40 alpha so backdrop-blur still does the
  // vellum work but the surface picks up a soft warm/cool cast.
  const tintBg: Record<VellumCardTint, string> = {
    white: "bg-white/30",
    cream: "bg-amber-50/45",
    stone: "bg-stone-100/45",
    rose:  "bg-rose-50/45",
    slate: "bg-slate-50/50",
    sepia: "bg-yellow-50/45",
    mint:  "bg-emerald-50/40",
  };

  const shadowStyle: Record<VellumCardShadow, React.CSSProperties> = {
    none: {},
    soft: { boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)" },
    hard: { boxShadow: "3px 3px 0px #2e342e" },
    paper: { boxShadow: "0 2px 6px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.07)" },
    long: { boxShadow: "6px 6px 18px rgba(0, 0, 0, 0.1)" },
    inset: { boxShadow: "inset 0 1px 2px rgba(255,255,255,0.7), 0 2px 4px rgba(0,0,0,0.04)" },
    halo: { boxShadow: "0 0 24px rgba(0, 0, 0, 0.12)" },
    ambient: {
      boxShadow: [
        "0 2px 4px rgba(0, 0, 0, 0.14)",   // tight key shadow
        "0 8px 20px rgba(0, 0, 0, 0.16)",  // mid spread
        "0 0 40px rgba(0, 0, 0, 0.12)",    // ambient halo (all sides)
      ].join(", "),
    },
  };

  // Stacked numeral defaults to `num` if no explicit `big` supplied.
  const stackedNum = big ?? num;

  return (
    <Link
      to={to}
      data-testid={`dashboard-card-${num}`}
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
          <NumeralLayout big={stackedNum} numClass={numClass} graphic={graphic} body={body} label={label} icon={icon} to={to} accent={accent} textClass={textClass} />
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

/* NUMERAL layout — iter-15 founder pick (and the production default).
   Big stacked numeral hero on left, graphic top-right, body text
   right-side full-bleed chopped, destination label + icon + route at
   bottom. */
interface NumeralLayoutProps {
  big: string;
  numClass: string;
  graphic: ReactNode;
  body: string;
  label: string;
  icon: ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function NumeralLayout({ big, numClass, graphic, body, label, icon, to, accent, textClass }: NumeralLayoutProps) {
  return (
    <>
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

/* HEADLINE layout — spike: destination name is the hero. */
interface HeadlineLayoutProps {
  label: string;
  icon: ReactNode;
  body: string;
  graphic: ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function HeadlineLayout({ label, icon, body, graphic, to, accent, textClass }: HeadlineLayoutProps) {
  return (
    <>
      <h2 className={`absolute top-6 left-3 right-3 font-headline font-black text-[40px] leading-[0.95] uppercase tracking-tight text-stone-900 ${textClass} ${accent ? "text-tertiary" : ""}`}>
        {label}
      </h2>
      <div className="absolute top-[88px] left-3 right-3 h-px bg-stone-900/30" />
      <div className="absolute top-[100px] left-3 w-[60px] h-[60px]">{graphic}</div>
      <p className={`absolute top-[100px] left-[80px] right-1 font-mono text-[8.5px] leading-[1.35] uppercase text-stone-900 ${textClass}`}>
        {body}
      </p>
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

/* STAT layout — real-data hero. Placeholders for demo. */
interface StatLayoutProps {
  label: string;
  num: string;
  icon: ReactNode;
  body: string;
  graphic: ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function StatLayout({ label, num, icon, body, graphic, to, accent, textClass }: StatLayoutProps) {
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 select-none">
        ▪ {label} · {num}°
      </div>
      <div className="absolute top-9 right-9 w-[36px] h-[36px]">{graphic}</div>
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

/* COORDINATE layout — precision instrument frame with ruler ticks. */
function CoordinateLayout({ label, num, icon, body, graphic, to, accent, textClass }: StatLayoutProps) {
  const ticks = Array.from({ length: 12 });
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 select-none">
        ▪ {label} · {num}°
      </div>
      <div className="absolute top-7 left-6 right-6 flex justify-between">
        {ticks.map((_, i) => (
          <span key={i} className={`w-px h-[6px] ${i % 3 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>
      <div className="absolute bottom-12 left-6 right-6 flex justify-between">
        {ticks.map((_, i) => (
          <span key={i} className={`w-px h-[6px] ${i % 3 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>
      <div className="absolute top-12 bottom-16 left-3 flex flex-col justify-between">
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className={`h-px w-[6px] ${i % 2 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>
      <div className="absolute top-12 bottom-16 right-3 flex flex-col justify-between">
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className={`h-px w-[6px] ${i % 2 === 0 ? "bg-stone-900" : "bg-stone-900/40"}`} />
        ))}
      </div>
      <div className="absolute top-[40px] left-1/2 -translate-x-1/2 w-[72px] h-[72px]">
        {graphic}
      </div>
      <div className="absolute top-[76px] left-6 right-6 h-px bg-stone-900/30" />
      <div className="absolute top-[40px] bottom-[80px] left-1/2 w-px bg-stone-900/30" />
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

/* SCHEMATIC layout — graphic dominates center; 4 quadrant callouts
   numbered .01–.04 label sub-destinations or facets. */
interface SchematicLayoutProps extends StatLayoutProps {
  callouts?: [string, string, string, string];
  washed?: boolean;
}
function SchematicLayout({ label, num, icon, body, graphic, to, accent, textClass, callouts, washed }: SchematicLayoutProps) {
  const items = callouts ?? ["A", "B", "C", "D"];
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-700 select-none">
        ▪ {label} · {num}°
      </div>
      <div className="absolute top-7 left-1/2 -translate-x-1/2 w-[110px] h-[110px]">
        {graphic}
      </div>
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
