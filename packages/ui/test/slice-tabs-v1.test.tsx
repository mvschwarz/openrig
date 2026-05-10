// Slice Story View v1 — focused tab tests for the 4 v1 dimensions.
//
// Pins:
//   - StoryTab: spec-driven phase grouping (no v0 hardcoded legacy enum)
//   - StoryTab: untagged events render with neutral palette + label
//   - AcceptanceTab: Current Step panel renders when bound; absent when not
//   - AcceptanceTab: PROGRESS.md checkbox view still renders alongside
//   - TopologyTab: spec graph renders nodes + edges + isCurrent/isEntry/
//     isTerminal badges + loop-back edge styling when bound
//   - TopologyTab: per-rig listing still renders alongside spec graph
//   - TopologyTab: routingType="direct" carved-out — every edge has it

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createTestRouter } from "./helpers/test-router.js";
import { StoryTab } from "../src/components/slices/tabs/StoryTab.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { AcceptanceTab } from "../src/components/slices/tabs/AcceptanceTab.js";
import { TopologyTab } from "../src/components/slices/tabs/TopologyTab.js";
import type {
  StoryEvent,
  PhaseDefinition,
  CurrentStepPayload,
  QueueItemDetail,
  SpecGraphPayload,
  SliceDetail,
} from "../src/hooks/useSlices.js";

afterEach(() => cleanup());

function event(overrides: Partial<StoryEvent>): StoryEvent {
  return {
    ts: "2026-05-04T00:00:00.000Z",
    phase: null,
    kind: "queue.created",
    actorSession: "src@r",
    qitemId: "q-1",
    summary: "summary",
    detail: null,
    ...overrides,
  };
}

const SPEC_PHASES: PhaseDefinition[] = [
  { id: "discovery", label: "discovery-router", role: "discovery-router" },
  { id: "delivery", label: "delivery-driver", role: "delivery-driver" },
  { id: "qa", label: "qa-tester", role: "qa-tester" },
];

function renderStory(ui: ReactNode) {
  return render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection: vi.fn() }}>
      {ui}
    </DrawerSelectionContext.Provider>,
  );
}

describe("PL-slice-story-view-v1 StoryTab", () => {
  it("groups events by spec-declared phase labels (NOT v0 hardcoded legacy names)", () => {
    const events = [
      event({ kind: "queue.created", phase: "discovery", qitemId: "q-d" }),
      event({ kind: "queue.handed_off", phase: "delivery", qitemId: "q-x" }),
      event({ kind: "transition.in-progress", phase: "qa", qitemId: "q-q" }),
    ];
    renderStory(<StoryTab events={events} phaseDefinitions={SPEC_PHASES} />);
    // Each row's phase chip uses the spec-declared label (which equals
    // the actor_role for v1's projector default).
    expect(screen.getByTestId("story-row-phase-queue.created").textContent).toBe("discovery-router");
    expect(screen.getByTestId("story-row-phase-queue.handed_off").textContent).toBe("delivery-driver");
    expect(screen.getByTestId("story-row-phase-transition.in-progress").textContent).toBe("qa-tester");
  });

  it("untagged events render with the neutral 'untagged' label + stone palette", () => {
    const events = [event({ kind: "doc.edited", phase: null, qitemId: null })];
    renderStory(<StoryTab events={events} phaseDefinitions={SPEC_PHASES} />);
    const chip = screen.getByTestId("story-row-phase-doc.edited");
    expect(chip.textContent).toBe("untagged");
    expect(chip.getAttribute("data-phase-id")).toBe("untagged");
    expect(chip.className).toContain("stone-100");
  });

  it("when phaseDefinitions is null (unbound slice), spec phase ids on events fall through exactly", () => {
    // Edge case: an event somehow carries a phase id but the slice isn't
    // bound. The chip falls back to displaying the raw phase id rather
    // than crashing. (Realistic v1 scenario when a previously-bound slice
    // loses its workflow_instance binding — events were tagged at fetch
    // time, definitions weren't.)
    const events = [event({ kind: "queue.created", phase: "step-x" })];
    renderStory(<StoryTab events={events} phaseDefinitions={null} />);
    expect(screen.getByTestId("story-row-phase-queue.created").textContent).toBe("step-x");
  });

  it("renders a newest-first connected step tree", () => {
    const events = [
      event({ kind: "old.event", ts: "2026-05-04T00:00:00.000Z", summary: "older" }),
      event({ kind: "new.event", ts: "2026-05-04T01:00:00.000Z", summary: "newer" }),
    ];
    renderStory(<StoryTab events={events} phaseDefinitions={null} />);
    expect(screen.getByTestId("story-step-tree").getAttribute("data-order")).toBe("newest-first");
    const rows = screen.getAllByTestId(/story-row-/);
    expect(rows[0]?.getAttribute("data-testid")).toBe("story-row-new.event");
    expect(screen.getByTestId("story-step-connector-new.event")).toBeDefined();
  });

  it("renders qitem body as the primary story content when queue details are loaded", () => {
    const queueItem: QueueItemDetail = {
      qitemId: "q-1",
      tsCreated: "2026-05-04T00:00:00.000Z",
      tsUpdated: "2026-05-04T00:00:00.000Z",
      sourceSession: "src@r",
      destinationSession: "dest@r",
      state: "in-progress",
      priority: "routine",
      tier: "mode2",
      tags: ["demo"],
      body: "Implement the observability body-first story view.\nInclude acceptance evidence.",
    };
    renderStory(
      <StoryTab
        events={[
          event({
            kind: "queue.created",
            qitemId: "q-1",
            summary: "src@r -> dest@r: truncated metadata summary",
          }),
        ]}
        phaseDefinitions={null}
        queueItemsById={new Map([["q-1", queueItem]])}
      />,
    );
    const body = screen.getByTestId("story-row-body-queue.created");
    expect(body.getAttribute("data-source")).toBe("qitem");
    expect(body.textContent).toContain("Implement the observability body-first story view.");
    expect(screen.getByTestId("story-row-summary-queue.created").textContent).toContain(
      "truncated metadata summary",
    );
  });
});

