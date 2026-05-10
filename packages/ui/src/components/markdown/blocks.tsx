// 0.3.1 slice 06 — fenced-block renderers. Each block language
// (timeline / stats / risk-table / compare / slate) parses its body
// and dispatches to the corresponding spatial primitive. Parser
// failures fall back to a plain code block so the source stays
// inspectable.

import {
  parseTimelineBlock,
  parseStatsBlock,
  parseRiskTableBlock,
  parseCompareBlock,
  parseSlateBlock,
  type FencedBlockLanguage,
} from "./storytelling-primitives.js";
import {
  TLDRSlate,
  DotTimeline,
  StatCardBand,
  RiskTableGrid,
  CompareTable,
} from "./primitives.js";

interface FencedBlockProps {
  language: FencedBlockLanguage;
  text: string;
}

/** Dispatch a fenced block to its specialized renderer. Returns null
 *  when the language is not a known fenced-block grammar (the caller
 *  then falls through to the regular code-block renderer). When the
 *  language IS known but the body fails to parse, a plain code block
 *  is rendered so the source stays inspectable. */
export function FencedBlockRenderer({ language, text }: FencedBlockProps): React.ReactElement | null {
  if (language === "timeline") {
    const r = parseTimelineBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <DotTimeline entries={r.entries} testId={`fenced-block-${language}`} />;
  }
  if (language === "stats") {
    const r = parseStatsBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <StatCardBand entries={r.entries} testId={`fenced-block-${language}`} />;
  }
  if (language === "risk-table") {
    const r = parseRiskTableBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <RiskTableGrid entries={r.entries} testId={`fenced-block-${language}`} />;
  }
  if (language === "compare") {
    const r = parseCompareBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <CompareTable columns={r.columns} rows={r.rows} testId={`fenced-block-${language}`} />;
  }
  if (language === "slate") {
    const r = parseSlateBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <TLDRSlate testId={`fenced-block-${language}`}>{r.text}</TLDRSlate>;
  }
  return null;
}

function FallbackCode({ language, text, reason }: { language: string; text: string; reason: string }) {
  return (
    <div data-testid={`fenced-block-${language}-fallback`} className="my-3 border border-amber-300 bg-amber-50/60 p-3">
      <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-amber-700">
        {language} block (fallback: {reason})
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] text-stone-800">{text}</pre>
    </div>
  );
}
