import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("polish-8 demo-readiness source guards", () => {
  it("LiveNodeDetails uses tab-owned body content and compact terminal preview", () => {
    const src = read("../src/components/LiveNodeDetails.tsx");
    expect(src).not.toContain("LiveIdentityDisplay");
    expect(src).toContain("data-testid=\"live-node-tab-body\"");
    expect(src).toContain("variant=\"compact-terminal\"");
    expect(src).toContain("bg-stone-950/65");
  });

  it("StoryTab renders a newest-first connected step tree", () => {
    const src = read("../src/components/slices/tabs/StoryTab.tsx");
    expect(src).toContain("data-testid=\"story-step-tree\"");
    expect(src).toContain("data-order=\"newest-first\"");
    expect(src).toContain("story-step-connector");
    expect(src).toContain("timestampSortValue(b.ts) - timestampSortValue(a.ts)");
  });

  it("Slice Overview and Artifacts are distinct surfaces", () => {
    const src = read("../src/components/project/ScopePages.tsx");
    expect(src).toContain("function SliceOverviewTab({ detail }");
    expect(src).toContain("slice-overview-summary");
    expect(src).toContain("function SliceArtifactsTab({ detail }");
    expect(src).toContain("slice-artifacts-files");
    expect(src).toContain("slice-artifacts-commits");
  });

  it("TopologyTab reaches the React Flow workflow graph instead of the adjacency panel", () => {
    const topologySrc = read("../src/components/slices/tabs/TopologyTab.tsx");
    const graphSrc = read("../src/components/slices/tabs/SliceWorkflowGraph.tsx");
    expect(topologySrc).toContain("<SliceWorkflowGraph specGraph={specGraph} />");
    expect(topologySrc).not.toContain("function SpecGraphPanel");
    expect(graphSrc).toContain("ReactFlow");
    expect(graphSrc).toContain("dagre.layout");
    expect(graphSrc).toContain("RegistrationMarks");
  });

  it("SliceWorkflowGraph single-sources rendered node dimensions with dagre layout dimensions", () => {
    const graphSrc = read("../src/components/slices/tabs/SliceWorkflowGraph.tsx");
    expect(graphSrc.match(/\b200\b/g) ?? []).toHaveLength(1);
    expect(graphSrc.match(/\b112\b/g) ?? []).toHaveLength(1);
    expect(graphSrc).toContain("style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}");
    expect(graphSrc).not.toContain("w-[200px]");
    expect(graphSrc).not.toContain("h-[112px]");
  });
});
