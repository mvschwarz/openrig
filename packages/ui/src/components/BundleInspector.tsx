import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBundleInspect, type InspectResult } from "../hooks/useBundles.js";
import { PageHeader } from "@/components/ui/page-header.js";
import { StatusBadge, StatusDot } from "@/components/ui/status-badge.js";
import { WorkspacePage } from "./WorkspacePage.js";

/** C14e: map installer file-integrity states to the shared status vocabulary. */
function fileStatusKey(status: string): string {
  switch (status) {
    case "OK": return "done";
    case "MISMATCH":
    case "MISSING": return "failed";
    case "EXTRA": return "attention_required";
    default: return status;
  }
}

/** C14e: map installer file-integrity states to sentence-case labels. */
function fileStatusLabel(status: string): string {
  switch (status) {
    case "OK": return "Ok";
    case "MISMATCH": return "Mismatch";
    case "MISSING": return "Missing";
    case "EXTRA": return "Extra";
    default: return status.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

export function BundleInspector() {
  const [bundlePath, setBundlePath] = useState("");
  const inspectMutation = useBundleInspect();

  const handleInspect = () => {
    if (!bundlePath.trim()) return;
    inspectMutation.mutate({ bundlePath: bundlePath.trim() });
  };

  const result = inspectMutation.data;

  return (
    <WorkspacePage>
    <div data-testid="bundle-inspector">
      <PageHeader
        title="Inspect bundle"
        description="Inspect a bundle archive to review its manifest, integrity, and contents before installing."
      />

      <div className="mb-spacing-4">
        <label className="text-xs text-on-surface-variant block mb-spacing-2">Bundle path</label>
        <input
          data-testid="bundle-path-input"
          type="text"
          value={bundlePath}
          onChange={(e) => setBundlePath(e.target.value)}
          placeholder="/path/to/my-rig.rigbundle"
          className="w-full bg-transparent border-b border-foreground/20 py-spacing-2 text-sm font-mono focus:outline-none focus:border-primary"
        />
        <div className="flex items-center justify-between gap-2">
          <span />
          <Button variant="default" onClick={handleInspect} disabled={!bundlePath.trim() || inspectMutation.isPending} className="mt-spacing-3" data-testid="inspect-btn">
            {inspectMutation.isPending ? "Inspecting..." : "Inspect bundle"}
          </Button>
        </div>
      </div>

      {inspectMutation.isError && (
        <div className="text-destructive text-sm mb-spacing-4" data-testid="inspect-error">
          {inspectMutation.error.message}
        </div>
      )}

      {result && (
        <div data-testid="inspect-result">
          {/* Manifest summary */}
          <div className="rounded-lg border bg-surface-lowest p-spacing-4 mb-spacing-4 shadow-sm" data-testid="manifest-summary">
            <div className="flex items-center gap-spacing-2 mb-spacing-2">
              <h3 className="text-sm font-semibold text-on-surface">{result.manifest.name}</h3>
              <span className="text-xs font-mono px-spacing-2 py-px bg-foreground/10" data-testid="schema-badge">
                v{result.manifest.schemaVersion ?? 1}
              </span>
            </div>
            <div className="text-xs font-mono text-on-surface-variant">v{result.manifest.version}</div>
            <div className="text-xs text-on-surface-variant">Spec: <span className="font-mono">{result.manifest.rigSpec}</span></div>
            <div className="mt-spacing-2 flex flex-wrap gap-spacing-3">
              <StatusBadge status={result.digestValid ? "done" : "failed"} label={result.digestValid ? "Digest valid" : "Digest invalid"} />
              <span data-testid="integrity-status">
                <StatusBadge status={result.integrityResult.passed ? "done" : "failed"} label={result.integrityResult.passed ? "Integrity pass" : "Integrity fail"} />
              </span>
            </div>
          </div>

          {/* v2: Agents list, v1: Packages list */}
          {result.manifest.schemaVersion === 2 && result.manifest.agents ? (
            <>
              <h3 className="text-sm font-semibold text-on-surface mb-spacing-3">Agents</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="agent-list">
                {result.manifest.agents.map((agent) => (
                  <div key={agent.name} className="text-xs" data-testid="agent-entry">
                    {agent.name} <span className="font-mono text-on-surface-variant">v{agent.version} — {agent.path}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-on-surface mb-spacing-3">Packages</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="package-list">
                {(result.manifest.packages ?? []).map((pkg) => (
                  <div key={pkg.name} className="text-xs" data-testid="package-entry">
                    {pkg.name} <span className="font-mono text-on-surface-variant">v{pkg.version} — {pkg.path}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Item 1 / slice-05: Provenance block (rendered when bundle carries it) */}
          {result.manifest.provenance && (
            <>
              <h3 className="text-sm font-semibold text-on-surface mb-spacing-3">Provenance</h3>
              <div className="rounded-lg border bg-surface-lowest p-spacing-4 mb-spacing-4 space-y-spacing-1 shadow-sm" data-testid="provenance-block">
                {result.manifest.provenance.createdAt && (
                  <div className="text-xs" data-testid="provenance-createdAt">
                    <span className="text-on-surface-variant">Created: </span><span className="font-mono">{result.manifest.provenance.createdAt}</span>
                  </div>
                )}
                {result.manifest.provenance.sourceHost && (
                  <div className="text-xs" data-testid="provenance-sourceHost">
                    <span className="text-on-surface-variant">Host: </span><span className="font-mono">{result.manifest.provenance.sourceHost}</span>
                  </div>
                )}
                {result.manifest.provenance.authorSession && (
                  <div className="text-xs" data-testid="provenance-authorSession">
                    <span className="text-on-surface-variant">Author: </span><span className="font-mono">{result.manifest.provenance.authorSession}</span>
                  </div>
                )}
                {result.manifest.provenance.sourceRigName && (
                  <div className="text-xs" data-testid="provenance-sourceRigName">
                    <span className="text-on-surface-variant">Rig: </span>{result.manifest.provenance.sourceRigName}
                    {result.manifest.provenance.sourceRigId && (
                      <span className="font-mono text-on-surface-variant"> ({result.manifest.provenance.sourceRigId})</span>
                    )}
                  </div>
                )}
                {(result.manifest.provenance.daemonVersion || result.manifest.provenance.cliVersion) && (
                  <div className="text-xs font-mono" data-testid="provenance-versions">
                    <span className="text-on-surface-variant">Built with: </span>
                    {result.manifest.provenance.daemonVersion && <>daemon {result.manifest.provenance.daemonVersion}</>}
                    {result.manifest.provenance.daemonVersion && result.manifest.provenance.cliVersion && " / "}
                    {result.manifest.provenance.cliVersion && <>cli {result.manifest.provenance.cliVersion}</>}
                  </div>
                )}
                {result.manifest.provenance.notes && (
                  <div className="text-xs whitespace-pre-wrap mt-spacing-2" data-testid="provenance-notes">
                    <span className="text-on-surface-variant">Notes: </span>{result.manifest.provenance.notes}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Item 2 / slice-05: Compatibility block (rendered when bundle carries it). Live "compatible against this daemon" comparison is deferred — UI surfaces the bundle's stated minimums; the install-time check at /api/bundles/install enforces actual compatibility with the running daemon. */}
          {result.manifest.compatibility && (
            <>
              <h3 className="text-sm font-semibold text-on-surface mb-spacing-3">Compatibility</h3>
              <div className="rounded-lg border bg-surface-lowest p-spacing-4 mb-spacing-4 space-y-spacing-1 shadow-sm" data-testid="compatibility-block">
                {result.manifest.compatibility.minDaemonVersion && (
                  <div className="text-xs" data-testid="compatibility-minDaemonVersion">
                    <span className="text-on-surface-variant">Min daemon: </span><span className="font-mono">{result.manifest.compatibility.minDaemonVersion}</span>
                  </div>
                )}
                {result.manifest.compatibility.minCliVersion && (
                  <div className="text-xs" data-testid="compatibility-minCliVersion">
                    <span className="text-on-surface-variant">Min CLI: </span><span className="font-mono">{result.manifest.compatibility.minCliVersion}</span>
                  </div>
                )}
                {result.manifest.compatibility.schemaVersion !== undefined && (
                  <div className="text-xs" data-testid="compatibility-schemaVersion">
                    <span className="text-on-surface-variant">Schema: </span><span className="font-mono">v{result.manifest.compatibility.schemaVersion}</span>
                  </div>
                )}
              </div>
            </>
          )}

          {result.integrityResult.errors.map(message => (
            <p key={message} className="text-destructive text-sm mb-spacing-2">{message}</p>
          ))}
          {(result.integrityResult.warnings ?? []).map(message => (
            <p key={message} className="text-warning text-sm mb-spacing-2">{message}</p>
          ))}

          {/* Per-file integrity */}
          {result.integrityResult && (
            <>
              <h3 className="text-sm font-semibold text-on-surface mb-spacing-3">File integrity</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="file-integrity">
                {Object.keys((result.manifest.packages ?? result.manifest.agents ?? []).length > 0 ? (result as unknown as { manifest: { integrity?: { files: Record<string, string> } } }).manifest?.integrity?.files ?? {} : {}).map((file) => {
                  const isMismatch = result.integrityResult.mismatches.includes(file);
                  const isMissing = result.integrityResult.missing.includes(file);
                  const status = isMismatch ? "MISMATCH" : isMissing ? "MISSING" : "OK";
                  return (
                    <div key={file} className="flex items-center gap-spacing-3 text-xs" data-testid="file-row">
                      <StatusDot status={fileStatusKey(status)} />
                      <span className="font-mono">{file}</span>
                      <span className="text-on-surface-variant ml-auto">{fileStatusLabel(status)}</span>
                    </div>
                  );
                })}
                {result.integrityResult.extra.map((file) => (
                  <div key={file} className="flex items-center gap-spacing-3 text-xs" data-testid="file-row">
                    <StatusDot status={fileStatusKey("EXTRA")} />
                    <span className="font-mono">{file}</span>
                    <span className="text-on-surface-variant ml-auto">{fileStatusLabel("EXTRA")}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Install button */}
          <div className="flex items-center justify-between gap-2">
            <span />
            <Button variant="default" data-testid="install-btn" onClick={() => window.location.href = `/bundles/install?bundlePath=${encodeURIComponent(bundlePath)}`}>
              Install bundle
            </Button>
          </div>
        </div>
      )}
    </div>
    </WorkspacePage>
  );
}
