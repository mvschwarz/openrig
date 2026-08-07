// Living Notes Packet 2 — approval-triggered frozen export (OPR.0.4.4.20 FR-6).
//
// ONE synchronous compose-and-freeze path, invoked AFTER the approval
// stamp + audit row commit (Packet 1 FR-9's side of the interface cell).
// The renderer is a MINIMAL string-template renderer (arch pin): the
// composed doc -> one static, self-contained HTML file — CSS inline,
// images inlined as data: URIs, video referenced by LINK with its poster
// inline, zero external fetches, zero heavy dependencies. The contract is
// the ACs (file:// self-contained), not the twin build's vite plugin —
// that plugin is build-time prior art, mirrored here at runtime, not reused.
//
// Failure semantics: the stamp and audit row are never touched here — a
// failed render never un-approves. The write is exclusive-create through
// the daemon's atomic file-write path (allowlist-governed, actor-audited);
// an existing export makes re-invocation an idempotent no-op.

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileWriteService } from "../files/file-write-service.js";
import { FileWriteError } from "../files/file-write-service.js";
import type { AllowlistRoot } from "../files/path-safety.js";
import type { ComposedSliceReview, LockState, VerdictCell } from "./types.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function dataUri(absPath: string): string | null {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  try {
    return `data:${mime};base64,${fs.readFileSync(absPath).toString("base64")}`;
  } catch {
    return null;
  }
}

function verdictChip(cell: VerdictCell): string {
  // G1: the chip text is the RECORDED token verbatim; tone is a separate class.
  const token = cell.recordedToken ?? "missing";
  return `<span class="chip tone-${cell.tone}">${esc(cell.role)}: ${esc(token)}</span>`;
}

/**
 * Slice-dir containment for media inlining (rev1 fixback at d6135921 — the
 * slice-19 path-containment class): the frozen export is the designed future
 * broadcast payload, so a traversal/symlink ref must NEVER data-URI-inline a
 * file from outside the slice dir. Resolve-prefix check first, then a
 * realpath check on existing files so a symlink inside the slice cannot
 * escape either. Returns the safe absolute path, or null (renders the muted
 * unavailable branch — never silent, never inlined).
 */
function containedMediaPath(sliceDir: string, ref: string): string | null {
  if (ref.startsWith("/")) return null;
  const rootResolved = path.resolve(sliceDir);
  const resolved = path.resolve(sliceDir, ref);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(rootResolved);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch {
    // Missing file: containment already proven by the resolve-prefix check;
    // the caller's existsSync/dataUri handles absence with the muted branch.
    return resolved;
  }
}

/** Renders media found in the slice dir: images inline, video by link + poster. */
function mediaBlock(sliceDir: string, mediaRefs: string[]): string {
  const parts: string[] = [];
  const images = mediaRefs.filter((r) => IMAGE_EXTS.has(path.extname(r).toLowerCase()));
  const videos = mediaRefs.filter((r) => VIDEO_EXTS.has(path.extname(r).toLowerCase()));
  for (const ref of images) {
    const safe = containedMediaPath(sliceDir, ref);
    const uri = safe ? dataUri(safe) : null;
    if (uri) parts.push(`<figure><img src="${uri}" alt="${esc(ref)}"><figcaption>${esc(ref)}</figcaption></figure>`);
    else parts.push(`<p class="muted">${safe ? "image unavailable" : "media outside slice dir"}: ${esc(ref)}</p>`);
  }
  for (const ref of videos) {
    if (containedMediaPath(sliceDir, ref) === null) {
      parts.push(`<p class="muted">media outside slice dir: ${esc(ref)}</p>`);
      continue;
    }
    // Video is NEVER embedded (single-file simplicity); the co-located
    // screenshot poster (same basename) inlines beside the link when present.
    const base = ref.slice(0, ref.length - path.extname(ref).length);
    const poster = [".png", ".jpg", ".jpeg"]
      .map((e) => `${base}${e}`)
      .find((p) => {
        const safePoster = containedMediaPath(sliceDir, p);
        return safePoster !== null && fs.existsSync(safePoster);
      });
    const safePosterPath = poster ? containedMediaPath(sliceDir, poster) : null;
    const posterUri = safePosterPath ? dataUri(safePosterPath) : null;
    parts.push(
      `<figure>${posterUri ? `<img src="${posterUri}" alt="poster for ${esc(ref)}">` : ""}` +
        `<figcaption>video (by link): <a href="${esc(ref)}">${esc(ref)}</a></figcaption></figure>`,
    );
  }
  return parts.join("\n");
}

