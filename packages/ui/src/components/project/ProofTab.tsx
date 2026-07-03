// OPR.0.4.1.23 Part-3 — PROOF tab (round-9, curator-INDEPENDENT). PROJECT the
// per-slice proof location AS-IS, read-only.
//
// Mechanism: each slice's proof lives at the byte-identical PATH CONTRACT
// `<slicePath>/PROOF.md` (slice root, like PROGRESS.md) + `<slicePath>/proof/`
// (media), scaffolded by `rig scope` (Part-1, shipped) and populated by the
// closeout SOP (Part-2, skill-library) — NO curator in the read path. This tab
// projects whatever is there: PROOF.md rendered + an artifact gallery of the
// proof/ captures + a self-explanatory empty-state for a scaffolded-but-unpopulated
// slice.
//
// REUSE, no new surface: reads go through the existing allowlist + traversal-guarded
// /api/files endpoints exactly like the slice-21 Artifacts navigator —
// useScopeMarkdown(slicePath,'PROOF.md') for the verdict/prose + useFilesList(root,
// '<slice>/proof') + fileAssetUrl for the gallery. Inherits the daemon's path-safety.
//
// LAZY-LOAD (the slice-17/21 lesson): this component only mounts when the PROOF tab
// is the ACTIVE tab — it never renders (and so never fetches) on the overview/steering
// landing. Layout is the founder-approved mockup (digital-twin/opr-0.4.1.23/).

import { useState } from "react";
import { useFilesList, fileAssetUrl } from "../../hooks/useFiles.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";

type Verdict = "PASS" | "PARTIAL" | "FAIL";

