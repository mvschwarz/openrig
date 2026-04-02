import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

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
  { num: 1, label: "ENTER" },
  { num: 2, label: "VALIDATE" },
  { num: 3, label: "CONFIGURE" },
  { num: 4, label: "PLAN" },
  { num: 5, label: "APPLY" },
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
    <div className="flex items-center gap-spacing-2 mb-spacing-8 p-spacing-4 inset-light flex-wrap" data-testid="step-indicator">
      {STEPS.map((s, i) => {
        const isCompleted = activeNum > s.num;
        const isActive = activeNum === s.num;

        return (
          <div key={s.num} className="flex items-center gap-spacing-2">
            {i > 0 && (
              <div className={`w-6 h-px mx-spacing-1 ${isCompleted ? "bg-primary/40" : "bg-foreground-muted/20"}`} />
            )}
            <span
              data-testid={`step-${s.num}`}
              className={cn(
                "text-label-sm uppercase tracking-[0.04em] font-mono px-spacing-2 py-spacing-1 transition-colors whitespace-nowrap",
                isCompleted ? "text-foreground-muted" :
                isActive ? "text-foreground bg-foreground/10" :
                "text-foreground-muted/30"
              )}
            >
              {isCompleted ? "\u2713" : ""} [ {s.num} {s.label} ]
            </span>
          </div>
        );
      })}
    </div>
  );
}

function policyStatusColor(status: string): string {
  switch (status) {
    case "approved": return "text-success";
    case "rejected": return "text-warning";
    case "deferred": return "text-foreground-muted";
    case "conflict": return "text-destructive";
    case "noop": return "text-foreground-muted/50";
    default: return "";
  }
}

