// CORRECTIVE REDESIGN 2026-07-05 §3.3 — the slice Review tab, rebuilt.
//
// ONE structure: NEEDS YOU → AGENTS → the vertical three-section stack
// (on-screen labels INTENT / PLAN / DELIVERED) → SETTLED. The four parallel
// structures are GONE: the rejected three-column juxtaposition and the
// separate item-join table are DELETED files (not demoted — the RCA lesson:
// demotion is how a rejected render survives). Phase drives which section is
// the current FOCUS, never which structure exists; all three sections always
// compose, degrading to a muted "—" when a source is absent.
//
// DELIVERED is the redesigned join (§3.1): each planned deliverable paired
// with its CURATED proof down the column — planned mockup above delivered
// artifact — media inline at text height, expanding full-width on tap (one at
// a time). `verified` renders QA's recorded comparison in plain words;
// unverified/missing are VISIBLE, never blocking (§11 fail-open). Curated set
// only; "see all proof" drills into the proof/ dir. Two locks (§4): plan-lock
// renders in PLAN, proof-lock in SETTLED.
//
// Mobile-first single column (a phone-first scan). Cards ride the ONE vellum
// recipe (§7.4). W5: every reviewable state is deep-linkable (?item= / ?zoom=
// / ?seek+?play for media verification).

import { useState } from "react";
import { useSliceReview, type ComposedSliceReview, type DeliveredItem, type ReviewMedia, type LockState } from "../../hooks/useReview.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { NeedsYouAccordion } from "./NeedsYouAccordion.js";
import { AgentsBandView } from "./AgentsBandView.js";
import { VerifyLineageCard } from "./VerifyLineageCard.js";
import { EvidenceOpener, type EvidenceContext } from "./EvidenceOpener.js";
import { Lightbox } from "../project/Lightbox.js";
import { FileReferenceTrigger } from "../drawer-triggers/FileReferenceTrigger.js";
import { fileAssetUrl } from "../../hooks/useFiles.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { VELLUM_CARD } from "./vellum.js";
import { cn } from "../../lib/utils.js";

/** The surface's acting session for actor provenance: the REAL resolving
 *  session (delegation metadata is recorded daemon-side). */
const SURFACE_ACTOR = "human@host";

function bootParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

/** Resolve a ReviewMedia src: data:/blob: pass through (twin fixtures + any
 *  inlined media); slice-relative refs resolve through the files allowlist —
 *  the SAME resolution EvidenceOpener uses. */
function mediaSrc(ctx: EvidenceContext, src: string): string | null {
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  if (src.startsWith("/")) return null; // absolute = defect, surfaced upstream
  if (!ctx.root) return null;
  return fileAssetUrl(ctx.root, ctx.relPath ? `${ctx.relPath}/${src}` : src);
}

/** §7.3 surface leg — media that ACTUALLY plays. Video renders inline with
 *  native controls (playsinline kept for future iOS); images open the shipped
 *  Lightbox. `?seek=<s>&play=1` boots playback for capture verification —
 *  a deep link, never a doctored frame. */
