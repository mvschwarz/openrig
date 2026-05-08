// Slice Story View v0 — Tests / Verification tab.
//
// Load-bearing capability: inline screenshot images and provide a working
// <video> player when proof packets carry them.
//
// Per PRD audit row 6 amendment: real proof-packet layout differs from
// the original PRD proposal — directories like
// `dogfood-evidence/<prefix>-<slice>-<date>/` with `*.md` at top level,
// `screenshots/*.png`, and optional `headed-browser/screenshots/`.
// Videos are not yet captured by QA; the tab handles that gracefully
// (empty videos array → no <video> element rendered, no error).
//
// Aggregate pass/fail badge sits in the header and reflects a heuristic
// pass/fail extracted from the primary markdown. The actual canonical
// answer is in the markdown body which is rendered inline.

import { useState } from "react";
import type { SliceDetail, ProofPacketRendered } from "../../../hooks/useSlices.js";
import { proofAssetUrl } from "../../../hooks/useSlices.js";

const BADGE_CLASSES: Record<ProofPacketRendered["passFailBadge"], string> = {
  pass: "border-emerald-300 bg-emerald-50 text-emerald-900",
  fail: "border-red-300 bg-red-50 text-red-900",
  partial: "border-amber-300 bg-amber-50 text-amber-900",
  unknown: "border-stone-300 bg-stone-50 text-stone-700",
};

