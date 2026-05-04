// Slice Story View v0 — Tests / Verification tab.
//
// Founder-named load-bearing capability. Per PRD § Bounce Conditions:
// "Drops Tests tab's screenshot + video embed — bounced." This component
// MUST inline-render screenshot images and provide a working <video>
// player when proof packets carry them.
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

import type { SliceDetail, ProofPacketRendered } from "../../../hooks/useSlices.js";
import { proofAssetUrl } from "../../../hooks/useSlices.js";

const BADGE_CLASSES: Record<ProofPacketRendered["passFailBadge"], string> = {
  pass: "border-emerald-300 bg-emerald-50 text-emerald-900",
  fail: "border-red-300 bg-red-50 text-red-900",
  partial: "border-amber-300 bg-amber-50 text-amber-900",
  unknown: "border-stone-300 bg-stone-50 text-stone-700",
};

export function TestsVerificationTab({ sliceName, tests }: { sliceName: string; tests: SliceDetail["tests"] }) {
  if (tests.proofPackets.length === 0) {
    return (
      <div className="p-4 font-mono text-[10px] text-stone-400" data-testid="tests-empty">
        No proof packet found for this slice yet (looks for a directory under dogfood-evidence/ whose name contains the slice name).
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

function ProofPacketSection({ sliceName, packet }: { sliceName: string; packet: ProofPacketRendered }) {
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
                  <img
                    data-testid={`tests-packet-screenshot-${rel}`}
                    src={proofAssetUrl(sliceName, rel)}
                    alt={rel}
                    loading="lazy"
                    className="block w-full bg-stone-100"
                  />
                  <figcaption className="bg-stone-50 px-2 py-1 font-mono text-[9px] text-stone-500 truncate">
                    {rel}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

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
