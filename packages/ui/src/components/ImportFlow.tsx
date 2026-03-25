import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

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

export function ImportFlow({ onBack }: ImportFlowProps = {}) {
  const navigate = useNavigate();
  const handleBack = onBack ?? (() => navigate({ to: "/" }));
  const [yaml, setYaml] = useState("");
  const [step, setStep] = useState<Step>("input");
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
        setStep("error");
      } else {
        setStep("valid");
      }
    } catch {
      setErrors(["Validation request failed"]);
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
      if (data.errors && data.errors.length > 0) {
        setErrors(data.errors);
        setStep("error");
      } else {
        setWarnings(data.warnings ?? []);
        setStep("preflight_done");
      }
    } catch {
      setErrors(["Preflight request failed"]);
      setStep("error");
    }
  };

  const handleInstantiate = async () => {
    setStep("instantiating");
    setErrors([]);
    try {
      const res = await fetch("/api/rigs/import", {
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: yaml,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as InstantiateFailure;
        const errorList = data.errors ?? (data.message ? [data.message] : [`Import failed (${res.status})`]);
        setErrors(errorList);
        setStep("error");
        return;
      }
      const data = (await res.json()) as InstantiateResult;
      setResult(data);
      setStep("done");
    } catch {
      setErrors(["Instantiate request failed"]);
      setStep("error");
    }
  };

  return (
    <div data-testid="import-flow" style={{ padding: 16 }}>
      <button onClick={handleBack}>Back to Dashboard</button>
      <h2>Import Rig</h2>

      {step === "input" && (
        <div>
          <textarea
            data-testid="yaml-input"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="Paste YAML rig spec here..."
            rows={12}
            style={{ width: "100%", fontFamily: "monospace" }}
          />
          <button data-testid="validate-btn" onClick={handleValidate} disabled={!yaml.trim()}>
            Validate
          </button>
        </div>
      )}

      {step === "validating" && <div>Validating...</div>}

      {step === "valid" && (
        <div>
          <div data-testid="valid-message">Valid spec. Run preflight?</div>
          <button data-testid="preflight-btn" onClick={handlePreflight}>Run Preflight</button>
        </div>
      )}

      {step === "preflight" && <div>Running preflight...</div>}

      {step === "preflight_done" && (
        <div>
          {warnings.length > 0 && (
            <div data-testid="preflight-warnings">
              <strong>Warnings:</strong>
              {warnings.map((w, i) => <div key={i}>- {w}</div>)}
            </div>
          )}
          <div data-testid="preflight-ready">Preflight passed. Instantiate?</div>
          <button data-testid="instantiate-btn" onClick={handleInstantiate}>Instantiate</button>
        </div>
      )}

      {step === "instantiating" && <div>Instantiating...</div>}

      {step === "done" && result && (
        <div data-testid="import-result">
          <strong>Rig created: {result.specName} ({result.rigId})</strong>
          {result.nodes.map((n) => (
            <div key={n.logicalId}>{n.logicalId}: {n.status}</div>
          ))}
        </div>
      )}

      {step === "error" && (
        <div data-testid="import-errors">
          {errors.map((e, i) => <div key={i} style={{ color: "red" }}>{e}</div>)}
          <button onClick={() => setStep("input")}>Try Again</button>
        </div>
      )}
    </div>
  );
}
