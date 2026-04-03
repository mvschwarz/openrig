import { useEffect, useState } from "react";
import { useImportRig, ImportError } from "../hooks/mutations.js";
import { getInstantiateStatusColorClass } from "@/lib/instantiate-status-colors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { WorkflowHeader, WorkflowSection, WorkflowStepIndicator } from "./WorkflowScaffold.js";

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
  { num: 1, label: "VALIDATE RIGSPEC" },
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

export function ImportFlow({ onBack }: ImportFlowProps = {}) {
  const importRig = useImportRig();
  const {
    currentRigDraft,
    selectedRigDraft,
    saveRigDraft,
    rememberRigDraft,
    clearSelectedRigDraft,
  } = useSpecsWorkspace();
  const [yaml, setYaml] = useState(() => selectedRigDraft?.yaml ?? currentRigDraft?.yaml ?? "");
  const [rigRoot, setRigRoot] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [errorAtStep, setErrorAtStep] = useState<number>(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<InstantiateResult | null>(null);

  useEffect(() => {
    saveRigDraft(yaml);
  }, [saveRigDraft, yaml]);

  useEffect(() => {
    if (!selectedRigDraft) return;
    setYaml(selectedRigDraft.yaml);
    clearSelectedRigDraft();
  }, [clearSelectedRigDraft, selectedRigDraft]);

  const handleValidate = async () => {
    rememberRigDraft(yaml);
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
      const headers: Record<string, string> = { "Content-Type": "text/yaml" };
      if (rigRoot) headers["X-Rig-Root"] = rigRoot;
      const res = await fetch("/api/rigs/import/preflight", {
        method: "POST",
        headers,
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
      const data = await importRig.mutateAsync({ yaml, rigRoot: rigRoot.trim() || undefined }) as InstantiateResult;
      setResult(data);
      setStep("done");
    } catch (err) {
      if (err instanceof ImportError) {
        if (err.code === "cycle_error") {
          setErrors(["Cycle detected in rig topology"]);
        } else {
          setErrors(err.errors);
        }
        setWarnings(err.warnings);
      } else {
        setErrors([err instanceof Error ? err.message : "Instantiate request failed"]);
      }
      setErrorAtStep(3);
      setStep("error");
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="import-flow" className="space-y-8">
      <WorkflowHeader
        eyebrow="Rig Import"
        title="Import Rig"
        description="Validate a RigSpec, run preflight checks, then instantiate a topology from YAML."
      />

      <WorkflowStepIndicator
        data-testid="step-indicator"
        steps={STEPS}
        currentStep={getStepNumber(step)}
        errorAtStep={step === "error" ? errorAtStep : 0}
      />

      {/* Step 1: Input */}
      {step === "input" && (
        <WorkflowSection title="Rig YAML" description="Paste a rig spec and optionally provide a rig root to anchor relative references during import.">
          <Textarea
            data-testid="yaml-input"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="Paste YAML rig spec here..."
            rows={14}
            className="font-mono text-body-sm mb-spacing-4"
          />
          <div className="mb-spacing-4">
            <label className="text-label-sm text-foreground-muted uppercase tracking-[0.04em] block mb-spacing-1">RIG ROOT (OPTIONAL)</label>
            <Input
              data-testid="rig-root-input"
              type="text"
              value={rigRoot}
              onChange={(e) => setRigRoot(e.target.value)}
              placeholder="/path/to/rig/root"
              className="font-mono text-body-sm"
            />
          </div>
          <Button
            variant="tactical"
            data-testid="validate-btn"
            onClick={handleValidate}
            disabled={!yaml.trim()}
          >
            VALIDATE RIGSPEC
          </Button>
        </WorkflowSection>
      )}

      {/* Validating */}
      {step === "validating" && (
        <div className="text-label-md text-foreground-muted">Validating...</div>
      )}

      {/* Step 2: Valid -> Preflight */}
      {step === "valid" && (
        <WorkflowSection title="Validation Passed" description="The RigSpec is valid. Run preflight checks before you instantiate it.">
          <Alert className="mb-spacing-4" data-testid="valid-message">
            <AlertDescription className="text-primary">RigSpec valid. Run preflight checks?</AlertDescription>
          </Alert>
          <Button variant="tactical" data-testid="preflight-btn" onClick={handlePreflight}>
            RUN PREFLIGHT
          </Button>
        </WorkflowSection>
      )}

      {/* Running preflight */}
      {step === "preflight" && (
        <div className="text-label-md text-foreground-muted">Running preflight...</div>
      )}

      {/* Step 3: Preflight done -> Instantiate */}
      {step === "preflight_done" && (
        <WorkflowSection title="Preflight Results" description="Review warnings before you instantiate the rig into live runtime sessions.">
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
        </WorkflowSection>
      )}

      {/* Instantiating */}
      {step === "instantiating" && (
        <div className="text-label-md text-foreground-muted">Instantiating...</div>
      )}

      {/* Done: Results */}
      {step === "done" && result && (
        <WorkflowSection
          title="Instantiate Result"
          description="The daemon returned per-node launch status for the imported topology."
          className="space-y-4"
        >
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

          {onBack ? (
            <div className="mt-spacing-6">
              <Button variant="ghost" onClick={onBack}>
                Close
              </Button>
            </div>
          ) : null}
        </div>
        </WorkflowSection>
      )}

      {/* Error state */}
      {step === "error" && (
        <WorkflowSection title="Import Errors" description="Fix the reported issues, then retry the import flow.">
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
            onClick={() => { setStep("input"); setErrors([]); setWarnings([]); setResult(null); setErrorAtStep(0); setRigRoot(""); }}
          >
            TRY AGAIN
          </Button>
        </div>
        </WorkflowSection>
      )}
      </div>
    </WorkspacePage>
  );
}
