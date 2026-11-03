import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header.js";
import { StatusBadge } from "@/components/ui/status-badge.js";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { RuntimeBadge } from "./graphics/RuntimeMark.js";

type Step = "enter" | "validating" | "validated" | "configure" | "planning" | "planned" | "applying" | "done" | "error";

interface ManifestInfo {
  name: string;
  version: string;
  summary: string;
  runtimes: string[];
  exportCounts: Record<string, number>;
  roles: Array<{ name: string; description?: string }>;
  requirements: { cliTools: Array<{ name: string }>; systemPackages: Array<{ name: string }> };
}

interface PlanEntry {
  exportType: string;
  exportName: string;
  classification: string;
  targetPath: string;
  deferred: boolean;
  deferReason?: string;
  conflict?: { existingPath: string; reason: string };
  policyStatus: string;
}

interface PlanResult {
  packageName: string;
  packageVersion: string;
  entries: PlanEntry[];
  actionable: number;
  deferred: number;
  conflicts: number;
  noOps: number;
  rejected: number;
}

interface InstallResult {
  installId: string;
  packageId: string;
  packageName: string;
  applied: unknown[];
  deferred: unknown[];
  verification: { passed: boolean };
  policyRejected?: unknown[];
}

const STEPS = [
  { num: 1, label: "Enter" },
  { num: 2, label: "Validate" },
  { num: 3, label: "Configure" },
  { num: 4, label: "Plan" },
  { num: 5, label: "Apply" },
] as const;

function getStepNumber(step: Step): number {
  switch (step) {
    case "enter": return 1;
    case "validating": case "validated": return 2;
    case "configure": return 3;
    case "planning": case "planned": return 4;
    case "applying": case "done": return 5;
    case "error": return 0;
  }
}

function StepIndicator({ currentStep, errorAtStep }: { currentStep: Step; errorAtStep: number }) {
  const activeNum = currentStep === "error" ? errorAtStep : getStepNumber(currentStep);

  return (
    <div className="flex items-center gap-spacing-2 mb-spacing-8 p-spacing-4 flex-wrap" data-testid="step-indicator">
      {STEPS.map((s, i) => {
        const isCompleted = activeNum > s.num;
        const isActive = activeNum === s.num;

        return (
          <div key={s.num} className="flex items-center gap-spacing-2">
            {i > 0 && (
              <div className={`w-6 h-px mx-spacing-1 ${isCompleted ? "bg-primary/40" : "bg-outline-variant"}`} />
            )}
            <span
              data-testid={`step-${s.num}`}
              className={
                `text-xs px-spacing-2 py-spacing-1 transition-colors whitespace-nowrap ` +
                (isCompleted ? "text-on-surface-variant" :
                isActive ? "text-on-surface bg-surface-mid" :
                "text-on-surface-variant/50")
              }
            >
              {isCompleted ? "\u2713" : ""} [ {s.num} {s.label} ]
            </span>
          </div>
        );
      })}
    </div>
  );
}

function policyStatusKey(status: string): string {
  switch (status) {
    case "approved": return "done";
    case "rejected": return "failed";
    case "deferred":
    case "conflict": return "attention_required";
    case "noop": return "idle";
    default: return status;
  }
}

