import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { WorkflowHeader, WorkflowSection } from "./WorkflowScaffold.js";

export function AgentSpecValidateFlow() {
  const {
    currentAgentDraft,
    selectedAgentDraft,
    saveAgentDraft,
    rememberAgentDraft,
    clearSelectedAgentDraft,
  } = useSpecsWorkspace();
  const [yaml, setYaml] = useState(() => selectedAgentDraft?.yaml ?? currentAgentDraft?.yaml ?? "");
  const [status, setStatus] = useState<"idle" | "pending" | "valid" | "invalid" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    saveAgentDraft(yaml);
  }, [saveAgentDraft, yaml]);

  useEffect(() => {
    if (!selectedAgentDraft) return;
    setYaml(selectedAgentDraft.yaml);
    clearSelectedAgentDraft();
  }, [clearSelectedAgentDraft, selectedAgentDraft]);

  const handleValidate = async () => {
    rememberAgentDraft(yaml);
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
      <div data-testid="agent-spec-validate-flow" className="space-y-8">
        <WorkflowHeader
          eyebrow="Agent Spec Validation"
          title="VALIDATE AGENT"
          description="Check an AgentSpec before you use it in a rig."
        />

        <WorkflowSection title="Agent YAML" description="Paste or refine an AgentSpec draft, then validate it against the daemon contract.">
          <Textarea
            data-testid="agent-spec-yaml-input"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="Paste agent.yaml here..."
            rows={16}
            className="bg-background font-mono text-body-sm"
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="tactical"
              data-testid="agent-spec-validate-btn"
              onClick={handleValidate}
              disabled={!yaml.trim() || status === "pending"}
            >
              {status === "pending" ? "VALIDATING..." : "VALIDATE AGENTSPEC"}
            </Button>
          </div>

          {status === "valid" && (
            <Alert className="mt-spacing-1" data-testid="agent-spec-valid">
              <AlertDescription className="text-primary">AgentSpec valid.</AlertDescription>
            </Alert>
          )}

          {(status === "invalid" || status === "error") && (
            <Alert className="mt-spacing-1" data-testid="agent-spec-invalid">
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </WorkflowSection>
      </div>
    </WorkspacePage>
  );
}
