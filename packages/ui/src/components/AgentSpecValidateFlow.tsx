import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WorkspacePage } from "./WorkspacePage.js";

export function AgentSpecValidateFlow() {
  const navigate = useNavigate();
  const [yaml, setYaml] = useState("");
  const [status, setStatus] = useState<"idle" | "pending" | "valid" | "invalid" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);

  const handleValidate = async () => {
    setStatus("pending");
    setErrors([]);
    try {
      const res = await fetch("/api/agents/validate", {
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: yaml,
      });
      const data = await res.json().catch(() => ({})) as { valid?: boolean; errors?: string[] };
      if (res.ok && data.valid) {
        setStatus("valid");
        return;
      }
      setErrors(data.errors ?? ["Validation failed"]);
      setStatus("invalid");
    } catch {
      setErrors(["Validation request failed"]);
      setStatus("error");
    }
  };

  return (
    <WorkspacePage>
    <div data-testid="agent-spec-validate-flow">
      <div className="mb-spacing-8 flex items-center justify-between">
        <div>
          <h2 className="text-headline-lg uppercase tracking-[0.06em]">VALIDATE AGENT</h2>
          <p className="mt-spacing-1 font-grotesk text-label-md text-foreground-muted">
            Check an AgentSpec before you use it in a rig.
          </p>
        </div>
        <Button variant="ghost" onClick={() => navigate({ to: "/specs" })}>
          &larr; Specs
        </Button>
      </div>

      <Textarea
        data-testid="agent-spec-yaml-input"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        placeholder="Paste agent.yaml here..."
        rows={16}
        className="mb-spacing-4 bg-background font-mono text-body-sm"
      />

      <Button
        variant="tactical"
        data-testid="agent-spec-validate-btn"
        onClick={handleValidate}
        disabled={!yaml.trim() || status === "pending"}
      >
        {status === "pending" ? "VALIDATING..." : "VALIDATE AGENTSPEC"}
      </Button>

      {status === "valid" && (
        <Alert className="mt-spacing-4" data-testid="agent-spec-valid">
          <AlertDescription className="text-primary">AgentSpec valid.</AlertDescription>
        </Alert>
      )}

      {(status === "invalid" || status === "error") && (
        <Alert className="mt-spacing-4" data-testid="agent-spec-invalid">
          <AlertDescription>
            <ul className="list-disc pl-5">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
    </WorkspacePage>
  );
}
