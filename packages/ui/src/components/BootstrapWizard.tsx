import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RequirementsPanel, type RequirementResult } from "./RequirementsPanel.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { useBootstrapPlan, useBootstrapApply, type BootstrapPlanResult } from "../hooks/useBootstrap.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { WorkflowHeader, WorkflowSection, WorkflowStepIndicator } from "./WorkflowScaffold.js";

type Step = "enter" | "planning" | "planned" | "applying" | "done" | "error";

const STEP_LABELS = ["ENTER", "PLAN", "REVIEW", "APPLY"] as const;
const STEPS = STEP_LABELS.map((label, index) => ({ num: index + 1, label }));

function currentStepNumber(step: Step): number {
  switch (step) {
    case "enter": return 1;
    case "planning": return 2;
    case "planned": return 3;
    case "applying": return 4;
    case "done": case "error": return 4;
    default: return 1;
  }
}

export function BootstrapWizard() {
  const navigate = useNavigate();
  const { bootstrapSourceRef, setBootstrapSourceRef } = useSpecsWorkspace();
  const [step, setStep] = useState<Step>("enter");
  const [sourceRef, setSourceRef] = useState(() => bootstrapSourceRef);
  const [planResult, setPlanResult] = useState<BootstrapPlanResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [autoApprove, setAutoApprove] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const planMutation = useBootstrapPlan();
  const applyMutation = useBootstrapApply();

  useEffect(() => {
    setBootstrapSourceRef(sourceRef);
  }, [setBootstrapSourceRef, sourceRef]);

  const handlePlan = async () => {
    if (!sourceRef.trim()) return;
    setStep("planning");
    try {
      const result = await planMutation.mutateAsync({ sourceRef: sourceRef.trim() });
      setPlanResult(result);
      // Auto-select all action keys
      setSelectedKeys(new Set(result.actionKeys ?? []));
      setStep("planned");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  const handleApply = async () => {
    setStep("applying");
    try {
      const result = await applyMutation.mutateAsync({
        sourceRef: sourceRef.trim(),
        autoApprove,
        approvedActionKeys: autoApprove ? undefined : [...selectedKeys],
      });
      setPlanResult(result);
      setStep("done");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  const handleReset = () => {
    setStep("enter");
    setSourceRef("");
    setPlanResult(null);
    setSelectedKeys(new Set());
    setAutoApprove(false);
    setErrorMessage(null);
    planMutation.reset();
    applyMutation.reset();
  };

  // Extract requirements from plan result
  const reqStage = planResult?.stages.find((s) => s.stage === "probe_requirements");
  const reqDetail = reqStage?.detail as { results?: RequirementResult[] } | undefined;
  const requirements = reqDetail?.results ?? [];

  // Extract install plan from plan result
  const planStage = planResult?.stages.find((s) => s.stage === "build_install_plan");
  const planDetail = planStage?.detail as {
    actions?: Array<{ key: string; requirementName: string; classification: string; commandPreview: string | null }>;
  } | undefined;
  const actions = planDetail?.actions ?? [];
  const isPlanBlocked = planStage?.status === "blocked";
  const hasActionableInstalls = actions.some((a) => a.classification !== "manual_only" && a.commandPreview);
  const noneSelected = hasActionableInstalls && selectedKeys.size === 0 && !autoApprove;

  return (
    <WorkspacePage>
      <div data-testid="bootstrap-wizard" className="space-y-8">
      <WorkflowHeader
        eyebrow="Bootstrap"
        title="Bootstrap"
        description="Plan environment requirements, approve install actions, then import the rig into a running topology."
      />
      <WorkflowStepIndicator data-testid="step-indicator" steps={STEPS} currentStep={currentStepNumber(step)} />

      {/* Step 1: Enter */}
      {step === "enter" && (
        <WorkflowSection
          title="Source"
          description="Provide a rig spec or bundle path. Bootstrap will inspect requirements before it imports anything."
        >
        <div data-testid="step-enter">
          <label className="text-label-md uppercase block mb-spacing-2">SPEC OR BUNDLE PATH</label>
          <Input
            data-testid="spec-input"
            type="text"
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            placeholder="/path/to/rig.yaml or /path/to/bundle.rigbundle"
            className="font-mono text-body-md"
          />
          <p className="text-label-sm text-foreground-muted mt-spacing-1">
            Accepts .yaml rig specs or .rigbundle archives.{" "}
            <span
              role="link"
              tabIndex={0}
              className="text-primary cursor-pointer"
              data-testid="inspect-link"
              onClick={() => navigate({ to: "/bundles/inspect" })}
              onKeyDown={(e) => { if (e.key === "Enter") navigate({ to: "/bundles/inspect" }); }}
            >
              Inspect a bundle first →
            </span>
          </p>
          <div className="mt-spacing-4">
            <Button variant="tactical" onClick={handlePlan} disabled={!sourceRef.trim()} data-testid="plan-btn">
              PLAN
            </Button>
          </div>
        </div>
        </WorkflowSection>
      )}

      {/* Step 2: Planning */}
      {step === "planning" && (
        <div data-testid="step-planning" className="text-body-md text-foreground-muted">
          Planning...
        </div>
      )}

      {/* Step 3: Planned / Review */}
      {step === "planned" && planResult && (
        <WorkflowSection
          title="Plan Review"
          description="Review requirement probe results and approve the install actions that bootstrap should execute."
        >
        <div data-testid="step-planned">
          {/* Stages */}
          <h3 className="text-headline-md uppercase mb-spacing-3">STAGES</h3>
          <div className="space-y-spacing-1 mb-spacing-6" data-testid="stage-list">
            {planResult.stages.map((s) => (
              <div key={s.stage} className="flex items-center gap-spacing-3 text-label-sm font-mono" data-testid="stage-row">
                <span className={s.status === "ok" ? "text-success" : s.status === "blocked" ? "text-warning" : "text-foreground-muted"}>
                  {s.status.toUpperCase()}
                </span>
                <span>{s.stage}</span>
              </div>
            ))}
          </div>

          {/* Requirements */}
          {requirements.length > 0 && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">REQUIREMENTS</h3>
              <div className="mb-spacing-6">
                <RequirementsPanel results={requirements} />
              </div>
            </>
          )}

          {/* Actions */}
          {actions.length > 0 && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">ACTIONS</h3>
              <div className="space-y-spacing-1 mb-spacing-4">
                {actions.map((a) => (
                  <label key={a.key} className="flex items-center gap-spacing-3 text-label-sm font-mono cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoApprove || selectedKeys.has(a.key)}
                      disabled={autoApprove || a.classification === "manual_only"}
                      onChange={(e) => {
                        const next = new Set(selectedKeys);
                        if (e.target.checked) next.add(a.key);
                        else next.delete(a.key);
                        setSelectedKeys(next);
                      }}
                    />
                    <span className={a.classification === "manual_only" ? "text-warning" : ""}>{a.requirementName}</span>
                    {a.commandPreview && <span className="text-foreground-muted">{a.commandPreview}</span>}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-spacing-2 text-label-sm mb-spacing-4">
                <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
                Auto-approve all trusted actions
              </label>
            </>
          )}

          {/* Blocked warning */}
          {isPlanBlocked && (
            <div className="text-warning text-label-sm mb-spacing-4" data-testid="blocked-warning">
              Manual requirements must be resolved before bootstrap can proceed.
            </div>
          )}

          {/* Warnings */}
          {planResult.warnings.length > 0 && (
            <div className="mb-spacing-4">
              {planResult.warnings.map((w, i) => (
                <div key={i} className="text-warning text-label-sm">{w}</div>
              ))}
            </div>
          )}

          <Button
            variant="tactical"
            onClick={handleApply}
            disabled={isPlanBlocked || noneSelected}
            title={isPlanBlocked ? "Manual requirements must be resolved" : noneSelected ? "Select actions to approve" : undefined}
            data-testid="apply-btn"
          >
            APPLY
          </Button>
        </div>
        </WorkflowSection>
      )}

      {/* Step 4: Applying — show stage checklist from plan */}
      {step === "applying" && planResult && (
        <WorkflowSection
          title="Applying"
          description="Bootstrap is executing the approved actions and importing the rig."
        >
        <div data-testid="step-applying">
          <h3 className="text-headline-md uppercase mb-spacing-3">APPLYING</h3>
          <div className="space-y-spacing-1 mb-spacing-4" data-testid="applying-checklist">
            {planResult.stages.map((s) => (
              <div key={s.stage} className="flex items-center gap-spacing-3 text-label-sm font-mono">
                <span className="text-foreground-muted">○</span>
                <span>{s.stage}</span>
              </div>
            ))}
            <div className="flex items-center gap-spacing-3 text-label-sm font-mono">
              <span className="text-foreground-muted">○</span>
              <span>execute_external_installs</span>
            </div>
            <div className="flex items-center gap-spacing-3 text-label-sm font-mono">
              <span className="text-foreground-muted">○</span>
              <span>install_packages</span>
            </div>
            <div className="flex items-center gap-spacing-3 text-label-sm font-mono">
              <span className="text-foreground-muted">○</span>
              <span>import_rig</span>
            </div>
          </div>
          <p className="text-body-sm text-foreground-muted">Bootstrapping...</p>
        </div>
        </WorkflowSection>
      )}

      {/* Step 5: Done */}
      {step === "done" && planResult && (
        <WorkflowSection
          title="Result"
          description="Bootstrap finished and returned the managed rig identity."
        >
        <div data-testid="step-done">
          <h3 className="text-headline-md uppercase mb-spacing-3">
            {planResult.status === "completed" ? "BOOTSTRAP COMPLETE" : "BOOTSTRAP PARTIAL"}
          </h3>
          <div className="text-label-sm font-mono space-y-spacing-1 mb-spacing-4">
            <div>Status: <span className={planResult.status === "completed" ? "text-success" : "text-warning"}>{planResult.status.toUpperCase()}</span></div>
            {(planResult as { rigId?: string }).rigId && (
              <div data-testid="result-rig-id">Rig: {(planResult as { rigId?: string }).rigId}</div>
            )}
          </div>
          {(planResult as { rigId?: string }).rigId && (
            <Button
              variant="tactical"
              data-testid="view-rig-btn"
              onClick={() => navigate({ to: "/rigs/$rigId", params: { rigId: (planResult as unknown as { rigId: string }).rigId } })}
            >
              VIEW RIG
            </Button>
          )}
        </div>
        </WorkflowSection>
      )}

      {/* Error */}
      {step === "error" && (
        <WorkflowSection
          title="Bootstrap Error"
          description="Bootstrap could not complete. Fix the issue and retry the plan."
        >
        <div data-testid="step-error">
          <p className="text-destructive text-body-md mb-spacing-4">{errorMessage}</p>
          <Button variant="tactical" onClick={handleReset} data-testid="try-again-btn">
            TRY AGAIN
          </Button>
        </div>
        </WorkflowSection>
      )}
      </div>
    </WorkspacePage>
  );
}