const STYLE = `
body{font-family:ui-serif,Georgia,serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1c1917;background:#fafaf9}
h1,h2{font-family:ui-sans-serif,system-ui,sans-serif}
.chip{display:inline-block;border:1px solid #a8a29e;border-radius:4px;padding:.1rem .45rem;margin:.1rem;font-family:ui-monospace,monospace;font-size:.8rem}
.tone-pass{background:#dcfce7}.tone-fail{background:#fee2e2}.tone-unknown{background:#f5f5f4}
.locked{border:2px solid #1c1917;padding:.6rem 1rem;margin:1rem 0;font-weight:600}
.unverified{border:3px solid #b91c1c;color:#b91c1c;padding:.6rem 1rem;margin:1rem 0;font-weight:700}
.muted{color:#78716c}
.col{border:1px solid #d6d3d1;padding: .75rem;margin:.5rem 0}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d6d3d1;padding:.3rem .5rem;text-align:left;font-size:.9rem}
img{max-width:100%;height:auto;border:1px solid #d6d3d1}
figure{margin:1rem 0}figcaption{font-size:.8rem;color:#78716c}
pre{white-space:pre-wrap;font-family:inherit}
`;

function stampLine(label: string, lock: LockState | null): string {
  if (!lock) return `<p class="muted">○ ${esc(label)} — not stamped</p>`;
  return lock.auditVerified
    ? `<div class="locked">✓ ${esc(label)} — ${esc(lock.by)} at ${esc(lock.at)}</div>`
    : `<div class="unverified">UNVERIFIED ${esc(label)} stamp — frontmatter claims ${esc(lock.by)} at ${esc(lock.at)} but NO matching audit row exists</div>`;
}

const VERIFIED_WORDS: Record<string, string> = {
  verified: "✓ QA-verified against the plan",
  unverified: "◇ unverified — no recorded QA comparison",
  missing: "✗ missing — promised, nothing delivered",
};

/** The frozen single-file HTML for a composed slice review — the ONE
 *  INTENT → PLAN → DELIVERED stack (CORRECTIVE §3.1), mirrored statically. */