export function TestsVerificationTab({
  sliceName,
  tests,
  qitemCount,
  docsCount,
  lastActivityAt,
}: {
  sliceName: string;
  tests: SliceDetail["tests"];
  qitemCount?: number;
  docsCount?: number;
  lastActivityAt?: string | null;
}) {
  if (tests.proofPackets.length === 0) {
    return (
      <div
        className="border border-outline-variant bg-white/20 p-4 font-mono"
        data-testid="tests-empty"
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">
          No proof packet matched
        </div>
        <p
          data-testid="tests-empty-reason"
          className="mt-2 max-w-2xl text-[11px] leading-relaxed text-stone-700"
        >
          The proof matcher did not find a dogfood-evidence directory whose
          name contains this slice id. Evidence may still exist under the
          configured evidence root or under a related mission folder.
        </p>
        <div
          data-testid="tests-empty-diagnostics"
          className="mt-3 grid gap-2 text-[10px] text-stone-600 sm:grid-cols-3"
        >
          <Metric label="Qitems" value={qitemCount ?? 0} />
          <Metric label="Indexed files" value={docsCount ?? 0} />
          <Metric label="Last activity" value={formatMaybeDate(lastActivityAt ?? null)} />
        </div>
        <ul
          data-testid="tests-empty-next-steps"
          className="mt-3 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-stone-600"
        >
          <li>Check Artifacts for slice-local files and commit refs.</li>
          <li>Check the evidence root for dogfood screenshots or proof notes with related names.</li>
          <li>When a proof packet is added with a matching directory name, this tab will render it inline.</li>
        </ul>
      </div>
    );
  }
  return (
    <div data-testid="tests-tab" className="p-4 space-y-4">
      <header className="flex items-center justify-between border-b border-stone-200 pb-2">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-stone-700">
          Tests / Verification
        </div>
        <div className="font-mono text-[10px] text-stone-500" data-testid="tests-aggregate">
          {tests.aggregate.passCount} pass, {tests.aggregate.failCount} fail
          {" · "}{tests.proofPackets.length} packet{tests.proofPackets.length === 1 ? "" : "s"}
        </div>
      </header>
      {tests.proofPackets.map((packet) => (
        <ProofPacketSection key={packet.dirName} sliceName={sliceName} packet={packet} />
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-outline-variant bg-white/30 px-2 py-1">
      <div className="text-[8px] uppercase tracking-[0.12em] text-stone-400">{label}</div>
      <div className="mt-0.5 truncate text-stone-900">{value}</div>
    </div>
  );
}

function formatMaybeDate(ts: string | null): string {
  if (!ts) return "unknown";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

function ProofPacketSection({ sliceName, packet }: { sliceName: string; packet: ProofPacketRendered }) {
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);
  return (
    <article
      className="border border-stone-200 bg-white"
      data-testid={`tests-packet-${packet.dirName}`}
    >
      <header className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-3 py-2">
        <div className="font-mono text-[10px] text-stone-700 truncate">{packet.dirName}</div>
        <span
          data-testid={`tests-packet-badge-${packet.dirName}`}
          className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${BADGE_CLASSES[packet.passFailBadge]}`}
        >
          {packet.passFailBadge}
        </span>
      </header>
      <div className="p-3 space-y-3">
        {packet.primaryMarkdown && (
          <div data-testid={`tests-packet-primary-md-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500">
              {packet.primaryMarkdown.relPath}
            </div>
            <pre className="whitespace-pre-wrap break-words bg-stone-50 p-3 font-mono text-[10px] text-stone-800">
              {packet.primaryMarkdown.content}
            </pre>
          </div>
        )}

        {packet.screenshots.length > 0 && (
          <section data-testid={`tests-packet-screenshots-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500">
              Screenshots ({packet.screenshots.length})
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {packet.screenshots.map((rel) => (
                <figure key={rel} className="border border-stone-200">
                  <button
                    type="button"
                    data-testid={`tests-packet-screenshot-open-${rel}`}
                    onClick={() => setSelectedScreenshot(rel)}
                    className="block w-full text-left"
                  >
                    <img
                      data-testid={`tests-packet-screenshot-${rel}`}
                      src={proofAssetUrl(sliceName, rel)}
                      alt={rel}
                      loading="lazy"
                      className="block w-full bg-stone-100"
                    />
                  </button>
                  <figcaption className="bg-stone-50 px-2 py-1 font-mono text-[9px] text-stone-500 truncate">
                    {rel}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}
        {selectedScreenshot ? (
          <div
            role="dialog"
            aria-label="Screenshot preview"
            data-testid="tests-screenshot-viewer"
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-6"
            onClick={() => setSelectedScreenshot(null)}
          >
            <div
              className="max-h-full max-w-[92vw] bg-black/80 p-2"
              onClick={(event) => event.stopPropagation()}
            >
              <img
                data-testid="tests-screenshot-viewer-image"
                src={proofAssetUrl(sliceName, selectedScreenshot)}
                alt={selectedScreenshot}
                className="max-h-[82vh] max-w-full object-contain"
              />
              <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px] text-stone-100">
                <span className="truncate">{selectedScreenshot}</span>
                <button
                  type="button"
                  data-testid="tests-screenshot-viewer-close"
                  onClick={() => setSelectedScreenshot(null)}
                  className="border border-white/40 px-2 py-1 uppercase tracking-[0.12em] hover:bg-white/10"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {packet.videos.length > 0 && (
          <section data-testid={`tests-packet-videos-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500">
              Videos ({packet.videos.length})
            </div>
            <div className="space-y-3">
              {packet.videos.map((rel) => (
                <figure key={rel} className="border border-stone-200">
                  <video
                    data-testid={`tests-packet-video-${rel}`}
                    src={proofAssetUrl(sliceName, rel)}
                    controls
                    preload="metadata"
                    className="block w-full bg-black"
                  />
                  <figcaption className="bg-stone-50 px-2 py-1 font-mono text-[9px] text-stone-500 truncate">
                    {rel}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {packet.traces.length > 0 && (
          <section data-testid={`tests-packet-traces-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500">
              Traces (download)
            </div>
            <ul className="font-mono text-[10px]">
              {packet.traces.map((rel) => (
                <li key={rel}>
                  <a
                    href={proofAssetUrl(sliceName, rel)}
                    download
                    className="text-blue-700 hover:underline"
                  >
                    {rel}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {packet.additionalMarkdown.length > 0 && (
          <details>
            <summary className="cursor-pointer font-mono text-[10px] text-stone-700" data-testid={`tests-packet-additional-md-toggle-${packet.dirName}`}>
              Additional markdown ({packet.additionalMarkdown.length})
            </summary>
            <div className="mt-2 space-y-2">
              {packet.additionalMarkdown.map((md) => (
                <div key={md.relPath}>
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500">{md.relPath}</div>
                  <pre className="whitespace-pre-wrap break-words bg-stone-50 p-2 font-mono text-[9px] text-stone-700">{md.content}</pre>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}