function policyStatusLabel(status: string): string {
  switch (status) {
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "deferred": return "Deferred";
    case "conflict": return "Conflict";
    case "noop": return "No-op";
    default: return status.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

export function PackageInstallFlow() {
  const navigate = useNavigate();
  const [sourcePath, setSourcePath] = useState("");
  const [step, setStep] = useState<Step>("enter");
  const [errorAtStep, setErrorAtStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [manifest, setManifest] = useState<ManifestInfo | null>(null);

  // Configure state
  const [runtime, setRuntime] = useState<string>("claude-code");
  const [targetRoot, setTargetRoot] = useState(".");
  const [roleName, setRoleName] = useState<string>("");
  const [allowMerge, setAllowMerge] = useState(false);

  // Plan/result state
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);

  const handleValidate = async () => {
    setStep("validating");
    setErrors([]);
    try {
      const res = await fetch("/api/packages/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: sourcePath }),
      });
      const data = await res.json();
      if (!data.valid) {
        setErrors(data.errors ?? [data.error ?? "Validation failed"]);
        setErrorAtStep(2);
        setStep("error");
      } else {
        setManifest(data.manifest);
        setStep("validated");
      }
    } catch {
      setErrors(["Validation request failed"]);
      setErrorAtStep(2);
      setStep("error");
    }
  };

  const handlePlan = async () => {
    setStep("planning");
    setErrors([]);
    try {
      const res = await fetch("/api/packages/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRef: sourcePath,
          targetRoot,
          runtime,
          roleName: roleName || undefined,
          allowMerge,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setErrors(data.errors ?? [data.error ?? "Plan failed"]);
        setErrorAtStep(4);
        setStep("error");
        return;
      }
      const data = await res.json();
      setPlanResult(data);
      setStep("planned");
    } catch {
      setErrors(["Plan request failed"]);
      setErrorAtStep(4);
      setStep("error");
    }
  };

  const handleApply = async () => {
    setStep("applying");
    setErrors([]);
    try {
      const res = await fetch("/api/packages/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRef: sourcePath,
          targetRoot,
          runtime,
          roleName: roleName || undefined,
          allowMerge,
        }),
      });
      const data = await res.json();
      if (res.status >= 400) {
        setErrors(data.errors ?? [data.error ?? "Install failed"]);
        setErrorAtStep(5);
        setStep("error");
        return;
      }
      setInstallResult(data);
      setStep("done");
    } catch {
      setErrors(["Install request failed"]);
      setErrorAtStep(5);
      setStep("error");
    }
  };

  const hasConflicts = (planResult?.conflicts ?? 0) > 0;

  return (
    <WorkspacePage>
    <div data-testid="install-flow">
      <PageHeader
        title="Install package (legacy)"
        description="Validate, configure, and apply a legacy agent package."
      />

      <StepIndicator currentStep={step} errorAtStep={errorAtStep} />

      {/* Step 1: Enter */}
      {step === "enter" && (
        <div>
          <label className="text-xs text-on-surface-variant block mb-spacing-2">
            Package path
          </label>
          <input
            data-testid="source-path-input"
            type="text"
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
            placeholder="/path/to/package"
            className="w-full bg-transparent border-b border-foreground/20 focus:border-foreground px-0 py-spacing-2 text-sm font-mono outline-none transition-colors"
          />
          <div className="flex items-center justify-between gap-2">
            <span />
            <Button
              variant="default"
              data-testid="validate-btn"
              onClick={handleValidate}
              disabled={!sourcePath.trim()}
              className="mt-spacing-4"
            >
              Validate
            </Button>
          </div>
        </div>
      )}

      {/* Validating */}
      {step === "validating" && (
        <div className="text-sm text-on-surface-variant" data-testid="validating-indicator">Validating...</div>
      )}

      {/* Step 2: Validated — show manifest summary */}
      {step === "validated" && manifest && (
        <div data-testid="manifest-summary">
          <div className="rounded-lg border bg-surface-lowest p-spacing-4 mb-spacing-4 shadow-sm">
            <div className="flex items-baseline justify-between mb-spacing-2">
              <span className="text-sm font-semibold text-on-surface">{manifest.name}</span>
              <span className="font-mono text-xs text-on-surface-variant">v{manifest.version}</span>
            </div>
            <p className="text-sm text-on-surface-variant mb-spacing-3">{manifest.summary}</p>
            <div className="flex flex-wrap gap-spacing-3 text-xs text-on-surface-variant">
              <span>Skills: <span className="font-mono text-on-surface">{manifest.exportCounts.skills}</span></span>
              <span>Guidance: <span className="font-mono text-on-surface">{manifest.exportCounts.guidance}</span></span>
              <span>Agents: <span className="font-mono text-on-surface">{manifest.exportCounts.agents}</span></span>
              <span>Hooks: <span className="font-mono text-on-surface">{manifest.exportCounts.hooks}</span></span>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span>Runtimes:</span>
                <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
                  {manifest.runtimes.map((rt) => (
                    <RuntimeBadge
                      key={rt}
                      runtime={rt}
                      size="xs"
                      compact
                    />
                  ))}
                </span>
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span />
            <Button variant="default" data-testid="configure-btn" onClick={() => setStep("configure")}>
              Configure
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Configure */}
      {step === "configure" && manifest && (
        <div data-testid="configure-step">
          <div className="space-y-spacing-4 mb-spacing-6">
            <div>
              <label className="text-xs text-on-surface-variant block mb-spacing-1">Runtime</label>
              <select
                data-testid="runtime-select"
                value={runtime}
                onChange={(e) => setRuntime(e.target.value)}
                className="bg-transparent border-b border-foreground/20 py-spacing-1 text-sm outline-none"
              >
                {manifest.runtimes.map((rt) => (
                  <option key={rt} value={rt}>{rt}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-on-surface-variant block mb-spacing-1">Target root</label>
              <input
                data-testid="target-root-input"
                type="text"
                value={targetRoot}
                onChange={(e) => setTargetRoot(e.target.value)}
                className="w-full bg-transparent border-b border-foreground/20 px-0 py-spacing-1 text-sm font-mono outline-none"
              />
            </div>

            {manifest.roles.length > 0 && (
              <div>
                <label className="text-xs text-on-surface-variant block mb-spacing-1">Role</label>
                <select
                  data-testid="role-select"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  className="bg-transparent border-b border-foreground/20 py-spacing-1 text-sm outline-none"
                >
                  <option value="">All exports</option>
                  {manifest.roles.map((r) => (
                    <option key={r.name} value={r.name}>{r.name}{r.description ? ` — ${r.description}` : ""}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center gap-spacing-2">
              <input
                data-testid="allow-merge-toggle"
                type="checkbox"
                checked={allowMerge}
                onChange={(e) => setAllowMerge(e.target.checked)}
                className="accent-primary"
              />
              <label className="text-xs text-on-surface-variant">
                Allow managed block merges into existing files
              </label>
            </div>

            {(manifest.requirements.cliTools.length > 0 || manifest.requirements.systemPackages.length > 0) && (
              <div data-testid="requirements-section" className="rounded-lg border bg-surface-lowest p-spacing-3">
                <span className="text-xs text-on-surface-variant block mb-spacing-1">Requirements</span>
                {manifest.requirements.cliTools.map((t) => (
                  <div key={t.name} className="text-sm">CLI: <span className="font-mono">{t.name}</span></div>
                ))}
                {manifest.requirements.systemPackages.map((p) => (
                  <div key={p.name} className="text-sm">System: <span className="font-mono">{p.name}</span></div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" data-testid="configure-back-btn" onClick={() => setStep("validated")}>
              Back
            </Button>
            <Button variant="default" data-testid="plan-btn" onClick={handlePlan}>
              Preview plan
            </Button>
          </div>
        </div>
      )}

      {/* Planning */}
      {step === "planning" && (
        <div className="text-sm text-on-surface-variant" data-testid="planning-indicator">Planning...</div>
      )}

      {/* Step 4: Plan preview */}
      {step === "planned" && planResult && (
        <div data-testid="plan-preview">
          <div className="flex flex-wrap gap-spacing-4 mb-spacing-4 text-xs">
            <span>Approved: <span className="font-mono text-on-surface" data-testid="plan-actionable">{planResult.actionable}</span></span>
            <span>Deferred: <span className="font-mono text-on-surface-variant" data-testid="plan-deferred">{planResult.deferred}</span></span>
            <span>Conflicts: <span className="font-mono text-destructive" data-testid="plan-conflicts">{planResult.conflicts}</span></span>
            <span>No-ops: <span className="font-mono" data-testid="plan-noops">{planResult.noOps}</span></span>
            {planResult.rejected > 0 && (
              <span>Rejected: <span className="font-mono text-warning" data-testid="plan-rejected">{planResult.rejected}</span></span>
            )}
          </div>

          {hasConflicts && (
            <Alert className="mb-spacing-4" data-testid="conflict-warning">
              <AlertDescription className="text-destructive">
                Conflicts detected — resolve before applying
              </AlertDescription>
            </Alert>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="normal-case">Type</TableHead>
                <TableHead className="normal-case">Name</TableHead>
                <TableHead className="normal-case">Status</TableHead>
                <TableHead className="normal-case">Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {planResult.entries.map((e, i) => (
                <TableRow key={i} data-testid="plan-entry" data-policy-status={e.policyStatus}>
                  <TableCell className="font-mono text-xs">{e.exportType}</TableCell>
                  <TableCell className="font-mono text-xs">{e.exportName}</TableCell>
                  <TableCell>
                    <StatusBadge status={policyStatusKey(e.policyStatus)} label={policyStatusLabel(e.policyStatus)} />
                    {e.deferReason && <span className="text-on-surface-variant text-xs"> — {e.deferReason}</span>}
                    {e.conflict && <span className="text-destructive text-xs"> — {e.conflict.reason}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-on-surface-variant truncate max-w-[200px]">
                    {e.targetPath || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-spacing-4 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              data-testid="plan-back-btn"
              onClick={() => setStep("configure")}
            >
              Back
            </Button>
            <Button
              variant="default"
              data-testid="apply-btn"
              onClick={handleApply}
              disabled={hasConflicts}
              title={hasConflicts ? "Resolve conflicts before applying" : undefined}
            >
              Install package
            </Button>
          </div>
        </div>
      )}

      {/* Applying */}
      {step === "applying" && (
        <div className="text-sm text-on-surface-variant" data-testid="applying-indicator">Applying...</div>
      )}

      {/* Step 5: Done */}
      {step === "done" && installResult && (
        <div data-testid="install-result">
          <Alert className="mb-spacing-4">
            <AlertDescription>
              <span className="text-primary font-mono text-sm">{installResult.packageName}</span>
              <span className="text-on-surface-variant text-sm"> installed as </span>
              <span className="font-mono text-sm" data-testid="result-install-id">{installResult.installId}</span>
            </AlertDescription>
          </Alert>

          <div className="flex gap-spacing-4 text-xs mb-spacing-4 text-on-surface-variant">
            <span>Applied: <span className="font-mono text-on-surface" data-testid="result-applied">{installResult.applied.length}</span></span>
            <span>Deferred: <span className="font-mono" data-testid="result-deferred">{installResult.deferred.length}</span></span>
            <span>Verified: {installResult.verification.passed
              ? <StatusBadge status="done" label="Pass" testId="result-verified" />
              : <StatusBadge status="failed" label="Fail" testId="result-verified" />}</span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span />
            <Button
              variant="default"
              data-testid="detail-link"
              onClick={() => navigate({ to: "/packages/$packageId", params: { packageId: installResult.packageId } })}
            >
              View install details
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {step === "error" && (
        <div data-testid="install-errors">
          {errors.map((e, i) => (
            <Alert key={i} className="mb-spacing-2">
              <AlertDescription className="text-destructive">{e}</AlertDescription>
            </Alert>
          ))}
          <div className="flex items-center justify-between gap-2">
            <span />
            <Button
              variant="default"
              className="mt-spacing-4"
              data-testid="try-again-btn"
              onClick={() => {
                setStep("enter");
                setErrors([]);
                setManifest(null);
                setPlanResult(null);
                setInstallResult(null);
                setErrorAtStep(0);
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      )}
    </div>
    </WorkspacePage>
  );
}