export function renderFrozenSliceHtml(composed: ComposedSliceReview, sliceDir: string, mediaRefs: string[]): string {
  const lineage = composed.lineage;
  const deliveredRows = composed.delivered.items
    .map(
      (it) =>
        `<tr><td>${esc(it.promised.text)}</td><td>${esc(VERIFIED_WORDS[it.verified] ?? it.verified)}</td><td>${esc(it.note ?? "—")}</td><td>${it.proof.length === 0 ? "—" : it.proof.map((p) => esc(p.src)).join("<br>")}</td></tr>`,
    )
    .join("\n");

  // Evidence media = the source-scan refs plus the curated proof set
  // (slice-relative srcs) — inlined via the same contained-path discipline.
  const evidenceRefs = [
    ...new Set([
      ...mediaRefs,
      ...composed.delivered.items.flatMap((it) => it.proof.map((p) => p.src)),
      ...composed.delivered.extraProof.map((p) => p.src),
    ]),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>REVIEW — ${esc(composed.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${esc(composed.title)}</h1>
<p class="muted">${esc(composed.slice)}${composed.sliceId ? ` · ${esc(composed.sliceId)}` : ""} · lane ${esc(composed.laneLabel)} · frozen from composition at ${esc(composed.composedAt)}</p>
${stampLine("proof-lock (done)", composed.delivered.lock)}

<h2>Verify lineage</h2>
<p>proven-at: <code>${esc(lineage.candidateSha ?? "unknown")}</code> · merged-at: <code>${esc(lineage.mergeSha ?? "UNMERGED")}</code> · main tip: <code>${esc(lineage.mainTip)}</code> · ${esc(lineage.freshness)}${lineage.staleBehind !== null ? ` (${lineage.staleBehind} behind)` : ""}</p>
<p>${lineage.gateCells.map(verdictChip).join(" ")}</p>

<h2>Intent</h2>
<div class="col"><pre>${esc(composed.intent.text ?? composed.intent.degrade)}</pre></div>

<h2>Plan</h2>
<div class="col"><pre>${esc(composed.plan.concise.text ?? "—")}</pre>
${composed.plan.lockedArtifacts.length > 0 ? `<p class="muted">locked set: ${composed.plan.lockedArtifacts.map((a) => `${esc(a.name)} (${esc(a.kind)}: ${esc(a.path)})`).join(" · ")}</p>` : ""}
${stampLine("plan-lock (this set gets built)", composed.plan.lock)}</div>

<h2>Delivered</h2>
${composed.delivered.items.length === 0 ? `<p class="muted">no proof contract declared in the plan</p>` : `<table><tr><th>promised</th><th>verified</th><th>QA note</th><th>curated proof</th></tr>${deliveredRows}</table>`}
${composed.delivered.extraProof.length > 0 ? `<p class="muted">extra proof (not tied to one deliverable): ${composed.delivered.extraProof.map((p) => esc(p.src)).join(" · ")}</p>` : ""}

<h2>Evidence</h2>
${mediaBlock(sliceDir, evidenceRefs)}

<h2>Needs-you at freeze time</h2>
${composed.needsYou.items.length === 0 ? `<p class="muted">${esc(composed.needsYou.provenance)}</p>` : `<ul>${composed.needsYou.items.map((i) => `<li>${esc(i.summary)} <span class="muted">(${esc(i.leg)})</span></li>`).join("\n")}</ul>`}

${composed.defects.length > 0 ? `<h2>Defect findings</h2><ul>${composed.defects.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
</body>
</html>
`;
}

export function frozenFileName(scopeId: string | null, fallbackName: string, approvedAtIso: string | null): string {
  const id = (scopeId ?? fallbackName).replaceAll("/", "-");
  const date = approvedAtIso ? approvedAtIso.slice(0, 10) : "undated";
  return `REVIEW-${id}-${date}.html`;
}

export type FreezeOutcome =
  | { ok: true; path: string; alreadyFrozen: boolean }
  | { ok: false; error: "stamp_missing" | "not_found" | "allowlist_missing" | "write_failed"; message: string; hint?: string };

/** Maps an absolute dir into (allowlist root, relative path) or null. */
export function resolveAllowlisted(allowlist: AllowlistRoot[], absDir: string): { root: string; rel: string } | null {
  let real: string;
  try {
    real = fs.realpathSync(absDir);
  } catch {
    return null;
  }
  for (const r of allowlist) {
    if (real === r.canonicalPath || real.startsWith(r.canonicalPath + path.sep)) {
      return { root: r.name, rel: path.relative(r.canonicalPath, real) };
    }
  }
  return null;
}

export function freezeSliceExport(opts: {
  composed: ComposedSliceReview;
  sliceDir: string;
  mediaRefs: string[];
  allowlist: AllowlistRoot[];
  writeService: FileWriteService;
  actor: string;
  /** P21 §4 era-stamp for the freeze audit row: `transport:v1` (transport-derived) or null
   *  (the UI named-deferral / claimed-era path). Threaded to the createAtomic audit. */
  identityProvenance?: string | null;
}): FreezeOutcome {
  const { composed } = opts;
  if (!composed.delivered.lock) {
    return {
      ok: false,
      error: "stamp_missing",
      message: `slice '${composed.slice}' carries no delivery approval stamp; the freeze fires only after the approve verb commits (stamp + audit row stand regardless of this render)`,
    };
  }
  const mapped = resolveAllowlisted(opts.allowlist, opts.sliceDir);
  if (!mapped) {
    return {
      ok: false,
      error: "allowlist_missing",
      message: `slice folder '${opts.sliceDir}' is not under any OPENRIG_FILES_ALLOWLIST root — the freeze write path is allowlist-governed`,
      hint: `add OPENRIG_FILES_ALLOWLIST=<name>:${path.dirname(opts.sliceDir)} (or a parent root) and restart the daemon`,
    };
  }
  const fileName = frozenFileName(composed.sliceId, composed.slice, composed.delivered.lock.at);
  const relPath = path.join(mapped.rel, fileName);
  const html = renderFrozenSliceHtml(composed, opts.sliceDir, opts.mediaRefs);
  try {
    const result = opts.writeService.createAtomic({ rootName: mapped.root, path: relPath, content: html, actor: opts.actor, identityProvenance: opts.identityProvenance ?? null });
    return { ok: true, path: result.absolutePath, alreadyFrozen: false };
  } catch (err) {
    if (err instanceof FileWriteError && err.code === "target_exists") {
      // Idempotent re-invoke for the same approval: the export already exists
      // and frozen exports are never rewritten (invariant 8).
      return { ok: true, path: path.join(opts.sliceDir, fileName), alreadyFrozen: true };
    }
    return {
      ok: false,
      error: "write_failed",
      message: `freeze render/write failed (the approval stamp and audit row still stand; re-invoke after fixing): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