function policyStatusBg(status: string): string {
  switch (status) {
    case "approved": return "bg-success/8";
    case "rejected": return "bg-warning/8";
    case "deferred": return "bg-foreground-muted/4";
    case "conflict": return "bg-destructive/8";
    default: return "";
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
      {/* Header */}
      <div className="mb-spacing-8">
        <div>
          <h2 className="text-headline-lg uppercase tracking-[0.06em]">INSTALL PACKAGE (Legacy)</h2>
          <p className="text-label-md text-foreground-muted font-grotesk mt-spacing-1">
            Validate, configure, and apply an agent package
          </p>
        </div>
      </div>

      <StepIndicator currentStep={step} errorAtStep={errorAtStep} />

      {/* Step 1: Enter */}
      {step === "enter" && (
        <div>
          <label className="text-label-md text-foreground-muted uppercase tracking-[0.04em] block mb-spacing-2">
            PACKAGE PATH
          </label>
          <input
            data-testid="source-path-input"
            type="text"
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
            placeholder="/path/to/package"
            className="w-full bg-transparent border-b border-foreground/20 focus:border-foreground px-0 py-spacing-2 text-body-md font-mono outline-none transition-colors"
          />
          <Button
            variant="tactical"
            data-testid="validate-btn"
            onClick={handleValidate}
            disabled={!sourcePath.trim()}
            className="mt-spacing-4"
          >
            VALIDATE
          </Button>
        </div>
      )}

      {/* Validating */}
      {step === "validating" && (
        <div className="text-label-md text-foreground-muted" data-testid="validating-indicator">Validating...</div>
      )}

      {/* Step 2: Validated — show manifest summary */}
      {step === "validated" && manifest && (
        <div data-testid="manifest-summary">
          <div className="card-dark p-spacing-4 mb-spacing-4">
            <div className="flex items-baseline justify-between mb-spacing-2">
              <span className="text-headline-md uppercase">{manifest.name}</span>
              <span className="font-mono text-foreground-muted-on-dark">v{manifest.version}</span>
            </div>
            <p className="text-body-sm text-foreground-muted-on-dark mb-spacing-3">{manifest.summary}</p>
            <div className="flex flex-wrap gap-spacing-3 text-label-sm">
              <span>Skills: <span className="font-mono text-foreground-on-dark">{manifest.exportCounts.skills}</span></span>
              <span>Guidance: <span className="font-mono text-foreground-on-dark">{manifest.exportCounts.guidance}</span></span>
              <span>Agents: <span className="font-mono text-foreground-on-dark">{manifest.exportCounts.agents}</span></span>
              <span>Hooks: <span className="font-mono text-foreground-on-dark">{manifest.exportCounts.hooks}</span></span>
              <span>Runtimes: <span className="font-mono text-foreground-on-dark">{manifest.runtimes.join(", ")}</span></span>
            </div>
          </div>
          <Button variant="tactical" data-testid="configure-btn" onClick={() => setStep("configure")}>
            CONFIGURE
          </Button>
        </div>
      )}

      {/* Step 3: Configure */}
      {step === "configure" && manifest && (
        <div data-testid="configure-step">
          <div className="space-y-spacing-4 mb-spacing-6">
            <div>
              <label className="text-label-sm text-foreground-muted uppercase tracking-[0.04em] block mb-spacing-1">RUNTIME</label>
              <select
                data-testid="runtime-select"
                value={runtime}
                onChange={(e) => setRuntime(e.target.value)}
                className="bg-transparent border-b border-foreground/20 py-spacing-1 text-body-md font-mono outline-none"
              >
                {manifest.runtimes.map((rt) => (
                  <option key={rt} value={rt}>{rt}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-label-sm text-foreground-muted uppercase tracking-[0.04em] block mb-spacing-1">TARGET ROOT</label>
              <input
                data-testid="target-root-input"
                type="text"
                value={targetRoot}
                onChange={(e) => setTargetRoot(e.target.value)}
                className="w-full bg-transparent border-b border-foreground/20 px-0 py-spacing-1 text-body-md font-mono outline-none"
              />
            </div>

            {manifest.roles.length > 0 && (
              <div>
                <label className="text-label-sm text-foreground-muted uppercase tracking-[0.04em] block mb-spacing-1">ROLE</label>
                <select
                  data-testid="role-select"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  className="bg-transparent border-b border-foreground/20 py-spacing-1 text-body-md font-mono outline-none"
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
              <label className="text-label-sm text-foreground-muted">
                Allow managed block merges into existing files
              </label>
            </div>

            {(manifest.requirements.cliTools.length > 0 || manifest.requirements.systemPackages.length > 0) && (
              <div data-testid="requirements-section" className="p-spacing-3 bg-foreground/4">
                <span className="text-label-sm text-foreground-muted uppercase block mb-spacing-1">REQUIREMENTS</span>
                {manifest.requirements.cliTools.map((t) => (
                  <div key={t.name} className="text-body-sm font-mono">CLI: {t.name}</div>
                ))}
                {manifest.requirements.systemPackages.map((p) => (
                  <div key={p.name} className="text-body-sm font-mono">System: {p.name}</div>
                ))}
              </div>
            )}
          </div>

          <Button variant="tactical" data-testid="plan-btn" onClick={handlePlan}>
            PREVIEW PLAN
          </Button>
        </div>
      )}

      {/* Planning */}
      {step === "planning" && (
        <div className="text-label-md text-foreground-muted" data-testid="planning-indicator">Planning...</div>
      )}

      {/* Step 4: Plan preview */}
      {step === "planned" && planResult && (
        <div data-testid="plan-preview">
          <div className="flex flex-wrap gap-spacing-4 mb-spacing-4 text-label-sm">
            <span>Approved: <span className="font-mono text-success" data-testid="plan-actionable">{planResult.actionable}</span></span>
            <span>Deferred: <span className="font-mono text-foreground-muted" data-testid="plan-deferred">{planResult.deferred}</span></span>
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
                <TableHead>TYPE</TableHead>
                <TableHead>NAME</TableHead>
                <TableHead>STATUS</TableHead>
                <TableHead>TARGET</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {planResult.entries.map((e, i) => (
                <TableRow key={i} className={policyStatusBg(e.policyStatus)} data-testid="plan-entry" data-policy-status={e.policyStatus}>
                  <TableCell className="font-mono text-label-sm">{e.exportType}</TableCell>
                  <TableCell className="font-mono text-label-sm">{e.exportName}</TableCell>
                  <TableCell className={cn("font-mono text-label-sm uppercase", policyStatusColor(e.policyStatus))}>
                    {e.policyStatus}
                    {e.deferReason && <span className="text-foreground-muted normal-case"> — {e.deferReason}</span>}
                    {e.conflict && <span className="text-destructive normal-case"> — {e.conflict.reason}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-label-sm text-foreground-muted truncate max-w-[200px]">
                    {e.targetPath || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-spacing-4">
            <Button
              variant="tactical"
              data-testid="apply-btn"
              onClick={handleApply}
              disabled={hasConflicts}
              title={hasConflicts ? "Resolve conflicts before applying" : undefined}
            >
              APPLY
            </Button>
          </div>
        </div>
      )}

      {/* Applying */}
      {step === "applying" && (
        <div className="text-label-md text-foreground-muted" data-testid="applying-indicator">Applying...</div>
      )}

      {/* Step 5: Done */}
      {step === "done" && installResult && (
        <div data-testid="install-result">
          <Alert className="mb-spacing-4">
            <AlertDescription>
              <span className="text-primary font-mono">{installResult.packageName}</span>
              <span className="text-foreground-muted"> installed as </span>
              <span className="font-mono" data-testid="result-install-id">{installResult.installId}</span>
            </AlertDescription>
          </Alert>

          <div className="flex gap-spacing-4 text-label-sm mb-spacing-4">
            <span>Applied: <span className="font-mono text-success" data-testid="result-applied">{installResult.applied.length}</span></span>
            <span>Deferred: <span className="font-mono text-foreground-muted" data-testid="result-deferred">{installResult.deferred.length}</span></span>
            <span>Verified: <span className={cn("font-mono", installResult.verification.passed ? "text-success" : "text-destructive")} data-testid="result-verified">{installResult.verification.passed ? "PASS" : "FAIL"}</span></span>
          </div>

          <div className="flex gap-spacing-3">
            <Button
              variant="tactical"
              data-testid="detail-link"
              onClick={() => navigate({ to: "/packages/$packageId", params: { packageId: installResult.packageId } })}
            >
              VIEW INSTALL DETAILS
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
          <Button
            variant="tactical"
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
            TRY AGAIN
          </Button>
        </div>
      )}
    </div>
    </WorkspacePage>
  );
}
