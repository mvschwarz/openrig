// 0.3.1 slice 06 — KindFrame.
//
// When a markdown file declares a known `kind:` in its frontmatter,
// MarkdownViewer wraps the body in a KindFrame: a slim header chrome
// (kind badge + title + meta row) plus optional TL;DR slate composed
// from a `tldr:` frontmatter field. The body itself is rendered by
// the existing block flow, with fenced-block grammars (timeline /
// stats / risk-table / compare / slate) intercepted into spatial
// primitives. The other 4 kinds beyond the 3 fully-realized layouts
// share this chrome — the visual difference is the accent color and
// the kind label.

import { TLDRSlate, SummaryStrip } from "./primitives.js";
import type { KindName } from "./storytelling-primitives.js";

interface KindFrameProps {
  kind: KindName;
  frontmatter: Record<string, string>;
  children: React.ReactNode;
}

const KIND_ACCENTS: Record<KindName, { ink: string; pill: string; label: string }> = {
  "incident-timeline":   { ink: "text-red-800",     pill: "bg-red-50 border-red-300",       label: "INCIDENT TIMELINE" },
  "progress":            { ink: "text-sky-800",     pill: "bg-sky-50 border-sky-300",       label: "PROGRESS" },
  "feature-shipped":     { ink: "text-emerald-800", pill: "bg-emerald-50 border-emerald-300", label: "FEATURE SHIPPED" },
  "implementation-plan": { ink: "text-violet-800",  pill: "bg-violet-50 border-violet-300", label: "IMPLEMENTATION PLAN" },
  "concept-explainer":   { ink: "text-amber-800",   pill: "bg-amber-50 border-amber-300",   label: "CONCEPT EXPLAINER" },
  "pr-writeup":          { ink: "text-stone-800",   pill: "bg-stone-50 border-stone-300",   label: "PR WRITEUP" },
  "post-mortem":         { ink: "text-stone-900",   pill: "bg-stone-100 border-stone-400",  label: "POST-MORTEM" },
};

export function KindFrame({ kind, frontmatter, children }: KindFrameProps): React.ReactElement {
  const accent = KIND_ACCENTS[kind];
  const title = frontmatter.title;
  const status = frontmatter.status;
  const author = frontmatter.author;
  const date = frontmatter.authored || frontmatter.date;
  const tldr = frontmatter.tldr;
  const summary = frontmatter.summary;

  return (
    <section data-testid={`kind-frame-${kind}`} data-kind={kind} className="my-2">
      <header className="mb-3 border-b border-outline-variant pb-2">
        <div
          data-testid={`kind-badge-${kind}`}
          className={`inline-block border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${accent.pill} ${accent.ink}`}
        >
          {accent.label}
        </div>
        {title && (
          <h1 data-testid="kind-frame-title" className="mt-2 text-[16px] font-bold text-stone-900">
            {title}
          </h1>
        )}
        {(status || author || date) && (
          <div data-testid="kind-frame-meta" className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">
            {status && <span data-testid="kind-frame-meta-status">status: {status}</span>}
            {author && <span data-testid="kind-frame-meta-author">{author}</span>}
            {date && <span data-testid="kind-frame-meta-date">{date}</span>}
          </div>
        )}
      </header>
      {tldr && <TLDRSlate testId="kind-frame-tldr">{tldr}</TLDRSlate>}
      {kind === "feature-shipped" && summary && (
        <SummaryStrip label="SHIPPED" body={summary} testId="kind-frame-summary" />
      )}
      <div data-testid="kind-frame-body">{children}</div>
    </section>
  );
}
