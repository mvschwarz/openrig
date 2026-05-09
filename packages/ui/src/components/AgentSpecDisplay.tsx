import type { ReactNode } from "react";
import type { AgentSpecReview } from "../hooks/useSpecReview.js";
import { WorkflowCodePreview } from "./WorkflowScaffold.js";
import { FileReferenceTrigger } from "./drawer-triggers/FileReferenceTrigger.js";
import { ToolMark } from "./graphics/RuntimeMark.js";

interface AgentSpecDisplayProps {
  review?: AgentSpecReview | null;
  yaml: string;
  testIdPrefix?: string;
  sourcePath?: string | null;
}

function resolveSpecRelativePath(sourcePath: string | null | undefined, filePath: string): string | null {
  if (!sourcePath || !filePath) return null;
  if (filePath.startsWith("/")) return filePath;
  const sourceDir = sourcePath.replace(/\/[^/]*$/, "");
  const parts = `${sourceDir}/${filePath}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return `/${resolved.join("/")}`;
}

function FileChip({
  label,
  sourcePath,
  testId,
  children,
}: {
  label: string;
  sourcePath?: string | null;
  testId: string;
  children: ReactNode;
}) {
  const absolutePath = resolveSpecRelativePath(sourcePath, label);
  if (!absolutePath) return <>{children}</>;
  return (
    <FileReferenceTrigger
      data={{ path: label, absolutePath }}
      testId={testId}
      className="inline-block text-left"
    >
      {children}
    </FileReferenceTrigger>
  );
}

export function AgentSpecDisplay({ review, yaml, testIdPrefix = "agent", sourcePath }: AgentSpecDisplayProps) {
  const profiles = review?.profiles ?? [];
  const resources = review?.resources ?? { skills: [], guidance: [], hooks: [], subagents: [] };
  const startup = review?.startup ?? { files: [], actions: [] };

  return (
    <>
      {/* Profiles */}
      {profiles.length > 0 && (
        <div data-testid={`${testIdPrefix}-profiles-section`} className="border border-stone-200 p-3">
          <div className="font-mono text-xs font-bold mb-2">Profiles</div>
          <div className="space-y-1">
            {profiles.map((p) => (
              <div key={p.name} className="font-mono text-[10px] flex justify-between">
                <span className="font-bold">{p.name}</span>
                {p.description && <span className="text-stone-500">{p.description}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resources */}
      <div data-testid={`${testIdPrefix}-resources-section`} className="border border-stone-200 p-3">
        <div className="font-mono text-xs font-bold mb-2">Resources</div>
        <div className="space-y-2 font-mono text-[10px]">
          {resources.skills.length > 0 && (
            <div>
              <span className="text-stone-500">Skills:</span>{" "}
              {resources.skills.map((s, i) => (
                <span key={i} className="mr-1 mb-0.5 inline-flex items-center gap-1 bg-stone-100 px-1.5 py-0.5">
                  <ToolMark tool="file" size="xs" decorative />
                  {s}
                </span>
              ))}
            </div>
          )}
          {resources.guidance.length > 0 && (
            <div>
              <span className="text-stone-500">Guidance:</span>{" "}
              {resources.guidance.map((g, i) => (
                <FileChip
                  key={`${g}-${i}`}
                  label={g}
                  sourcePath={sourcePath}
                  testId={`${testIdPrefix}-guidance-file-trigger-${g}`}
                >
                  <span className="mr-1 mb-0.5 inline-flex items-center gap-1 bg-stone-100 px-1.5 py-0.5 underline decoration-dotted decoration-stone-400">
                    <ToolMark tool={g} size="xs" decorative />
                    {g}
                  </span>
                </FileChip>
              ))}
            </div>
          )}
          {resources.hooks.length > 0 && (
            <div>
              <span className="text-stone-500">Hooks:</span> {resources.hooks.join(", ")}
            </div>
          )}
        </div>
      </div>

      {/* Startup */}
      {(startup.files.length > 0 || startup.actions.length > 0) && (
        <div data-testid={`${testIdPrefix}-startup-section`} className="border border-stone-200 p-3">
          <div className="font-mono text-xs font-bold mb-2">Startup</div>
          {startup.files.length > 0 && (
            <div className="mb-2">
              <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Files</div>
              {startup.files.map((f, i) => (
                <div key={i} className="font-mono text-[10px]">
                  <FileChip
                    label={f.path}
                    sourcePath={sourcePath}
                    testId={`${testIdPrefix}-startup-file-trigger-${f.path}`}
                  >
                    <span className="inline-flex items-center gap-1 underline decoration-dotted decoration-stone-400">
                      <ToolMark tool={f.path} size="xs" decorative />
                      {f.path}
                    </span>
                  </FileChip>{" "}
                  {f.required && <span className="text-red-500 text-[8px]">REQUIRED</span>}
                </div>
              ))}
            </div>
          )}
          {startup.actions.length > 0 && (
            <div>
              <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Actions</div>
              {startup.actions.map((a, i) => (
                <div key={i} className="font-mono text-[10px]">
                  <span className="inline-flex items-center gap-1 text-stone-500">
                    <ToolMark tool={a.type.includes("command") ? "terminal" : a.type} size="xs" decorative />
                    {a.type}:
                  </span>{" "}
                  {a.value}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* YAML */}
      <WorkflowCodePreview title="YAML Preview" testId={`${testIdPrefix}-spec-yaml`}>
        {yaml}
      </WorkflowCodePreview>
    </>
  );
}
