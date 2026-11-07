import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useBundleInstall, type BundleInstallResult } from "../hooks/useBundles.js";
import { PageHeader } from "@/components/ui/page-header.js";
import { StatusBadge } from "@/components/ui/status-badge.js";
import { WorkspacePage } from "./WorkspacePage.js";

type Step = "enter" | "planning" | "planned" | "applying" | "done" | "error";

export function BundleInstallFlow() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("enter");
  // Read bundlePath from URL query param if present (handoff from inspector)
  const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const [bundlePath, setBundlePath] = useState(urlParams?.get("bundlePath") ?? "");
  const [targetRoot, setTargetRoot] = useState("");
  const [planResult, setPlanResult] = useState<BundleInstallResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const installMutation = useBundleInstall();

  const handlePlan = async () => {
    if (!bundlePath.trim()) return;
    setStep("planning");
    try {
      const result = await installMutation.mutateAsync({ bundlePath: bundlePath.trim(), plan: true });
      setPlanResult(result);
      setStep("planned");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  const handleApply = async () => {
    if (!targetRoot.trim()) return;
    setStep("applying");
    try {
      const result = await installMutation.mutateAsync({
        bundlePath: bundlePath.trim(),
        autoApprove: true,
        targetRoot: targetRoot.trim(),
      });
      setPlanResult(result);
      setStep("done");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  return (
    <WorkspacePage>
    <div data-testid="bundle-install-flow">
      <PageHeader
        title="Install bundle"
        description="Plan a bundle install, review the stage plan, then apply it to the target root."
      />

      {step === "enter" && (
        <div data-testid="step-enter">
          <label className="text-xs text-on-surface-variant block mb-spacing-2">Bundle path</label>
          <input data-testid="bundle-input" type="text" value={bundlePath}
            onChange={(e) => setBundlePath(e.target.value)}
            placeholder="/path/to/my-rig.rigbundle"
            className="w-full bg-transparent border-b border-foreground/20 py-spacing-2 text-sm font-mono focus:outline-none focus:border-primary mb-spacing-4" />
          <label className="text-xs text-on-surface-variant block mb-spacing-2">Target root</label>
          <input data-testid="target-input" type="text" value={targetRoot}
            onChange={(e) => setTargetRoot(e.target.value)}
            placeholder="/path/to/target/project"
            className="w-full bg-transparent border-b border-foreground/20 py-spacing-2 text-sm font-mono focus:outline-none focus:border-primary mb-spacing-4" />
          <div className="flex items-center justify-between gap-2">
            <span />
            <Button variant="default" onClick={handlePlan} disabled={!bundlePath.trim()} data-testid="plan-btn">Preview plan</Button>
          </div>
        </div>
      )}

      {step === "planning" && <div data-testid="step-planning" className="text-sm text-on-surface-variant">Planning...</div>}

      {step === "planned" && planResult && (
        <div data-testid="step-planned">
          <h3 className="text-sm font-semibold text-on-surface mb-spacing-3">Plan</h3>
          <div className="space-y-spacing-1 mb-spacing-4">
            {planResult.stages.map((s) => (
              <div key={s.stage} className="flex items-center gap-2 text-xs">
                <StatusBadge status={s.status === "ok" ? "done" : s.status} label={s.status === "ok" ? "Ok" : undefined} />
                <span className="font-mono">{s.stage}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep("enter")} data-testid="back-btn">Back</Button>
            <Button variant="default" onClick={handleApply} disabled={!targetRoot.trim()} data-testid="apply-btn">Install bundle</Button>
          </div>
        </div>
      )}

      {step === "applying" && <div data-testid="step-applying" className="text-sm text-on-surface-variant">Installing...</div>}

      {step === "done" && planResult && (
        <div data-testid="step-done">
          <h3 className="text-sm font-semibold text-on-surface mb-spacing-3">{planResult.status === "partial" ? "Partially installed" : "Complete"}</h3>
          <div className="text-xs space-y-1">
            <div>Status: <StatusBadge status={planResult.status === "completed" ? "done" : planResult.status} label={planResult.status === "completed" ? "Completed" : planResult.status === "partial" ? "Partially installed" : undefined} /></div>
            {planResult.stages.some((s) => s.detail?.source === "pod_bundle") ? (
              <span className="ml-spacing-2 text-primary" data-testid="bundle-type-label">Pod-aware bundle</span>
            ) : (
              <span className="ml-spacing-2 text-on-surface-variant" data-testid="bundle-type-label">Legacy bundle</span>
            )}
          </div>
          {planResult.rigId && (
            <div className="text-xs" data-testid="result-rig-id">Rig: <span className="font-mono">{planResult.rigId}</span></div>
          )}
          {planResult.rigId && (
            <div className="flex items-center justify-between gap-2">
              <span />
              <Button variant="default" className="mt-spacing-3" onClick={() => navigate({ to: "/rigs/$rigId", params: { rigId: planResult.rigId! } })}>View rig</Button>
            </div>
          )}
        </div>
      )}

      {step === "error" && (
        <div data-testid="step-error">
          <p className="text-destructive text-sm mb-spacing-4">{errorMessage}</p>
          <div className="flex items-center justify-between gap-2">
            <span />
            <Button variant="default" onClick={() => { setStep("enter"); setErrorMessage(null); installMutation.reset(); }} data-testid="try-again-btn">Try again</Button>
          </div>
        </div>
      )}
    </div>
    </WorkspacePage>
  );
}