function InlineMedia({ media, ctx, full }: { media: ReviewMedia; ctx: EvidenceContext; full?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const src = mediaSrc(ctx, media.src);
  if (!src) {
    return <span className="font-mono text-[11px] text-red-700">unresolvable media: {media.src}</span>;
  }
  if (media.kind === "video") {
    const seek = bootParam("seek");
    const autoplay = bootParam("play") === "1";
    return (
      <figure className={cn("min-w-0", full ? "w-full" : "max-w-[420px]")}>
        <video
          data-testid="review-inline-video"
          controls
          playsInline
          preload={autoplay ? "auto" : "metadata"}
          poster={media.poster}
          src={src}
          // React's `muted` prop famously fails to land as an attribute on
          // first render, so Chrome's autoplay policy blocks the element.
          // The ?play=1 deep link mutes + plays imperatively on mount (the
          // W5 capture path); normal renders keep controls-only behavior.
          ref={(el) => {
            if (el && autoplay && el.paused) {
              el.muted = true;
              void el.play().catch(() => {});
            }
          }}
          onLoadedMetadata={(e) => {
            if (seek) e.currentTarget.currentTime = Number(seek);
          }}
          className="block w-full border border-outline-variant bg-stone-950"
        />
        <figcaption className="mt-0.5 font-mono text-[9px] uppercase text-on-surface-variant">▶ {media.caption}</figcaption>
      </figure>
    );
  }
  return (
    <figure className={cn("min-w-0", full ? "w-full" : "max-w-[420px]")}>
      <img
        src={src}
        alt={media.caption}
        loading="lazy"
        title="opens the large view"
        onClick={() => setZoom(true)}
        className="block w-full cursor-zoom-in border border-outline-variant"
      />
      <figcaption className="mt-0.5 font-mono text-[9px] uppercase text-on-surface-variant">{media.caption}</figcaption>
      {zoom ? <Lightbox src={src} alt={media.caption} onClose={() => setZoom(false)} /> : null}
    </figure>
  );
}

function LockStamp({ lock, label }: { lock: LockState | null; label: string }) {
  return (
    <p className="font-mono text-[10px] text-on-surface-variant">
      <span className={lock ? "text-on-surface" : ""}>{lock ? "✓" : "○"}</span> {label} —{" "}
      {lock ? (
        <>
          {lock.by} · {lock.at}
          {lock.auditVerified ? "" : <span className="font-bold text-red-700"> (UNVERIFIED stamp — no matching audit row)</span>}
        </>
      ) : (
        "not locked"
      )}
    </p>
  );
}

// §3.1 verified → the founder's plain words. QA laziness is VISIBLE, never blocking.
const VERIFIED_RENDER: Record<DeliveredItem["verified"], { label: string; cls: string }> = {
  verified: { label: "✓ QA-verified against the plan", cls: "text-emerald-700 dark:text-emerald-400" },
  unverified: { label: "◇ unverified — no recorded QA comparison", cls: "text-amber-700 dark:text-amber-400" },
  missing: { label: "✗ missing — promised, nothing delivered", cls: "font-bold text-red-700 dark:text-red-400" },
};

/** §3.3 DELIVERED — one planned deliverable paired with its curated proof,
 *  down the column. One item expands full-width at a time (tap). */
function DeliveredSection({ d, ctx }: { d: ComposedSliceReview["delivered"]; ctx: EvidenceContext }) {
  const [openIdx, setOpenIdx] = useState<number | null>(() => {
    const boot = bootParam("item");
    return boot !== null ? Number(boot) : null;
  });
  return (
    <section data-testid="delivered-section" className={cn(VELLUM_CARD, "space-y-0 p-0")}>
      <h3 className="border-b border-outline-variant px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wide text-on-surface">Delivered</h3>
      {d.items.length === 0 ? (
        <p data-testid="delivered-empty" className="px-3 py-2 font-mono text-[11px] text-on-surface-variant">
          — no proof contract declared in the plan yet
        </p>
      ) : (
        d.items.map((item, i) => {
          const open = openIdx === i;
          const v = VERIFIED_RENDER[item.verified];
          return (
            <div key={i} className="border-b border-outline-variant/60">
              <button
                type="button"
                data-testid={`delivered-item-${i}`}
                onClick={() => setOpenIdx(open ? null : i)}
                className="flex w-full flex-col gap-y-1 px-3 py-2 text-left hover:bg-surface-variant/30 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3"
              >
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-on-surface">{item.promised.text}</span>
                <span className={cn("shrink-0 font-mono text-[10px] uppercase tracking-wide", v.cls)}>{v.label}</span>
              </button>
              {open ? (
                <div data-testid={`delivered-item-open-${i}`} className="space-y-3 border-t border-outline-variant/60 px-3 py-3">
                  {item.promised.plannedRef ? (
                    <div>
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">planned (the locked mockup)</p>
                      <InlineMedia media={item.promised.plannedRef} ctx={ctx} full />
                    </div>
                  ) : null}
                  {item.proof.length > 0 ? (
                    <div className="space-y-2">
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">delivered (curated proof)</p>
                      {item.proof.map((m, j) => (
                        <InlineMedia key={j} media={m} ctx={ctx} full />
                      ))}
                    </div>
                  ) : item.verified === "verified" && item.note ? (
                    <p className="font-mono text-[11px] text-on-surface-variant">✓ verified by artifact; no media attached</p>
                  ) : (
                    <p className="font-mono text-[11px] text-on-surface-variant">— nothing delivered for this item</p>
                  )}
                  {item.note ? (
                    <p data-testid={`delivered-note-${i}`} className="font-mono text-[11px] text-on-surface-variant">
                      QA note: {item.note}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      {d.extraProof.length > 0 ? (
        <div className="space-y-2 px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">additional proof (not tied to one deliverable)</p>
          <div className="flex flex-wrap gap-3">
            {d.extraProof.map((m, j) => (
              <InlineMedia key={j} media={m} ctx={ctx} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="font-mono text-[10px] text-on-surface-variant">
          curated set only — the fix-loop history stays in proof/
        </span>
        {d.proofDirPath ? (
          <span className="font-mono text-[11px]">
            <EvidenceOpener evidenceRef="proof/" ctx={ctx} testId="delivered-see-all" />
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function SliceReviewTab({
  sliceName,
  slicePath,
  anchorIdentity,
}: {
  sliceName: string;
  slicePath: string | null;
  /** FR-9 deep link target — a NEEDS-YOU identity to open on load. */
  anchorIdentity?: string | null;
}) {
  const review = useSliceReview(sliceName);
  const scopeResolved = useScopeMarkdown(slicePath, "PROOF.md");

  if (review.isLoading) {
    return <EmptyState label="COMPOSING" description={`Composing review for ${sliceName}…`} variant="card" testId="review-loading" />;
  }
  if (review.isError || !review.data) {
    return (
      <EmptyState
        label="REVIEW UNAVAILABLE"
        description={review.error instanceof Error ? review.error.message : "The review composer could not compose this slice."}
        variant="card"
        testId="review-error"
      />
    );
  }
  const data = review.data;
  const ctx: EvidenceContext = {
    root: scopeResolved.resolved?.rootName ?? null,
    relPath: scopeResolved.resolved?.relPath ?? null,
    slicePath,
  };

  return (
    <div data-testid="slice-review-tab" className="space-y-5">
      {data.defects.length > 0 ? (
        <section data-testid="review-defects" className="border border-red-300 bg-red-50 p-2 dark:bg-red-950/40">
          <ul className="space-y-0.5 font-mono text-[10px] text-red-800 dark:text-red-300">
            {data.defects.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Band 1: NEEDS YOU (kept — orthogonal and sound). */}
      <NeedsYouAccordion band={data.needsYou} slice={data.slice} actorSession={SURFACE_ACTOR} ctx={ctx} anchorIdentity={anchorIdentity} />

      {/* Band 2: AGENTS — standing band, zoom to the rig altitude (kept). */}
      <AgentsBandView band={data.agents} itemRef={data.slice} />

      {/* Band 3: THE ONE STACK — INTENT → PLAN → DELIVERED (§3.3). Scanned
          top-to-bottom: did intent become a correct plan become a correct
          build. Phase highlights the current focus, never hides a section. */}
      <section data-testid="intent-section" className={cn(VELLUM_CARD, "p-3")}>
        <h3 className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wide text-on-surface">Intent</h3>
        {data.intent.text ? (
          <MarkdownViewer content={data.intent.text} hideFrontmatter hideRawToggle />
        ) : (
          <p className="font-mono text-[11px] text-on-surface-variant">— {data.intent.degrade ?? "no intent recorded"}</p>
        )}
        {data.intent.media.map((m, i) => (
          <div key={i} className="mt-2">
            <InlineMedia media={m} ctx={ctx} />
          </div>
        ))}
      </section>

      <section data-testid="plan-section" className={cn(VELLUM_CARD, "space-y-2 p-3")}>
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wide text-on-surface">Plan</h3>
        {data.plan.concise.text ? (
          <MarkdownViewer content={data.plan.concise.text} hideFrontmatter hideRawToggle />
        ) : (
          <p className="font-mono text-[11px] text-on-surface-variant">— not planned yet</p>
        )}
        {data.plan.concise.media.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {data.plan.concise.media.map((m, i) => (
              <InlineMedia key={i} media={m} ctx={ctx} />
            ))}
          </div>
        ) : null}
        {data.plan.lockedArtifacts.length > 0 ? (
          <div data-testid="plan-locked-set">
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">the locked set (this is what gets built)</p>
            <ul className="space-y-0.5">
              {data.plan.lockedArtifacts.map((a) => (
                <li key={a.path} className="font-mono text-[11px]">
                  <EvidenceOpener evidenceRef={a.path} ctx={ctx} testId={`plan-artifact-${a.name}`} />
                  <span className="ml-1 text-[9px] uppercase text-on-surface-variant">{a.kind}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <LockStamp lock={data.plan.lock} label="plan-lock (this set gets built)" />
          {data.plan.ssotPath ? (
            <FileReferenceTrigger
              testId="plan-full-prd"
              className="font-mono text-[10px] uppercase text-on-surface-variant underline underline-offset-2 hover:text-on-surface"
              data={{
                path: data.plan.ssotPath,
                kind: "markdown",
                root: ctx.root ?? undefined,
                // ssotPath is WORKSPACE-relative; the fetchable target under
                // the resolved root is the slice-dir FILE. relPath "" is a
                // LEGAL exact-root resolution -> the bare filename (the
                // 23ca5031 over-prefix class); relPath null -> no root
                // target, absolutePath is the fallback.
                readPath:
                  ctx.relPath !== null
                    ? ctx.relPath
                      ? `${ctx.relPath}/${data.plan.ssotPath.split("/").pop()!}`
                      : data.plan.ssotPath.split("/").pop()!
                    : undefined,
                absolutePath: ctx.slicePath ? `${ctx.slicePath}/${data.plan.ssotPath.split("/").pop()!}` : null,
              }}
            >
              full PRD →
            </FileReferenceTrigger>
          ) : null}
        </div>
      </section>

      <DeliveredSection d={data.delivered} ctx={ctx} />

      <VerifyLineageCard lineage={data.lineage} />

      {/* Band 4: SETTLED — the two deliberate stamps (§4). */}
      <section data-testid="settled-band" className={cn(VELLUM_CARD, "space-y-1 p-3")}>
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">SETTLED</h3>
        <LockStamp lock={data.plan.lock} label="gate 1 · plan-lock (plan ↔ intent)" />
        <LockStamp lock={data.delivered.lock} label="gate 2 · proof-lock (delivered ↔ plan) — the done stamp" />
      </section>
    </div>
  );
}
