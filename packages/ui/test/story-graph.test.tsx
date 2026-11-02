import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import storyGraphCss from "../src/components/project/StoryGraph.css?raw";
import { StoryGraph } from "../src/components/project/StoryGraph.js";
import { QueueItemViewer } from "../src/components/drawer-viewers/QueueItemViewer.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { buildStoryForest, type StoryQitemInput } from "../src/lib/story-graph-model.js";

afterEach(cleanup);

function qitem(p: Partial<StoryQitemInput> & { qitemId: string }): StoryQitemInput {
  return {
    tsCreated: "2026-06-23T02:00:00.000Z",
    tsUpdated: "2026-06-23T02:00:00.000Z",
    sourceSession: "dev1-planner@openrig-delivery",
    destinationSession: "dev1-driver@openrig-delivery",
    state: "done",
    closureReason: "no-follow-on",
    tags: [],
    body: "agent-speak body\nmore detail",
    summary: null,
    chainOfRecord: null,
    handedOffFrom: null,
    handedOffTo: null,
    ...p,
  };
}

describe("StoryGraph", () => {
  it("renders the empty state when there are no nodes", () => {
    const { getByTestId } = render(<StoryGraph forest={buildStoryForest([])} />);
    expect(getByTestId("story-graph-empty")).toBeTruthy();
  });

  it("renders one clean row per node with the real state and a calendar date (not time-only)", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "root", chainOfRecord: null, body: "Mission kickoff (origin)" }),
      qitem({
        qitemId: "child",
        chainOfRecord: ["root"],
        state: "in-progress",
        body: "Building the harness",
        tsCreated: "2026-06-23T03:00:00.000Z",
      }),
    ]);
    const { getByTestId } = render(<StoryGraph forest={forest} />);
    const rootRow = getByTestId("story-row-root");
    const childRow = getByTestId("story-row-child");
    expect(within(rootRow).getByText("Mission kickoff (origin)")).toBeTruthy();
    // real qitem state, never an invented "merged" data state
    expect(within(childRow).getByText("In progress")).toBeTruthy();
    // date cell shows the calendar date (month + day) + time, never a
    // time-only / relative "Today"/"Yesterday" label (tz-robust shape check)
    for (const part of new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).formatToParts(new Date("2026-06-23T02:00:00.000Z"))) {
      if (part.type === "month" || part.type === "day") expect(rootRow.textContent).toContain(part.value);
    }
    expect(rootRow.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(rootRow.textContent).not.toMatch(/today|yesterday/i);
  });

  it("marks the human-origin lane and expands a row into the full-width bands + drawer link", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "spine", chainOfRecord: null, sourceSession: "orch-advisor@openrig-delivery" }),
      qitem({
        qitemId: "human",
        chainOfRecord: null,
        sourceSession: "founder",
        destinationSession: "dev2-driver@openrig-delivery",
        tags: ["human-origin", "terminal-fix"],
        body: "Founder routed a terminal fix to dev2.",
        tsCreated: "2026-06-23T04:00:00.000Z",
      }),
    ]);
    const { getByTestId, queryByTestId } = render(<StoryGraph forest={forest} />);

    // human-origin row carries the lane styling
    const humanRow = getByTestId("story-row-human").closest(".sg-trow");
    expect(humanRow?.className).toContain("sg-human");

    // collapsed: no detail panel yet
    expect(queryByTestId("story-detail-human")).toBeNull();

    // expand -> full-width bands (lineage "◆ this") + the Tier-3 drawer link
    fireEvent.click(getByTestId("story-row-human"));
    const detail = getByTestId("story-detail-human");
    expect(within(detail).getByText("◆ this")).toBeTruthy();
    expect(getByTestId("story-open-human")).toBeTruthy();
    expect(within(detail).getByText("human-origin")).toBeTruthy();
  });

  // Guard B3 — Tier-2 artifacts must be OPEN affordances where viewable, not inert text.
  it("renders a viewable (absolute-path) artifact as an open affordance; relative refs stay inert", () => {
    const forest = buildStoryForest([
      qitem({
        qitemId: "art",
        chainOfRecord: null,
        body: "shipped /Users/x/proof.png alongside packages/ui/rel.ts",
      }),
    ]);
    const { getByTestId, queryByTestId } = render(<StoryGraph forest={forest} />);
    fireEvent.click(getByTestId("story-row-art"));
    // absolute path -> clickable FileLink open trigger
    expect(getByTestId("story-artifact-/Users/x/proof.png")).toBeTruthy();
    // repo-relative path -> inert (no open trigger)
    expect(queryByTestId("story-artifact-packages/ui/rel.ts")).toBeNull();
  });

  it.each(["C:\\work\\proof.png", "\\\\host\\share\\proof.png", "C:\\工作 目录\\proof.png", "/books/with spaces/proof.png"])("opens the exact native artifact path %s", artifact => {
    const setSelection = vi.fn();
    const reference = artifact.includes(" ") ? `"${artifact}"` : artifact;
    const forest = buildStoryForest([qitem({ qitemId: "native-art", body: `Created ${reference} alongside C:relative.md and https://example.invalid/proof.png` })]);
    const { getByTestId, queryByTestId } = render(<DrawerSelectionContext.Provider value={{ selection: null, setSelection }}><StoryGraph forest={forest} /></DrawerSelectionContext.Provider>);
    fireEvent.click(getByTestId("story-row-native-art"));
    fireEvent.click(getByTestId(`story-artifact-${artifact}`));
    expect(setSelection).toHaveBeenCalledWith({ type: "file", data: { path: artifact, absolutePath: artifact } });
    expect(queryByTestId("story-artifact-C:relative.md")).toBeNull();
    expect(queryByTestId("story-artifact-https://example.invalid/proof.png")).toBeNull();
  });

  // Guard B2 (round 2) — through the DRAWER PATH: "Open full queue item" must carry
  // the full detail (chain + the omitted non-row fields claimedAt/targetRepo + fullDetail).
  it("Open full queue item carries the full detail into the drawer selection", () => {
    const setSelection = vi.fn();
    const forest = buildStoryForest([
      qitem({
        qitemId: "full",
        chainOfRecord: ["root-q"],
        claimedAt: "2026-06-23T02:30:00.000Z",
        targetRepo: "openrig",
        body: "agent-speak body",
      }),
    ]);
    const { getByTestId } = render(
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        <StoryGraph forest={forest} />
      </DrawerSelectionContext.Provider>,
    );
    fireEvent.click(getByTestId("story-row-full"));
    fireEvent.click(getByTestId("story-open-full"));
    expect(setSelection).toHaveBeenCalledTimes(1);
    const arg = setSelection.mock.calls[0]![0] as { type: string; data: Record<string, unknown> };
    expect(arg.type).toBe("qitem");
    expect(arg.data.fullDetail).toBe(true);
    expect(arg.data.chain).toContain("root-q");
    expect(arg.data.claimedAt).toBe("2026-06-23T02:30:00.000Z");
    expect(arg.data.targetRepo).toBe("openrig");
  });
});