// --- AcceptanceTab ---

function acceptanceShape(currentStep: CurrentStepPayload | null): SliceDetail["acceptance"] {
  return {
    totalItems: 4,
    doneItems: 2,
    percentage: 50,
    items: [
      { text: "Item 1", done: true, source: { file: "README.md", line: 10 } },
      { text: "Item 2", done: false, source: { file: "README.md", line: 11 } },
    ],
    closureCallout: null,
    currentStep,
  };
}

describe("PL-slice-story-view-v1 AcceptanceTab", () => {
  it("renders Current Step panel when bound (above the v0 checkbox list)", () => {
    const cs: CurrentStepPayload = {
      stepId: "delivery",
      role: "delivery-driver",
      objective: "Implement the slice per packet.",
      allowedExits: ["handoff", "waiting", "failed"],
      allowedNextSteps: [
        { stepId: "lifecycle", role: "lifecycle-router", reason: "next_hop" },
      ],
      hopCount: 3,
      instanceStatus: "active",
    };
    render(<AcceptanceTab acceptance={acceptanceShape(cs)} />);
    expect(screen.getByTestId("acceptance-current-step")).toBeDefined();
    expect(screen.getByTestId("acceptance-current-step-id").textContent).toBe("delivery");
    expect(screen.getByTestId("acceptance-current-step-objective").textContent).toContain("Implement the slice");
    // allowed exits + allowed next steps both present.
    const allowed = screen.getByTestId("acceptance-current-step-allowed-exits");
    expect(allowed.textContent).toContain("handoff");
    expect(allowed.textContent).toContain("waiting");
    expect(allowed.textContent).toContain("failed");
    expect(screen.getByTestId("acceptance-next-step-lifecycle")).toBeDefined();
    // v0 checkbox view still rendering alongside.
    expect(screen.getByTestId("acceptance-list")).toBeDefined();
    expect(screen.getByTestId("acceptance-progress-bar")).toBeDefined();
  });

  it("does NOT render Current Step panel when unbound (currentStep=null)", () => {
    render(<AcceptanceTab acceptance={acceptanceShape(null)} />);
    expect(screen.queryByTestId("acceptance-current-step")).toBeNull();
    // v0 checkbox view still rendering — confirms fallback intact.
    expect(screen.getByTestId("acceptance-list")).toBeDefined();
  });

  it("Current Step shows terminal marker when allowedNextSteps is empty", () => {
    const cs: CurrentStepPayload = {
      stepId: "qa",
      role: "qa-tester",
      objective: null,
      allowedExits: ["done"],
      allowedNextSteps: [],
      hopCount: 5,
      instanceStatus: "active",
    };
    render(<AcceptanceTab acceptance={acceptanceShape(cs)} />);
    const nextSteps = screen.getByTestId("acceptance-current-step-allowed-next-steps");
    expect(nextSteps.textContent).toContain("terminal");
    expect(screen.getByRole("img", { name: "Terminal" })).toBeDefined();
  });
});

// --- TopologyTab ---

function topologyShape(specGraph: SpecGraphPayload | null, withRigs = true): SliceDetail["topology"] {
  return {
    affectedRigs: withRigs
      ? [{ rigId: "rig-1", rigName: "demo", sessionNames: ["alpha@demo", "beta@demo"] }]
      : [],
    totalSeats: withRigs ? 2 : 0,
    specGraph,
  };
}