const VERDICT_TONE: Record<Verdict, string> = {
  PASS: "border-emerald-500/60 bg-emerald-50 text-emerald-800",
  PARTIAL: "border-amber-500/60 bg-amber-50 text-amber-800",
  FAIL: "border-red-500/60 bg-red-50 text-red-800",
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/** Asset base for INLINE PROOF.md images — e.g. `![](proof/real-live.png)` in the
 *  Intent→Proof table, relative to the slice root where PROOF.md lives. MarkdownViewer
 *  appends the relative src with a "/" separator (resolveAssetUrl), so a non-empty
 *  relPath yields the exact /api/files/asset?...path=<relPath>/proof/<img> URL. The
 *  exact-root case (relPath "") anchors on "." so the join stays relative
 *  (path=./proof/<img>) instead of a leading-slash path=/proof/<img>. Without this the
 *  inline images render as broken route-relative `proof/...` URLs (guard fcf1126f). */
function proofAssetBase(rootName: string, relPath: string): string {
  return fileAssetUrl(rootName, relPath || ".");
}

/** Parse the PROOF.md verdict, ROBUST to multiple authored shapes (the scaffold
 *  template `Verdict: <pass | ...>`, the dev1-qa capture `**Verdict: PASS**`, a bare
 *  `Verdict: pass-with-residue`). A `<...>` angle-bracket placeholder is NOT a real
 *  verdict — an unpopulated scaffold returns null (→ the empty-state). */
function parseVerdict(content: string | null): Verdict | null {
  if (!content) return null;
  const m = /verdict\s*:?\s*\**\s*([A-Za-z][A-Za-z-]*)/i.exec(content.replace(/`/g, ""));
  if (!m) return null;
  const token = m[1]!.toLowerCase();
  if (token.startsWith("pass")) return token.includes("residue") ? "PARTIAL" : "PASS";
  if (token.startsWith("partial")) return "PARTIAL";
  if (token.startsWith("fail")) return "FAIL";
  return null;
}

function Lightbox({ src, alt, onClose }: { src: string | null; alt: string; onClose: () => void }) {
  if (!src) return null;
  return (
    <div
      role="dialog"
      aria-label="Proof capture preview"
      data-testid="proof-lightbox"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-stone-950/40 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div className="max-h-full max-w-[92vw] border border-white/20 bg-stone-950/70 p-2" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} data-testid="proof-lightbox-image" className="max-h-[80vh] max-w-full object-contain" />
        <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] text-stone-50">
          <span className="truncate">{alt}</span>
          <button
            type="button"
            data-testid="proof-lightbox-close"
            onClick={onClose}
            className="border border-white/30 px-2 py-0.5 hover:bg-white/10"
            aria-label="Close preview"
          >
            close
          </button>
        </div>
      </div>
    </div>
  );
}

/** One slice's proof card — reads <slicePath>/PROOF.md + <slicePath>/proof/ AS-IS. */
function ProofSliceCard({
  sliceId,
  title,
  slicePath,
}: {
  sliceId: string;
  title: string;
  slicePath: string | null;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  // PROOF.md via the slice-17/21 scope-markdown reader (resolves slicePath to the
  // allowlist + reads through /api/files/read). `resolved` = the {rootName, relPath}
  // we reuse for the proof/ listing + asset URLs, so we resolve the path only once.
  const proofMd = useScopeMarkdown(slicePath, "PROOF.md");
  const resolved = proofMd.resolved;
  const proofRel = resolved ? (resolved.relPath ? `${resolved.relPath}/proof` : "proof") : null;

  // proof/ listing — lazy (enabled:!!root). Disabled until the path resolves.
  const proofList = useFilesList(resolved ? resolved.rootName : null, proofRel);
  const files = (proofList.data?.entries ?? []).filter((e) => e.type === "file");
  const images = files.filter((f) => IMAGE_RE.test(f.name));
  const otherFiles = files.filter((f) => !IMAGE_RE.test(f.name));

  const verdict = parseVerdict(proofMd.content);
  const hasContent = !proofMd.unavailable && !!proofMd.content;
  // Populated = a real verdict OR at least one captured artifact. A scaffolded-but-
  // unpopulated slice (placeholder verdict, empty proof/) falls through to the empty-state.
  const populated = verdict !== null || images.length > 0 || otherFiles.length > 0;

  if (proofMd.isLoading) {
    return (
      <section data-testid={`proof-slice-loading-${sliceId}`} className="border border-outline-variant bg-surface-lowest/25 p-4">
        <div className="font-mono text-[11px] text-on-surface-variant">Loading proof…</div>
      </section>
    );
  }

  if (!populated) {
    return (
      <section
        data-testid={`proof-slice-empty-${sliceId}`}
        className="border border-dashed border-outline-variant bg-surface-lowest/10 p-4"
      >
        <div className="flex items-baseline justify-between border-b border-outline-variant/60 pb-2">
          <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface-variant">{sliceId}</span>
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant">awaiting proof</span>
        </div>
        <div className="mt-3">
          <EmptyState
            label="NO PROOF YET"
            description="This slice has a scaffolded proof/ location that no closeout has populated. Proof-of-work captures (screenshots / videos) and a PROOF.md verdict land here when the closing agent drops them in at slice closeout — no curator required."
            variant="card"
            testId={`proof-empty-state-${sliceId}`}
          />
        </div>
      </section>
    );
  }

  return (
    <section data-testid={`proof-slice-${sliceId}`} className="border border-outline-variant bg-surface-lowest/25 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-outline-variant pb-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface">{sliceId}</span>
          <span className="font-mono text-[10px] text-on-surface-variant">{title}</span>
        </div>
        {verdict ? (
          <span
            data-testid={`proof-verdict-${sliceId}`}
            className={`border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] ${VERDICT_TONE[verdict]}`}
          >
            {verdict}
          </span>
        ) : null}
      </div>

      {/* PROOF.md rendered AS-IS (markdown → UI, robust like the PROGRESS projection). */}
      {hasContent ? (
        <div data-testid={`proof-md-${sliceId}`} className="mt-3">
          <MarkdownViewer
            content={proofMd.content!}
            assetBasePath={resolved ? proofAssetBase(resolved.rootName, resolved.relPath) : undefined}
            hideFrontmatter
            hideRawToggle
          />
        </div>
      ) : null}

      {/* Artifact gallery — the proof/ captures, browser-viewable via /api/files/asset. */}
      {images.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
            proof/ · {images.length} capture{images.length === 1 ? "" : "s"}
          </div>
          <div data-testid={`proof-gallery-${sliceId}`} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {images.map((img) => {
              const url = fileAssetUrl(resolved!.rootName, `${proofRel}/${img.name}`);
              return (
                <figure key={img.name} data-testid={`proof-thumb-${img.name}`} className="border border-outline-variant bg-surface-lowest/40">
                  <button type="button" onClick={() => setPreview(url)} className="block w-full" aria-label={`Open ${img.name}`}>
                    <img src={url} alt={img.name} loading="lazy" className="block h-[150px] w-full object-cover object-top" />
                  </button>
                  <figcaption className="truncate border-t border-outline-variant px-2 py-1 font-mono text-[8px] uppercase tracking-[0.08em] text-on-surface-variant">
                    {img.name}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Non-image proof artifacts (logs/videos/etc) — listed AS-IS as links, nothing hidden. */}
      {otherFiles.length > 0 ? (
        <ul data-testid={`proof-files-${sliceId}`} className="mt-3 space-y-1 font-mono text-[10px]">
          {otherFiles.map((f) => (
            <li key={f.name}>
              <a
                href={fileAssetUrl(resolved!.rootName, `${proofRel}/${f.name}`)}
                target="_blank"
                rel="noreferrer"
                className="text-on-surface-variant underline decoration-outline-variant underline-offset-2 hover:text-on-surface"
              >
                proof/{f.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <Lightbox src={preview} alt={preview ? "proof capture" : ""} onClose={() => setPreview(null)} />
    </section>
  );
}

export interface ProofRollupRow {
  /** slice index name (the `name` from the slice list) */
  name: string;
  /** human display id, e.g. "OPR.0.4.1.16" or the slice display name */
  displayName: string;
  /** absolute filesystem path of the slice folder (PL-007 slicePath) */
  slicePath: string | null;
}

/** Per-slice PROOF roll (workspace + mission altitude). Mounts only when the PROOF
 *  tab is active, so its file reads never fire on the overview/steering landing. */
export function ScopeProofRollup({ rows }: { rows: ProofRollupRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        label="NO SLICES IN SCOPE"
        description="No slices are indexed for this scope, so there is no proof to project yet."
        variant="card"
        testId="proof-rollup-empty"
      />
    );
  }
  return (
    <div data-testid="proof-tab" className="space-y-6">
      <SectionHeader>Proof · proof-of-work per slice</SectionHeader>
      {rows.map((row) => (
        <ProofSliceCard key={row.name} sliceId={row.displayName} title={row.name} slicePath={row.slicePath} />
      ))}
    </div>
  );
}

/** Single-slice PROOF view (slice altitude). */
export function SliceProofTab({
  sliceId,
  title,
  slicePath,
}: {
  sliceId: string;
  title: string;
  slicePath: string | null;
}) {
  return (
    <div data-testid="proof-tab" className="space-y-6">
      <SectionHeader>Proof · proof-of-work</SectionHeader>
      <ProofSliceCard sliceId={sliceId} title={title} slicePath={slicePath} />
    </div>
  );
}
