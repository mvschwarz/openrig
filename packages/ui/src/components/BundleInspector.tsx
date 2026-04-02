import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBundleInspect, type InspectResult } from "../hooks/useBundles.js";
import { cn } from "@/lib/utils";
import { WorkspacePage } from "./WorkspacePage.js";

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
      <h2 className="text-headline-lg uppercase mb-spacing-4">INSPECT BUNDLE</h2>

      <div className="mb-spacing-4">
        <label className="text-label-md uppercase block mb-spacing-2">BUNDLE PATH</label>
        <input
          data-testid="bundle-path-input"
          type="text"
          value={bundlePath}
          onChange={(e) => setBundlePath(e.target.value)}
          placeholder="/path/to/my-rig.rigbundle"
          className="w-full bg-transparent border-b border-foreground/20 py-spacing-2 text-body-md font-mono focus:outline-none focus:border-primary"
        />
        <Button variant="tactical" onClick={handleInspect} disabled={!bundlePath.trim() || inspectMutation.isPending} className="mt-spacing-3" data-testid="inspect-btn">
          {inspectMutation.isPending ? "INSPECTING..." : "INSPECT"}
        </Button>
      </div>

      {inspectMutation.isError && (
        <div className="text-destructive text-body-md mb-spacing-4" data-testid="inspect-error">
          {inspectMutation.error.message}
        </div>
      )}

      {result && (
        <div data-testid="inspect-result">
          {/* Manifest summary */}
          <div className="card-dark p-spacing-4 mb-spacing-4" data-testid="manifest-summary">
            <div className="flex items-center gap-spacing-2 mb-spacing-2">
              <h3 className="text-headline-md uppercase">{result.manifest.name}</h3>
              <span className="text-label-sm font-mono px-spacing-2 py-px bg-foreground/10" data-testid="schema-badge">
                v{result.manifest.schemaVersion ?? 1}
              </span>
            </div>
            <div className="text-label-sm font-mono text-foreground-muted-on-dark">v{result.manifest.version}</div>
            <div className="text-label-sm font-mono text-foreground-muted-on-dark">Spec: {result.manifest.rigSpec}</div>
            <div className="mt-spacing-2 flex gap-spacing-3">
              <span className={cn("text-label-sm", result.digestValid ? "text-success" : "text-destructive")}>
                DIGEST: {result.digestValid ? "VALID" : "INVALID"}
              </span>
              <span className={cn("text-label-sm", result.integrityResult.passed ? "text-success" : "text-destructive")} data-testid="integrity-status">
                INTEGRITY: {result.integrityResult.passed ? "PASS" : "FAIL"}
              </span>
            </div>
          </div>

          {/* v2: Agents list, v1: Packages list */}
          {result.manifest.schemaVersion === 2 && result.manifest.agents ? (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">AGENTS</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="agent-list">
                {result.manifest.agents.map((agent) => (
                  <div key={agent.name} className="text-label-sm font-mono" data-testid="agent-entry">
                    {agent.name} v{agent.version} — {agent.path}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">PACKAGES</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="package-list">
                {(result.manifest.packages ?? []).map((pkg) => (
                  <div key={pkg.name} className="text-label-sm font-mono" data-testid="package-entry">
                    {pkg.name} v{pkg.version} — {pkg.path}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Per-file integrity */}
          {result.integrityResult && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">FILE INTEGRITY</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="file-integrity">
                {Object.keys((result.manifest.packages ?? result.manifest.agents ?? []).length > 0 ? (result as unknown as { manifest: { integrity?: { files: Record<string, string> } } }).manifest?.integrity?.files ?? {} : {}).map((file) => {
                  const isMismatch = result.integrityResult.mismatches.includes(file);
                  const isMissing = result.integrityResult.missing.includes(file);
                  const status = isMismatch ? "MISMATCH" : isMissing ? "MISSING" : "OK";
                  return (
                    <div key={file} className="flex items-center gap-spacing-3 text-label-sm font-mono" data-testid="file-row">
                      <span className={cn("w-2 h-2", status === "OK" ? "bg-success" : "bg-destructive")} data-testid="file-dot" />
                      <span>{file}</span>
                      <span className="text-foreground-muted ml-auto">{status}</span>
                    </div>
                  );
                })}
                {result.integrityResult.extra.map((file) => (
                  <div key={file} className="flex items-center gap-spacing-3 text-label-sm font-mono" data-testid="file-row">
                    <span className="w-2 h-2 bg-warning" data-testid="file-dot" />
                    <span>{file}</span>
                    <span className="text-foreground-muted ml-auto">EXTRA</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Install button */}
          <Button variant="tactical" data-testid="install-btn" onClick={() => window.location.href = `/bundles/install?bundlePath=${encodeURIComponent(bundlePath)}`}>
            INSTALL THIS BUNDLE
          </Button>
        </div>
      )}
    </div>
    </WorkspacePage>
  );
}