describe("PL-slice-story-view-v1 TopologyTab", () => {
  function makeRouter(topology: SliceDetail["topology"]) {
    return createTestRouter({ component: () => <TopologyTab topology={topology} />, path: "/" });
  }

  it("renders the spec graph panel when specGraph is present", async () => {
    const sg: SpecGraphPayload = {
      specName: "test-loop",
      specVersion: "1",
      nodes: [
        { stepId: "discovery", label: "discovery-router", role: "discovery-router", preferredTarget: "intake@r", isEntry: true, isCurrent: false, isTerminal: false },
        { stepId: "delivery", label: "delivery-driver", role: "delivery-driver", preferredTarget: "driver@r", isEntry: false, isCurrent: true, isTerminal: false },
        { stepId: "qa", label: "qa-tester", role: "qa-tester", preferredTarget: "qa@r", isEntry: false, isCurrent: false, isTerminal: false },
      ],
      edges: [
        { fromStepId: "discovery", toStepId: "delivery", routingType: "direct", isLoopBack: false },
        { fromStepId: "delivery", toStepId: "qa", routingType: "direct", isLoopBack: false },
        { fromStepId: "qa", toStepId: "discovery", routingType: "direct", isLoopBack: true },
      ],
    };
    render(makeRouter(topologyShape(sg)));
    await waitFor(() => expect(screen.getByTestId("topology-spec-graph")).toBeDefined());
    expect(screen.getByTestId("topology-spec-graph").getAttribute("data-layout")).toBe("react-flow-dagre");
    expect(screen.getByTestId("slice-workflow-graph")).toBeDefined();
    expect(screen.getByTestId("topology-spec-name").textContent).toBe("test-loop");
    // Per-step nodes rendered.
    expect(screen.getByTestId("spec-node-discovery")).toBeDefined();
    expect(screen.getByTestId("spec-node-delivery")).toBeDefined();
    expect(screen.getByTestId("spec-node-qa")).toBeDefined();
    // Entry + current badges.
    expect(screen.getByTestId("spec-node-discovery-entry-badge")).toBeDefined();
    expect(screen.getByTestId("spec-node-delivery-current-badge")).toBeDefined();
    expect(screen.queryByTestId("spec-node-qa-current-badge")).toBeNull();
    // Edges, including loop-back.
    expect(screen.getByTestId("spec-edge-discovery-delivery").getAttribute("data-is-loop-back")).toBe("false");
    expect(screen.getByTestId("spec-edge-qa-discovery").getAttribute("data-is-loop-back")).toBe("true");
    // Per-rig listing still rendering alongside.
    expect(screen.getByTestId("topology-rig-listing")).toBeDefined();
    expect(screen.getByTestId("topology-rig-demo")).toBeDefined();
  });

  it("renders a derived runtime graph when unbound but affected seats are present", async () => {
    render(makeRouter(topologyShape(null)));
    await waitFor(() => expect(screen.getByTestId("topology-rig-demo")).toBeDefined());
    expect(screen.getByTestId("topology-spec-graph").getAttribute("data-spec-name")).toBe("runtime-handoff-map");
    expect(screen.getByTestId("spec-node-demo")).toBeDefined();
  });

  it("v1 carve-out: every spec edge carries data-routing-type='direct' (Phase D has no routing_type field yet)", async () => {
    const sg: SpecGraphPayload = {
      specName: "test-loop",
      specVersion: "1",
      nodes: [
        { stepId: "a", label: "a", role: "a", preferredTarget: null, isEntry: true, isCurrent: false, isTerminal: false },
        { stepId: "b", label: "b", role: "b", preferredTarget: null, isEntry: false, isCurrent: false, isTerminal: true },
      ],
      edges: [{ fromStepId: "a", toStepId: "b", routingType: "direct", isLoopBack: false }],
    };
    render(makeRouter(topologyShape(sg, false)));
    await waitFor(() => expect(screen.getByTestId("spec-edge-a-b")).toBeDefined());
    const edge = screen.getByTestId("spec-edge-a-b");
    expect(edge.getAttribute("data-routing-type")).toBe("direct");
    expect(screen.getByTestId("spec-node-b-terminal-badge")).toBeDefined();
    expect(screen.getByRole("img", { name: "Terminal" })).toBeDefined();
  });

  it("renders empty state only when BOTH specGraph is null AND no rigs are present", async () => {
    render(makeRouter({ affectedRigs: [], totalSeats: 0, specGraph: null }));
    await waitFor(() => expect(screen.getByTestId("topology-empty")).toBeDefined());
  });
});
