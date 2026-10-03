// Living Notes Packet 2 — evidence-open behaviors (OPR.0.4.4.20 FR-11).
//
// Every evidence_ref opens IN a live, already-shipped component — never a new
// viewer family:
//   .md      → FileViewer in the SharedDetailDrawer (FileReferenceTrigger)
//   image    → the live proof Lightbox (extracted from ProofTab)
//   video    → inline <video playsinline preload="metadata"> via /api/files/asset
//   folder   → ArtifactsNavigator scoped to the folder (OPENRIG_FILES_ALLOWLIST-governed)
//   .html    → rendered page in a NEW TAB via ?render=1 (the named net-new opt-in;
//              served with a script-free CSP)
// Dead code (ProofImageViewer / TestsVerificationTab viewer / DocsTab) stays dead.

import { useState } from "react";
import { FileReferenceTrigger } from "../drawer-triggers/FileReferenceTrigger.js";
import { ArtifactsNavigator } from "../project/ArtifactsNavigator.js";
import { Lightbox } from "../project/Lightbox.js";
import { fileAssetUrl } from "../../hooks/useFiles.js";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const VIDEO_EXTS = [".mp4", ".webm", ".mov"];

export interface EvidenceContext {
  /** Allowlist resolution of the slice dir (from useScopeMarkdown.resolved). */
  root: string | null;
  relPath: string | null;
  /** Absolute slice dir (folder opens). */
  slicePath: string | null;
}

type Kind = "markdown" | "image" | "video" | "html" | "folder" | "other";

/** Slice-scope containment for evidence refs (rev1-r2 fixback at d6135921):
 *  the PRD's media contract is slice-CO-LOCATED, slice-RELATIVE refs — an
 *  absolute ref or any `..` segment escapes the slice boundary and must be
 *  refused BEFORE any URL/scope is built (a named visible error, never a
 *  silent open of sibling/parent content that still looks like evidence). */
export function evidenceRefContained(ref: string): boolean {
  return !ref.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(ref);
}

function classify(ref: string): Kind {
  const lower = ref.toLowerCase();
  if (lower.endsWith("/") || !/\.[a-z0-9]+$/.test(lower)) return "folder";
  if (lower.endsWith(".md")) return "markdown";
  if (IMAGE_EXTS.some((e) => lower.endsWith(e))) return "image";
  if (VIDEO_EXTS.some((e) => lower.endsWith(e))) return "video";
  if (lower.endsWith(".html")) return "html";
  return "other";
}

function assetUrlFor(ctx: EvidenceContext, ref: string): string | null {
  if (ref.startsWith("/")) return null; // absolute — FR-5 treats these as defect findings
  if (!ctx.root) return null;
  const rel = ctx.relPath ? `${ctx.relPath}/${ref}` : ref;
  return fileAssetUrl(ctx.root, rel);
}

export function EvidenceOpener({ evidenceRef, ctx, testId }: { evidenceRef: string; ctx: EvidenceContext; testId?: string }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const tid = testId ?? "evidence-opener";
  if (!evidenceRefContained(evidenceRef)) {
    return (
      <span data-testid={`${tid}-outside-scope`} className="font-mono text-[11px] text-red-700">
        evidence ref escapes the slice scope (must be slice-relative): {evidenceRef}
      </span>
    );
  }
  // No resolvable base (e.g. the rig altitude, which has no slice dir): ONE
  // named degrade for every ref kind — the honest non-openable pointer plus
  // its reason (the ref opens fully at the slice drill). Also load-bearing
  // for markdown: a FileReferenceTrigger without a readable target opens a
  // dead drawer (eternal Loading) — never render an opener here.
  if (!ctx.root && !ctx.slicePath) {
    return (
      <span className="font-mono text-[11px] text-on-surface-variant">
        <span data-testid={`${tid}-pointer`}>{evidenceRef}</span>
        <span className="ml-1 text-[10px]">(not openable from this view — no slice context)</span>
      </span>
    );
  }
  const kind = classify(evidenceRef);
  const url = assetUrlFor(ctx, evidenceRef);
  const linkClass = "font-mono text-[11px] underline text-on-surface hover:text-on-surface-variant";

  if (kind === "markdown") {
    return (
      <FileReferenceTrigger
        testId={`${tid}-md`}
        className={`${linkClass} text-left`}
        data={{
          path: evidenceRef,
          kind: "markdown",
          root: ctx.root ?? undefined,
          readPath: ctx.relPath ? `${ctx.relPath}/${evidenceRef}` : evidenceRef,
          absolutePath: evidenceRef.startsWith("/") ? evidenceRef : ctx.slicePath ? `${ctx.slicePath}/${evidenceRef}` : null,
        }}
      >
        {evidenceRef}
      </FileReferenceTrigger>
    );
  }

  if (kind === "image") {
    return (
      <>
        <button type="button" data-testid={`${tid}-image`} className={linkClass} onClick={() => setLightboxSrc(url)}>
          {evidenceRef}
        </button>
        <Lightbox src={lightboxSrc} alt={evidenceRef} onClose={() => setLightboxSrc(null)} />
      </>
    );
  }

  if (kind === "video") {
    if (!url) return <span className="font-mono text-[11px] text-red-700">unresolvable media ref: {evidenceRef}</span>;
    // FR-5: inline playback, playsinline + preload=metadata (arch AC ruling);
    // the co-located screenshot poster is same-basename when present.
    const poster = assetUrlFor(ctx, evidenceRef.replace(/\.[a-z0-9]+$/i, ".png"));
    return (
      <video
        data-testid={`${tid}-video`}
        controls
        playsInline
        preload="metadata"
        poster={poster ?? undefined}
        src={url}
        className="max-h-64 w-full border border-outline-variant bg-stone-950"
      />
    );
  }

  if (kind === "html") {
    if (!url) return <span className="font-mono text-[11px] text-red-700">unresolvable mockup ref: {evidenceRef}</span>;
    return (
      <a data-testid={`${tid}-html`} className={linkClass} href={`${url}&render=1`} target="_blank" rel="noreferrer">
        {evidenceRef} ↗
      </a>
    );
  }

  if (kind === "folder") {
    const scopePath = evidenceRef.startsWith("/")
      ? evidenceRef
      : ctx.slicePath
        ? `${ctx.slicePath}/${evidenceRef.replace(/\/$/, "")}`
        : null;
    return (
      <div>
        <button type="button" data-testid={`${tid}-folder`} className={linkClass} onClick={() => setFolderOpen((v) => !v)}>
          {evidenceRef} {folderOpen ? "▾" : "▸"}
        </button>
        {folderOpen && scopePath ? (
          <div className="mt-2 border border-outline-variant">
            <ArtifactsNavigator scopePath={scopePath} scopeLabel={evidenceRef} />
          </div>
        ) : null}
        {folderOpen && !scopePath ? (
          <p className="font-mono text-[11px] text-red-700">folder outside the slice scope: {evidenceRef}</p>
        ) : null}
      </div>
    );
  }

  return url ? (
    <a className={linkClass} href={url} target="_blank" rel="noreferrer" data-testid={`${tid}-other`}>
      {evidenceRef}
    </a>
  ) : (
    <span className="font-mono text-[11px]">{evidenceRef}</span>
  );
}
