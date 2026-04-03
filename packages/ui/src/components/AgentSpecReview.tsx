import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import {
  WorkflowCodePreview,
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";

function extractScalar(yaml: string, key: string, fallback: string): string {
  const pattern = new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n#]+)["']?`, "m");
  return yaml.match(pattern)?.[1]?.trim() || fallback;
}

function countTopLevelEntries(yaml: string, sectionName: string): number {
  const lines = yaml.split("\n");
  let insideSection = false;
  let sectionIndent = 0;
  let count = 0;

  for (const line of lines) {
    const match = line.match(/^(\s*)([^:#][^:]*)\s*:\s*(.*)$/);
    if (!match) continue;

    const indent = match[1]?.length ?? 0;
    const key = match[2]?.trim() ?? "";

    if (!insideSection) {
      if (key === sectionName) {
        insideSection = true;
        sectionIndent = indent;
      }
      continue;
    }

    if (indent <= sectionIndent) break;
    if (indent === sectionIndent + 2 && !match[3]?.trim()) {
      count += 1;
    }
  }

  return count;
}

function countSkills(yaml: string): number {
  const lines = yaml.split("\n");
  let count = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^(\s*)skills:\s*(.*)$/);
    if (!match) continue;

    const indent = match[1]?.length ?? 0;
    const rest = match[2]?.trim() ?? "";

    if (rest.startsWith("[") && rest.endsWith("]")) {
      const values = rest.slice(1, -1).split(",").map((value) => value.trim()).filter(Boolean);
      count += values.length;
      continue;
    }

    if (rest && rest !== "[]") continue;

    for (let lookahead = index + 1; lookahead < lines.length; lookahead += 1) {
      const nestedLine = lines[lookahead] ?? "";
      if (!nestedLine.trim()) continue;
      const nestedIndent = nestedLine.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (nestedIndent <= indent) break;
      if (nestedLine.match(/^\s*-\s+/)) {
        count += 1;
      }
    }
  }

  return count;
}

export function AgentSpecReview() {
  const navigate = useNavigate();
  const { selectedAgentDraft, currentAgentDraft } = useSpecsWorkspace();
  const draft = selectedAgentDraft ?? currentAgentDraft;

  if (!draft) {
    return (
      <WorkspacePage>
        <div data-testid="agent-spec-review-empty" className="space-y-5">
          <WorkflowHeader
            eyebrow="Agent Spec Review"
            title="No AgentSpec Selected"
            description="Choose a current or recent agent draft from the Specs drawer to review it here before you validate it."
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>
            Open Validate
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  const version = extractScalar(draft.yaml, "version", "Unspecified");
  const profileCount = countTopLevelEntries(draft.yaml, "profiles");
  const skillCount = countSkills(draft.yaml);

  return (
    <WorkspacePage>
      <div data-testid="agent-spec-review" className="space-y-8">
        <WorkflowHeader
          eyebrow="Agent Spec Review"
          title={draft.label}
          description="Review the saved agent draft before you move into validation. This surface stays read-only on purpose."
          actions={(
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>
              Open In Validate
            </Button>
          )}
        />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value="AgentSpec" testId="agent-spec-summary-format" />
          <WorkflowSummaryCard label="Version" value={version} testId="agent-spec-summary-version" />
          <WorkflowSummaryCard label="Profiles" value={profileCount} testId="agent-spec-summary-profiles" />
          <WorkflowSummaryCard label="Skills" value={skillCount} testId="agent-spec-summary-skills" />
        </WorkflowSummaryGrid>

        <WorkflowCodePreview title="YAML Preview" testId="agent-spec-yaml">
          {draft.yaml}
        </WorkflowCodePreview>
      </div>
    </WorkspacePage>
  );
}
