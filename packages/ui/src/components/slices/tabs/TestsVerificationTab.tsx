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
import { ToolMark } from "../../graphics/RuntimeMark.js";
import { ProofPacketHeader } from "../../project/ProjectMetaPrimitives.js";
import { ProofImageViewer } from "../../project/ProofImageViewer.js";

const BADGE_TEST_TONE_CLASSES: Record<ProofPacketRendered["passFailBadge"], string> = {
  pass: "text-emerald-900",
  fail: "text-red-900",
  partial: "text-amber-900",
  unknown: "text-on-surface",
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
      <div className="rounded-lg border bg-surface-lowest p-4 font-mono text-sm"
        data-testid="tests-empty"
      >
        <div className="text-sm font-medium text-on-surface-variant" style={{ fontFamily: "inherit" }}>
          No proof packet matched
        </div>
        <p
          data-testid="tests-empty-reason"
          className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface"
        >
          The proof matcher did not find a dogfood-evidence directory whose
          name contains this slice id. Evidence may still exist under the
          configured evidence root or under a related mission folder.
        </p>
        <div
          data-testid="tests-empty-diagnostics"
          className="mt-3 grid gap-2 text-xs text-on-surface-variant sm:grid-cols-3"
        >
          <Metric label="Qitems" value={qitemCount ?? 0} />
          <Metric label="Indexed files" value={docsCount ?? 0} />
          <Metric label="Last activity" value={formatMaybeDate(lastActivityAt ?? null)} />
        </div>
        <ul
          data-testid="tests-empty-next-steps"
          className="mt-3 list-disc space-y-1 pl-4 text-xs leading-relaxed text-on-surface-variant"
        >
          <li>Check Artifacts for slice-local files and commit refs.</li>
          <li>Check the evidence root for dogfood screenshots or proof notes with related names.</li>
          <li>When a proof packet is added with a matching directory name, this tab will render it inline.</li>
        </ul>
      </div>
    );
  }
  return (
    <div data-testid="tests-tab" className="p-4 space-y-4 text-sm">
      <header className="flex items-center justify-between border-b border-outline-variant pb-2">
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-on-surface">
          <ToolMark tool="proof" size="xs" />
          Tests / Verification
        </div>
        <div className="font-mono text-xs tabular-nums text-on-surface-variant" data-testid="tests-aggregate">
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
    <div className="rounded-lg border bg-surface-lowest px-2 py-1">
      <div className="text-xs text-on-surface-variant">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs tabular-nums text-on-surface">{value}</div>
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
      className="overflow-hidden rounded-lg border bg-surface-lowest shadow-sm"
      data-testid={`tests-packet-${packet.dirName}`}
    >
      <header className="flex items-center justify-between border-b border-outline-variant bg-background px-3 py-2">
        <div
          className={`min-w-0 flex-1 ${BADGE_TEST_TONE_CLASSES[packet.passFailBadge]}`}
          data-testid={`tests-packet-badge-${packet.dirName}`}
        >
          <ProofPacketHeader title={packet.dirName} badge={packet.passFailBadge} />
        </div>
      </header>
      <div className="p-3 space-y-3">
        {packet.primaryMarkdown && (
          <div data-testid={`tests-packet-primary-md-${packet.dirName}`}>
            <div className="mb-1 font-mono text-xs text-on-surface-variant">
              <ToolMark tool={packet.primaryMarkdown.relPath} size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              {packet.primaryMarkdown.relPath}
            </div>
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-xs text-on-surface">
              {packet.primaryMarkdown.content}
            </pre>
          </div>
        )}

        {packet.screenshots.length > 0 && (
          <section data-testid={`tests-packet-screenshots-${packet.dirName}`}>
            <div className="mb-1 text-xs font-medium text-on-surface-variant">
              <ToolMark tool="screenshot" size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              Screenshots ({packet.screenshots.length})
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {packet.screenshots.map((rel) => (
                <figure key={rel} className="overflow-hidden rounded-lg border">
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
                      className="block w-full bg-surface-low"
                    />
                  </button>
                  <figcaption className="truncate bg-background px-2 py-1 font-mono text-xs text-on-surface-variant">
                    <ToolMark tool={rel} size="xs" className="mr-1 inline-block align-[-2px]" decorative />
                    {rel}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}
        <ProofImageViewer
          sliceName={sliceName}
          relPath={selectedScreenshot}
          onClose={() => setSelectedScreenshot(null)}
          testId="tests-screenshot-viewer"
          imageTestId="tests-screenshot-viewer-image"
          closeTestId="tests-screenshot-viewer-close"
        />

        {packet.videos.length > 0 && (
          <section data-testid={`tests-packet-videos-${packet.dirName}`}>
            <div className="mb-1 text-xs font-medium text-on-surface-variant">
              <ToolMark tool="video" size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              Videos ({packet.videos.length})
            </div>
            <div className="space-y-3">
              {packet.videos.map((rel) => (
                <figure key={rel} className="overflow-hidden rounded-lg border">
                  <video
                    data-testid={`tests-packet-video-${rel}`}
                    src={proofAssetUrl(sliceName, rel)}
                    controls
                    preload="metadata"
                    className="block w-full bg-black"
                  />
                  <figcaption className="truncate bg-background px-2 py-1 font-mono text-xs text-on-surface-variant">
                    {rel}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {packet.traces.length > 0 && (
          <section data-testid={`tests-packet-traces-${packet.dirName}`}>
            <div className="mb-1 text-xs font-medium text-on-surface-variant">
              <ToolMark tool="trace" size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              Traces (download)
            </div>
            <ul className="font-mono text-xs">
              {packet.traces.map((rel) => (
                <li key={rel}>
                  <a
                    href={proofAssetUrl(sliceName, rel)}
                    download
                    className="inline-flex items-center gap-1 text-brand hover:underline"
                  >
                    <ToolMark tool={rel} size="xs" decorative />
                    {rel}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {packet.additionalMarkdown.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-on-surface" data-testid={`tests-packet-additional-md-toggle-${packet.dirName}`}>
              Additional markdown ({packet.additionalMarkdown.length})
            </summary>
            <div className="mt-2 space-y-2">
              {packet.additionalMarkdown.map((md) => (
                <div key={md.relPath}>
                  <div className="inline-flex items-center gap-1 font-mono text-xs text-on-surface-variant">
                    <ToolMark tool={md.relPath} size="xs" decorative />
                    {md.relPath}
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-background p-2 font-mono text-xs text-on-surface">{md.content}</pre>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}
