import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { SpecTopologyPreview } from "./SpecTopologyPreview.js";
import { useLibraryReview, type LibraryRigReview, type LibraryAgentReview } from "../hooks/useSpecLibrary.js";
import {
  WorkflowCodePreview,
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { useState } from "react";

type RigTab = "topology" | "configuration" | "yaml";

interface LibraryReviewProps {
  entryId: string;
}

function ProvenanceBadge({ sourcePath, sourceState }: { sourcePath: string; sourceState: string }) {
  return (
    <div className="font-mono text-[9px] text-stone-500" data-testid="library-provenance">
      Source: {sourcePath} · {sourceState}
    </div>
  );
}

function LibraryAgentReview({ review }: { review: LibraryAgentReview }) {
  const navigate = useNavigate();

  return (
    <WorkspacePage>
      <div data-testid="library-review-agent" className="space-y-6">
        <WorkflowHeader
          eyebrow="Library — Agent Spec"
          title={review.name}
          description={review.description ?? "Agent spec from library."}
          actions={<Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>Validate</Button>}
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value="AgentSpec" testId="lib-agent-format" />
          <WorkflowSummaryCard label="Version" value={review.version} testId="lib-agent-version" />
          <WorkflowSummaryCard label="Profiles" value={review.profiles.length} testId="lib-agent-profiles" />
          <WorkflowSummaryCard label="Skills" value={review.resources.skills.length} testId="lib-agent-skills" />
        </WorkflowSummaryGrid>

        {/* Profiles */}
        {review.profiles.length > 0 && (
          <div data-testid="lib-agent-profiles-section" className="border border-stone-200 p-3">
            <div className="font-mono text-xs font-bold mb-2">Profiles</div>
            <div className="space-y-1">
              {review.profiles.map((p) => (
                <div key={p.name} className="font-mono text-[10px] flex justify-between">
                  <span className="font-bold">{p.name}</span>
                  {p.description && <span className="text-stone-500">{p.description}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resources */}
        <div data-testid="lib-agent-resources-section" className="border border-stone-200 p-3">
          <div className="font-mono text-xs font-bold mb-2">Resources</div>
          <div className="space-y-2 font-mono text-[10px]">
            {review.resources.skills.length > 0 && (
              <div><span className="text-stone-500">Skills:</span> {review.resources.skills.map((s, i) => (
                <span key={i} className="inline-block bg-stone-100 px-1.5 py-0.5 mr-1 mb-0.5">{s}</span>
              ))}</div>
            )}
            {review.resources.guidance.length > 0 && (
              <div><span className="text-stone-500">Guidance:</span> {review.resources.guidance.map((g, i) => (
                <span key={i} className="inline-block bg-stone-100 px-1.5 py-0.5 mr-1 mb-0.5">{g}</span>
              ))}</div>
            )}
            {review.resources.hooks.length > 0 && (
              <div><span className="text-stone-500">Hooks:</span> {review.resources.hooks.join(", ")}</div>
            )}
          </div>
        </div>

        {/* Startup */}
        {(review.startup.files.length > 0 || review.startup.actions.length > 0) && (
          <div data-testid="lib-agent-startup-section" className="border border-stone-200 p-3">
            <div className="font-mono text-xs font-bold mb-2">Startup</div>
            {review.startup.files.length > 0 && (
              <div className="mb-2">
                <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Files</div>
                {review.startup.files.map((f, i) => (
                  <div key={i} className="font-mono text-[10px]">
                    {f.path} {f.required && <span className="text-red-500 text-[8px]">REQUIRED</span>}
                  </div>
                ))}
              </div>
            )}
            {review.startup.actions.length > 0 && (
              <div>
                <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Actions</div>
                {review.startup.actions.map((a, i) => (
                  <div key={i} className="font-mono text-[10px]">
                    <span className="text-stone-500">{a.type}:</span> {a.value}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <WorkflowCodePreview title="YAML" testId="lib-agent-yaml">{review.raw}</WorkflowCodePreview>
      </div>
    </WorkspacePage>
  );
}

function LibraryRigReviewContent({ review }: { review: LibraryRigReview }) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<RigTab>("topology");

  return (
    <WorkspacePage>
      <div data-testid="library-review-rig" className="space-y-6">
        <WorkflowHeader
          eyebrow="Library — Rig Spec"
          title={review.name}
          description={review.summary ?? "Rig spec from library."}
          actions={<Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>Import</Button>}
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value={review.format === "pod_aware" ? "Pod-Aware" : "Legacy"} testId="lib-rig-format" />
          <WorkflowSummaryCard
            label={review.format === "pod_aware" ? "Pods" : "Nodes"}
            value={review.format === "pod_aware" ? review.pods?.length ?? 0 : review.nodes?.length ?? 0}
            testId="lib-rig-pods"
          />
          <WorkflowSummaryCard
            label="Members"
            value={review.format === "pod_aware"
              ? review.pods?.reduce((sum, p) => sum + p.members.length, 0) ?? 0
              : review.nodes?.length ?? 0}
            testId="lib-rig-members"
          />
          <WorkflowSummaryCard
            label="Edges"
            value={review.edges.length + (review.format === "pod_aware"
              ? review.pods?.reduce((sum, p) => sum + (p.edges?.length ?? 0), 0) ?? 0
              : 0)}
            testId="lib-rig-edges"
          />
        </WorkflowSummaryGrid>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-stone-200">
          {(["topology", "configuration", "yaml"] as RigTab[]).map((tab) => (
            <button
              key={tab}
              data-testid={`lib-tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                activeTab === tab
                  ? "border-b-2 border-stone-900 text-stone-900 font-bold"
                  : "text-stone-500 hover:text-stone-700"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Topology */}
        {activeTab === "topology" && review.graph && (
          <SpecTopologyPreview graph={review.graph} testId="lib-topology-preview" />
        )}

        {/* Configuration — full structured tables */}
        {activeTab === "configuration" && (
          <div data-testid="lib-config-tables" className="space-y-4">
            {review.format === "pod_aware" && review.pods?.map((pod) => (
              <div key={pod.id} className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">{pod.label ?? pod.id}</div>
                <table className="w-full font-mono text-[10px]">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-500">
                      <th className="text-left py-1">Member</th>
                      <th className="text-left py-1">Agent Ref</th>
                      <th className="text-left py-1">Runtime</th>
                      <th className="text-left py-1">Profile</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pod.members.map((m) => (
                      <tr key={m.id} className="border-b border-stone-100">
                        <td className="py-1">{m.id}</td>
                        <td className="py-1 text-stone-600">{m.agentRef}</td>
                        <td className="py-1">{m.runtime}</td>
                        <td className="py-1 text-stone-500">{m.profile ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {review.format === "legacy" && review.nodes && (
              <div className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">Nodes</div>
                <table className="w-full font-mono text-[10px]">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-500">
                      <th className="text-left py-1">ID</th>
                      <th className="text-left py-1">Runtime</th>
                      <th className="text-left py-1">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.nodes.map((n) => (
                      <tr key={n.id} className="border-b border-stone-100">
                        <td className="py-1">{n.id}</td>
                        <td className="py-1">{n.runtime}</td>
                        <td className="py-1 text-stone-500">{n.role ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {review.edges.length > 0 && (
              <div className="border border-stone-200 p-3">
                <div className="font-mono text-xs font-bold mb-2">
                  {review.format === "pod_aware" ? "Cross-Pod Edges" : "Edges"}
                </div>
                <table className="w-full font-mono text-[10px]">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-500">
                      <th className="text-left py-1">From</th>
                      <th className="text-left py-1">To</th>
                      <th className="text-left py-1">Kind</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.edges.map((e, i) => (
                      <tr key={i} className="border-b border-stone-100">
                        <td className="py-1">{e.from}</td>
                        <td className="py-1">{e.to}</td>
                        <td className="py-1 text-stone-500">{e.kind}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* YAML */}
        {activeTab === "yaml" && (
          <WorkflowCodePreview title="YAML" testId="lib-rig-yaml">{review.raw}</WorkflowCodePreview>
        )}
      </div>
    </WorkspacePage>
  );
}

export function LibraryReview({ entryId }: LibraryReviewProps) {
  const navigate = useNavigate();
  const { data: review, isLoading, error } = useLibraryReview(entryId);

  if (isLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-stone-400">Loading spec review...</div>
      </WorkspacePage>
    );
  }

  if (error || !review) {
    return (
      <WorkspacePage>
        <div data-testid="library-review-error" className="space-y-4">
          <WorkflowHeader eyebrow="Library" title="Spec Not Found" description={(error as Error)?.message ?? "Could not load spec."} />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Specs</Button>
        </div>
      </WorkspacePage>
    );
  }

  if (review.kind === "agent") {
    return <LibraryAgentReview review={review as LibraryAgentReview} />;
  }

  return <LibraryRigReviewContent review={review as LibraryRigReview} />;
}
