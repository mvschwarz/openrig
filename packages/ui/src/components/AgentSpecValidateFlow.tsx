import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header.js";
import { StatusBadge } from "@/components/ui/status-badge.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { WorkflowSection } from "./WorkflowScaffold.js";

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
        <PageHeader
          title="Validate agent"
          description="Check an agent spec before you use it in a rig."
        />

        <WorkflowSection title="Agent YAML" description="Paste or refine an agent spec draft, then validate it against the daemon contract.">
          <Textarea
            data-testid="agent-spec-yaml-input"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="Paste agent.yaml here..."
            rows={16}
            className="bg-background font-mono text-sm"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            {status === "valid" ? (
              <StatusBadge status="done" label="Valid" testId="agent-spec-valid" />
            ) : status === "invalid" || status === "error" ? (
              <StatusBadge status="failed" label="Invalid" testId="agent-spec-invalid-badge" />
            ) : (
              <span />
            )}
            <Button
              variant="default"
              data-testid="agent-spec-validate-btn"
              onClick={handleValidate}
              disabled={!yaml.trim() || status === "pending"}
            >
              {status === "pending" ? "Validating..." : "Validate agent spec"}
            </Button>
          </div>

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
