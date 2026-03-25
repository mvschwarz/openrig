import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useImportRig, ImportError } from "../hooks/mutations.js";
import { getInstantiateStatusColorClass } from "@/lib/instantiate-status-colors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

type Step = "input" | "validating" | "valid" | "preflight" | "preflight_done" | "instantiating" | "done" | "error";

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

interface PreflightResult {
  ready: boolean;
  warnings?: string[];
  errors?: string[];
}

interface InstantiateResult {
  rigId: string;
  specName: string;
  specVersion: string;
  nodes: Array<{ logicalId: string; status: string; error?: string }>;
}

interface InstantiateFailure {
  ok: false;
  code: string;
  errors?: string[];
  warnings?: string[];
  message?: string;
}

interface ImportFlowProps {
  onBack?: () => void;
}

const STEPS = [
  { num: 1, label: "VALIDATE" },
  { num: 2, label: "PREFLIGHT" },
  { num: 3, label: "INSTANTIATE" },
] as const;

function getStepNumber(step: Step): number {
  switch (step) {
    case "input": case "validating": return 1;
    case "valid": case "preflight": return 2;
    case "preflight_done": case "instantiating": case "done": return 3;
    case "error": return 0; // handled by errorAtStep
  }
}

function StepIndicator({ currentStep, errorAtStep }: { currentStep: Step; errorAtStep: number }) {
  const activeNum = currentStep === "error" ? errorAtStep : getStepNumber(currentStep);

  return (
    <div className="flex items-center gap-spacing-2 mb-spacing-8 p-spacing-4 inset-surface" data-testid="step-indicator">
      {STEPS.map((s, i) => {
        const isCompleted = activeNum > s.num;
        const isActive = activeNum === s.num;
        const isPending = activeNum < s.num;

        return (
          <div key={s.num} className="flex items-center gap-spacing-2">
            {i > 0 && (
              <div className={`w-8 h-px mx-spacing-1 ${isCompleted ? "bg-primary/40" : "bg-foreground-muted/20"}`} />
            )}
            <span
              data-testid={`step-${s.num}`}
              className={`text-label-md uppercase tracking-[0.04em] font-mono px-spacing-2 py-spacing-1 transition-colors ${
                isCompleted ? "text-foreground-muted" :
                isActive ? "text-primary bg-primary/10" :
                isPending ? "text-foreground-muted/30" : ""
              }`}
            >
              {isCompleted ? "\u2713" : ""} [ {s.num} {s.label} ]
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ImportFlow({ onBack }: ImportFlowProps = {}) {
  const navigate = useNavigate();
  const handleBack = onBack ?? (() => navigate({ to: "/" }));
  const importRig = useImportRig();
  const [yaml, setYaml] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [errorAtStep, setErrorAtStep] = useState<number>(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<InstantiateResult | null>(null);

  const handleValidate = async () => {
    setStep("validating");
    setErrors([]);
    try {
      const res = await fetch("/api/rigs/import/validate", {
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: yaml,
      });
      const data = (await res.json()) as ValidationResult;
      if (!data.valid) {
        setErrors(data.errors ?? ["Validation failed"]);
        setErrorAtStep(1);
        setStep("error");
      } else {
        setStep("valid");
      }
    } catch {
      setErrors(["Validation request failed"]);
      setErrorAtStep(1);
      setStep("error");
    }
  };

  const handlePreflight = async () => {
    setStep("preflight");
    setErrors([]);
    setWarnings([]);
    try {
      const res = await fetch("/api/rigs/import/preflight", {
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: yaml,
      });
      const data = (await res.json()) as PreflightResult;
      // Always capture warnings, even when there are also errors
      setWarnings(data.warnings ?? []);
      if (data.errors && data.errors.length > 0) {
        setErrors(data.errors);
        setErrorAtStep(2);
        setStep("error");
      } else {
        setStep("preflight_done");
      }
    } catch {
      setErrors(["Preflight request failed"]);
      setErrorAtStep(2);
      setStep("error");
    }
  };

  const handleInstantiate = async () => {
    setStep("instantiating");
    setErrors([]);
    try {
      const data = await importRig.mutateAsync(yaml) as InstantiateResult;
      setResult(data);
      setStep("done");
    } catch (err) {
      if (err instanceof ImportError) {
        setErrors(err.errors);
        setWarnings(err.warnings);
      } else {
        setErrors([err instanceof Error ? err.message : "Instantiate request failed"]);
      }
      setErrorAtStep(3);
      setStep("error");
    }
  };

  return (
    <div data-testid="import-flow" className="p-spacing-8 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-spacing-8">
        <div>
          <h2 className="text-headline-lg uppercase tracking-[0.06em]">IMPORT RIG</h2>
          <p className="text-label-md text-foreground-muted font-grotesk mt-spacing-1">
            Instantiate a topology from YAML spec
          </p>
        </div>
        <Button variant="ghost" onClick={handleBack}>
          &larr; Dashboard
        </Button>
      </div>

      {/* Step indicator */}
      <StepIndicator currentStep={step} errorAtStep={errorAtStep} />

      {/* Step 1: Input */}
      {step === "input" && (
        <div>
          <Textarea
            data-testid="yaml-input"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="Paste YAML rig spec here..."
            rows={14}
            className="bg-background font-mono text-body-sm mb-spacing-4"
          />
          <Button
            variant="tactical"
            data-testid="validate-btn"
            onClick={handleValidate}
            disabled={!yaml.trim()}
          >
            VALIDATE
          </Button>
        </div>
      )}

      {/* Validating */}
      {step === "validating" && (
        <div className="text-label-md text-foreground-muted">Validating...</div>
      )}

      {/* Step 2: Valid -> Preflight */}
      {step === "valid" && (
        <div>
          <Alert className="mb-spacing-4" data-testid="valid-message">
            <AlertDescription className="text-primary">Spec is valid. Run preflight checks?</AlertDescription>
          </Alert>
          <Button variant="tactical" data-testid="preflight-btn" onClick={handlePreflight}>
            RUN PREFLIGHT
          </Button>
        </div>
      )}

      {/* Running preflight */}
      {step === "preflight" && (
        <div className="text-label-md text-foreground-muted">Running preflight...</div>
      )}

      {/* Step 3: Preflight done -> Instantiate */}
      {step === "preflight_done" && (
        <div>
          {warnings.length > 0 && (
            <Alert className="mb-spacing-4" data-testid="preflight-warnings">
              <AlertDescription className="text-warning">
                <div className="text-label-md uppercase mb-spacing-1">WARNINGS</div>
                {warnings.map((w, i) => <div key={i}>— {w}</div>)}
              </AlertDescription>
            </Alert>
          )}
          <Alert className="mb-spacing-4" data-testid="preflight-ready">
            <AlertDescription className="text-primary">Preflight passed. Ready to instantiate.</AlertDescription>
          </Alert>
          <Button variant="tactical" data-testid="instantiate-btn" onClick={handleInstantiate}>
            INSTANTIATE
          </Button>
        </div>
      )}

      {/* Instantiating */}
      {step === "instantiating" && (
        <div className="text-label-md text-foreground-muted">Instantiating...</div>
      )}

      {/* Done: Results */}
      {step === "done" && result && (
        <div data-testid="import-result">
          <Alert className="mb-spacing-4">
            <AlertDescription>
              <span className="text-primary font-mono">{result.specName}</span>
              <span className="text-foreground-muted"> ({result.rigId})</span>
            </AlertDescription>
          </Alert>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>NODE</TableHead>
                <TableHead>STATUS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.nodes.map((n) => (
                <TableRow key={n.logicalId}>
                  <TableCell className="font-mono">{n.logicalId}</TableCell>
                  <TableCell>
                    <span className={`font-mono ${getInstantiateStatusColorClass(n.status)}`} data-testid={`inst-status-${n.logicalId}`}>
                      {n.status}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-spacing-6">
            <Button variant="ghost" onClick={handleBack}>
              ← Back to Dashboard
            </Button>
          </div>
        </div>
      )}

      {/* Error state */}
      {step === "error" && (
        <div data-testid="import-errors">
          {warnings.length > 0 && (
            <Alert className="mb-spacing-2" data-testid="error-warnings">
              <AlertDescription className="text-warning">
                <div className="text-label-md uppercase mb-spacing-1">WARNINGS</div>
                {warnings.map((w, i) => <div key={i}>— {w}</div>)}
              </AlertDescription>
            </Alert>
          )}
          {errors.map((e, i) => (
            <Alert key={i} className="mb-spacing-2">
              <AlertDescription className="text-destructive">{e}</AlertDescription>
            </Alert>
          ))}
          <Button
            variant="tactical"
            className="mt-spacing-4"
            onClick={() => { setStep("input"); setErrors([]); setWarnings([]); setResult(null); setErrorAtStep(0); }}
          >
            TRY AGAIN
          </Button>
        </div>
      )}
    </div>
  );
}