// Guard B2 — Tier-3 drawer must render the FULL queue-item detail: all fields + full chain.
describe("Story Tier-3 drawer (QueueItemViewer full detail)", () => {
  it("renders all fields + the full chain, with labeled empty-states for nulls", () => {
    const { getByTestId } = render(
      <QueueItemViewer
        qitemId="qitem-Z"
        source="dev1-driver@openrig-delivery"
        destination="dev1-guard@openrig-delivery"
        state="handed-off"
        tags={["slice-19"]}
        createdAt="2026-06-23T02:00:00.000Z"
        updatedAt="2026-06-23T03:00:00.000Z"
        priority="urgent"
        tier="fast"
        closureReason="handed_off_to"
        closureTarget="dev1-guard@openrig-delivery"
        handedOffFrom="qitem-Y"
        targetRepo="openrig"
        chain={["qitem-W", "qitem-Y"]}
        body="full agent-speak body"
        fullDetail
      />,
    );
    expect(getByTestId("qitem-priority").textContent).toContain("urgent");
    expect(getByTestId("qitem-closure").textContent).toContain("handed_off_to");
    expect(getByTestId("qitem-targetrepo").textContent).toContain("openrig");
    const chain = getByTestId("qitem-chain");
    expect(chain.textContent).toContain("qitem-W");
    expect(chain.textContent).toContain("qitem-Y");
    // a null field is shown LABELED-EMPTY ("—"), not hidden, in the full-item view
    expect(getByTestId("qitem-claimed").textContent).toBe("—");
  });
});

// QA layout blocker (round) — the Tier-2 expanded detail must be a FULL-WIDTH band,
// not auto-placed into a grid column. jsdom can't measure layout, so this is a
// source/CSS guard (guard-accepted): the row must be a block container (the topline
// owns the 5-column grid), never a multi-column grid that auto-places the detail.
describe("StoryGraph expanded-detail layout contract (CSS guard)", () => {
  const css = storyGraphCss;
  it(".sg-trow is a block container, not a multi-column grid", () => {
    expect(/\.sg-trow\s*\{[^}]*display:\s*block/.test(css)).toBe(true);
    expect(/\.sg-trow\s*\{[^}]*display:\s*grid/.test(css)).toBe(false);
  });
  it(".sg-topline keeps the 5-column grid (so row cells still lay out across full width)", () => {
    expect(/\.sg-topline\s*\{[^}]*display:\s*grid/.test(css)).toBe(true);
    expect(/\.sg-topline\s*\{[^}]*grid-template-columns:\s*1fr 132px 96px 104px 132px/.test(css)).toBe(true);
  });
});
