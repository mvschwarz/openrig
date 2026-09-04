import { describe, expect, it } from "vitest";
import { executionContentLines } from "../src/execution/execution-model.js";
import { scopesContentLines, type SliceScopeSnap } from "../src/scopes/scopes-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { createInputDecoder, resolveEscapeAction } from "../src/input.js";
import { parseCommand } from "../src/grammar.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";
import { explorerWidth } from "../src/visual-layout.js";
import type { Action, FleetSnapshot } from "../src/types.js";

type SemanticLine = { text: string; action?: Action; segs?: Array<{ text: string; token?: string }> };

function missionSnapshot(count = 14): FleetSnapshot {
  const base = demoSnapshot();
  const scopeTemplate = base.scopes![0]!.slices[0]!;
  const ids = Array.from({ length: count }, (_, i) => `OPR.0.5.9.${i + 1}`);
  const slices = ids.map((id, i) => ({
    ...scopeTemplate,
    id,
    dirName: `${String(i + 1).padStart(2, "0")}-slice-${i + 1}`,
    displayName: `Slice ${String(i + 1).padStart(2, "0")} — A deliberately descriptive terminal-native change ${i + 1}`,
    status: i < 4 ? "done" : "active",
    proof: { paired: i < 4 ? 4 : 1, total: 4 },
  }));
  const q1 = ids.slice(0, 2).map((slice, i) => ({
    qitem_id: `qitem-${i + 1}`,
    slice,
    seat: `dev-${i + 1}@rig`,
    activity: {
      activity: i === 0 ? "working" : "idle-at-prompt",
      needs_input: { count: i === 1 ? 1 : 0, reason: i === 1 ? "founder choice" : null },
      decided_by: "activity oracle",
      changed_at: "2026-09-03T21:58:00.000Z",
    },
    pickup: { state: i === 0 ? "working" : "parked" },
  }));
  return {
    ...base,
    scopes: [{ mission: "release-0.5.9", slices }],
    executionMission: "release-0.5.9",
    execution: {
      view: "execution",
      mission: "release-0.5.9",
      derived_at: "2026-09-03T22:00:00.000Z",
      sources: {
        git: { basis: "no reachable repo context" },
        build_info: { commit: "5f7bc3c2cc79fe1d2e4bd6f15df32d037bab50dc" },
      },
      q1_lanes: q1,
      q2_sequencing: ids.map((slice, i) => ({
        slice_id: slice,
        dir: slices[i]!.dirName,
        depends_on: [],
        blocked_on_rows: [],
        next_up: i === 2,
        source: { spec_path: `/work/${slice}/SPEC.md`, arrangement_path: "/work/mission.yaml" },
      })),
      q3_care: ids.map((slice) => ({ slice_id: slice, build_wave: "production-system" })),
      q4_ladder: ids.map((slice, i) => ({
        slice_id: slice,
        dir: slices[i]!.dirName,
        locked: { value: true, basis: "plan lock" },
        built: i < 4 ? { candidate_sha: `candidate${i}`, basis: "candidate row" } : { candidate_sha: "INDETERMINATE", basis: "no candidate row" },
        reviewed: i < 4 ? { value: true, basis: "review receipt" } : { value: "INDETERMINATE", basis: "no reachable repo context" },
        folded: i < 4 ? { value: true, basis: "git" } : { value: "INDETERMINATE", basis: "no reachable repo context" },
        adopted: { value: false, basis: "daemon differs" },
      })),
      q5_park: [{ qitem_id: "qitem-2", pickup_state: "parked", age_minutes: 4 }],
    },
    hydratedAt: "2026-09-03T22:00:01.000Z",
  };
}

function openMission(snap: FleetSnapshot) {
  const view = createViewState({ instanceId: "live-qa", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "scopes" });
  view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.9" });
  return view;
}

function tokens(lines: SemanticLine[]): Set<string> {
  return new Set(lines.flatMap((line) => line.segs ?? []).flatMap((seg) => seg.token ? [seg.token] : []));
}

function expectTokens(lines: SemanticLine[], expected: string[]): void {
  const found = tokens(lines);
  for (const token of expected) expect(found.has(token), `semantic token ${token}`).toBe(true);
}

function hitAt(screen: ReturnType<typeof renderScreen>, x: number, y: number) {
  return screen.hitMap.find((hit) => hit.y === y && x >= hit.x1 && x <= hit.x2);
}

describe("founder live-QA correction — mission dashboard", () => {
  it("puts identity/state first, keeps the wave dominant, and paints semantic facts", () => {
    const snap = missionSnapshot();
    for (const cols of [160, 120, 84]) {
      const width = cols - explorerWidth(cols) - 2;
      const lines = executionContentLines(snap.execution, snap.scopes, [], null, width) as SemanticLine[];
      const body = lines.map((line) => line.text).join("\n");
      const mission = lines.findIndex((line) => line.text.includes("release-0.5.9") && /ATTENTION|ACTIVE|COMPLETE/.test(line.text));
      const now = lines.findIndex((line) => /\bNOW\b/.test(line.text));
      const next = lines.findIndex((line) => /\bNEXT\b/.test(line.text));
      const progress = lines.findIndex((line) => /\bPROGRESS\b/.test(line.text));
      const attention = lines.findIndex((line) => line.text.includes("NEEDS HUMAN"));
      const wave = lines.findIndex((line) => line.text.includes("WAVE production-system"));
      expect(mission, `${cols}: identity/state`).toBe(0);
      expect(now, `${cols}: NOW follows identity`).toBeGreaterThan(mission);
      expect(next, `${cols}: NEXT follows NOW`).toBeGreaterThan(now);
      expect(progress, `${cols}: PROGRESS follows NEXT`).toBeGreaterThan(next);
      expect(attention, `${cols}: conditional attention`).toBeGreaterThan(progress);
      expect(lines[attention]!.action).toEqual({ type: "execution-open", key: "slice:OPR.0.5.9.2" });
      expect(wave, `${cols}: wave begins promptly`).toBeLessThan(cols === 84 ? 14 : 10);
      expect(body).not.toContain("declared in slice files");
      expect(body).not.toContain("live now:");
      if (cols === 84) expect(body).toContain("provenance · evidence gap");
      expectTokens(lines, ["accentBright", "bright", "ok", "warn", "dim", "chrome"]);
      expect(lines.every((line) => line.text.length <= width), `${cols}: no content overflow`).toBe(true);
    }
  });

  it("includes every slice at every target geometry and reaches later work by scrolling", () => {
    const snap = missionSnapshot();
    for (const { cols, rows } of [{ cols: 160, rows: 42 }, { cols: 120, rows: 34 }, { cols: 84, rows: 28 }]) {
      const width = cols - explorerWidth(cols) - 2;
      const content = executionContentLines(snap.execution, snap.scopes, [], null, width);
      const body = content.map((line) => line.text).join("\n");
      const sliceTargets = new Set(content.flatMap((line) => [line.action, ...(line.zones ?? []).map((zone) => zone.action)])
        .filter((action): action is Extract<Action, { type: "execution-open" }> => action?.type === "execution-open")
        .map((action) => action.key)
        .filter((key) => key.startsWith("slice:")));
      expect(sliceTargets.size, `${cols}: every slice selectable`).toBe(14);
      expect(body).not.toMatch(/\+\d+ more|\d+ below|open all \d+ rows/);

      const view = openMission(snap);
      let screen = renderScreen(view.get(), snap, { cols, rows });
      expect(screen.contentMaxOffset, `${cols}: long mission scrolls`).toBeGreaterThan(0);
      view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
      view.dispatch({ type: "content-scroll", delta: screen.contentMaxOffset });
      screen = renderScreen(view.get(), snap, { cols, rows });
      expect(screen.lines.join("\n"), `${cols}: last slice reachable`).toContain("OPR.0.5.9.14");
      const styled = stylizeLines(screen, createStyle("truecolor"));
      styled.forEach((line, i) => expect(stripAnsi(line), `${cols}: strip line ${i}`).toBe(screen.lines[i]));
      expect(stylizeLines(screen, createStyle("none"))).toEqual(screen.lines);
    }
  });
});

describe("founder live-QA correction — truthful explorer disclosures", () => {
  it("gives the disclosure cell precedence while the row label keeps its drill action", () => {
      const snap = missionSnapshot();
      for (const pulse of [false, true]) {
        const view = createViewState({ instanceId: `disclosure-${pulse}`, getSnapshot: () => snap });
      view.dispatch({ type: "jump", section: "scopes" });
      if (pulse) view.dispatch({ type: "tab", tab: "pulse" });
      let screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
      const rowIndex = screen.lines.findIndex((line) => line.slice(0, screen.explorerWidth).includes("release-0.5.9"));
      const line = screen.lines[rowIndex]!;
      const glyphX = line.indexOf("›") + 1;
      const labelX = line.indexOf("release-0.5.9") + 1;
      expect(hitAt(screen, glyphX, rowIndex + 1)?.action, `${pulse}: glyph`).toEqual({ type: "toggle-expand", key: "scopes-mission:release-0.5.9" });
      expect(hitAt(screen, labelX, rowIndex + 1)?.action, `${pulse}: label`).toEqual({ type: "scopes-mission-open", mission: "release-0.5.9" });
      view.dispatch(hitAt(screen, glyphX, rowIndex + 1)!.action);
      expect(view.get().scopesMission, `${pulse}: glyph preserves content selection`).toBeNull();
      expect(view.get().expanded).toContain("scopes-mission:release-0.5.9");
      screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
      expect(screen.lines.join("\n")).toContain("01-slice-1");
      const openRow = screen.explorerRows.find((row) => row.key === "scopes-mission:release-0.5.9")!;
      view.dispatch(openRow.disclosureAction!);
      expect(view.get().expanded).not.toContain("scopes-mission:release-0.5.9");
      expect(view.get().scopesMission, `${pulse}: closing disclosure preserves content selection`).toBeNull();
      view.dispatch(openRow.action);
      expect(view.get().scopesMission).toBe("release-0.5.9");
      expect(view.get().expanded).toContain("scopes-mission:release-0.5.9");
    }
  });

  it("renders disclosure glyphs only on rows with a real toggle", () => {
    const snap = missionSnapshot();
    const view = createViewState({ instanceId: "truthful", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    const topology = screen.lines.find((line) => line.slice(0, screen.explorerWidth).includes("TOPOLOGY"))!;
    expect(topology.slice(0, screen.explorerWidth)).not.toMatch(/[⌄›]/);
    for (const row of screen.explorerRows) {
      const text = screen.lines[row.y - 1]!.slice(0, screen.explorerWidth);
      if (/[⌄›]/.test(text)) expect(row.disclosureAction, row.key).toEqual(expect.objectContaining({ type: "toggle-expand" }));
    }
  });

  it("keeps a pod label as the right-panel drill while its glyph only expands the pod", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "pod-disclosure", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    const rowIndex = screen.lines.findIndex((line) => line.slice(0, screen.explorerWidth).includes("dev50"));
    const line = screen.lines[rowIndex]!;
    const glyph = hitAt(screen, line.indexOf("›") + 1, rowIndex + 1)!;
    const label = hitAt(screen, line.indexOf("dev50") + 1, rowIndex + 1)!;
    expect(glyph.action).toEqual({ type: "toggle-expand", key: "pod:vm-host/openrig-build/dev50" });
    expect(label.action).toEqual({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    view.dispatch(glyph.action);
    expect(view.get().expanded).toContain("pod:vm-host/openrig-build/dev50");
    expect(view.get().drill).toEqual([]);
  });
});

function agentZoomSnapshot(): FleetSnapshot {
  const snap = demoSnapshot();
  const guard = snap.hosts[0]!.rigs[0]!.pods[0]!.agents.find((agent) => agent.name === "dev50.guard")!;
  Object.assign(guard, {
    context: 69,
    contextWindowSize: 258400,
    totalInputTokens: 176458,
    totalOutputTokens: 930,
    hasAssignedWork: true,
    assignedWorkCount: 3,
    pendingWorkCount: 1,
    inProgressWorkCount: 1,
    blockedWorkCount: 1,
    activity: {
      activity: "needs-input",
      needsInput: { count: 1, reason: "founder must choose the exact terminal action" },
      decidedBy: "activity-oracle",
      signalReason: "permission_prompt",
      signalSource: "runtime_hook",
      eventAt: "2026-09-03T22:20:25.862Z",
    },
  });
  snap.inProgress = [{
    qitemId: "qitem-current-agent-zoom-abcdef", state: "in-progress", destinationSession: guard.session!, blockedOn: null,
    handedOffTo: null, tier: "deep", tags: ["slice:OPR.0.5.9.11"], summary: "Build the operational agent zoom", body: "",
    claimedAt: "2026-09-03T22:00:00.000Z", tsUpdated: "2026-09-03T22:20:00.000Z",
  }];
  snap.blocked = [{
    qitemId: "qitem-blocked-agent-zoom-fedcba", state: "blocked", destinationSession: guard.session!, blockedOn: "qitem-upstream-runtime-slot",
    blockerSession: "review-r2@openrig-build", handedOffTo: null, tier: "deep", tags: ["slice:OPR.0.5.9.11"],
    summary: "Waiting for the exact runtime slot verdict", body: "", claimedAt: "2026-09-03T21:00:00.000Z", tsUpdated: "2026-09-03T22:10:00.000Z",
  }];
  snap.pending = [{
    qitemId: "qitem-next-agent-zoom-123456", state: "pending", destinationSession: guard.session!, blockedOn: null,
    handedOffTo: null, tier: "routine", tags: ["slice:OPR.0.5.9.12"], summary: "Run the next focused terminal proof", body: "",
    claimedAt: null, tsUpdated: "2026-09-03T22:15:00.000Z",
  }];
  snap.needs = [{
    source: "agent", kind: "human-routed", target: guard.session!, detail: "Founder must choose the exact terminal action",
    hostId: "vm-host", qitemId: "qitem-blocked-agent-zoom-fedcba", evidenceRef: "proof/founder-live-qa.md", unblocks: "qitem-current-agent-zoom-abcdef",
  }];
  snap.recentlyFinished = [{
    qitemId: "qitem-recent-agent-zoom-654321", state: "done", destinationSession: guard.session!, blockedOn: null,
    handedOffTo: null, tier: "routine", tags: null, summary: "Previous terminal proof cleared", body: "",
    claimedAt: "2026-09-03T20:00:00.000Z", tsUpdated: "2026-09-03T20:30:00.000Z",
  }];
  return snap;
}

function openAgent(snap: FleetSnapshot) {
  const view = createViewState({ instanceId: "agent-zoom", getSnapshot: () => snap });
  view.dispatch({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
  return view;
}

describe("founder live-QA correction — operational agent zoom", () => {
  it("shows detailed context, activity, exact current/next rows, queue depth, and the owning needs-you action", () => {
    for (const cols of [160, 120, 84]) {
      const snap = agentZoomSnapshot();
      const screen = renderScreen(openAgent(snap).get(), snap, { cols, rows: 160 });
      const body = screen.lines.map((line) => line.slice(screen.explorerWidth + 1)).join("\n");
      const compact = body.replace(/\s+/g, " ");
      expect(body).toContain("CONTEXT · 69%");
      expect(compact).toContain("176,458 input");
      expect(compact).toContain("930 output");
      expect(compact).toContain("258,400 window");
      expect(body).toContain("CURRENT ACTIVITY");
      expect(compact).toContain("needs-input");
      expect(compact.toLowerCase()).toContain("founder must choose the exact terminal action");
      expect(body).toContain("CURRENT WORK · 2");
      expect(compact).toContain("qitem-current-agent-zoom-abcdef");
      expect(compact).toContain("qitem-blocked-agent-zoom-fedcba");
      expect(compact).toContain("blocked on qitem-upstream-runtime-slot");
      expect(body).toContain("── QUEUE ");
      expect(compact).toContain("depth: 3 assigned");
      expect(compact).toContain("1 pending");
      if (cols === 160) expect(compact).toContain("1 in progress · 1 blocked");
      expect(body).toContain("UP NEXT · 1");
      expect(compact).toContain("qitem-next-agent-zoom-123456");
      expect(body).toContain("NEEDS YOU · 1");
      expect(compact).toContain("unblocks qitem-current-agent-zoom-abcdef");
      expect(body).toContain("RECENTLY FINISHED · bounded window");
      expect(compact).toContain("qitem-recent-agent-zoom-654321");
      screen.lines.forEach((line) => expect(stripAnsi(line).length).toBeLessThanOrEqual(cols));
    }
  });

  it("lands on the same operational zoom from a needs-you row", () => {
    const snap = agentZoomSnapshot();
    const view = createViewState({ instanceId: "needs-agent-zoom", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });
    let screen = renderScreen(view.get(), snap, { cols: 120, rows: 50 });
    const target = screen.contentTargets.find((item) => item.action.type === "drill" && item.action.resource === "agent");
    expect(target).toBeDefined();
    view.dispatch(target!.action);
    screen = renderScreen(view.get(), snap, { cols: 120, rows: 80 });
    expect(screen.lines.join("\n")).toContain("CONTEXT · 69%");
    expect(view.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.guard" });
  });
});

describe("founder live-QA correction — rig-wide RECENT rail", () => {
  function recentSnapshot(): FleetSnapshot {
    const snap = agentZoomSnapshot();
    snap.scopes = missionSnapshot().scopes;
    snap.recentTransitionsRig = "openrig-build";
    snap.recentTransitions = [
      { transitionId: 2, ts: "2026-09-03T22:02:00.000Z", actorSession: "dev-qa@openrig-build", change: "claimed", summary: "Recompose the production terminal dashboard without clipping its meaning", targetKind: "slice", target: "OPR.0.5.9.11", qitemId: "q-2" },
      { transitionId: 3, ts: "2026-09-03T22:03:00.000Z", actorSession: "review-r2@openrig-build", change: "completed", summary: "Independent review cleared", targetKind: "qitem", target: "q-3", qitemId: "q-3" },
    ];
    return snap;
  }

  it("renders a bounded chronological rail below the factory at every supported width", () => {
    const snap = recentSnapshot();
    for (const cols of [160, 120, 84]) {
      const view = createViewState({ instanceId: "recent", getSnapshot: () => snap });
      const screen = renderScreen(view.get(), snap, { cols, rows: 80 });
      const body = screen.lines.join("\n");
      expect(body).toContain("RECENT");
      if (cols === 160) expect(body).toMatch(/TIME\s+ACTOR\s+CHANGE\s+TARGET/);
      expect(body.indexOf("22:02")).toBeLessThan(body.indexOf("22:03"));
      expect(body).toContain("OPR.0.5.9.11");
      const content = screen.lines.map((line) => line.slice(screen.explorerWidth + 2)).join(" ").replace(/\s+/g, " ");
      expect(content).toContain("Recompose the production terminal dashboard without clipping its meaning");
      expect(body).not.toContain("next event");
      expect(screen.contentTargets.some((item) => item.action.type === "scopes-open" && item.action.slice === "11-slice-11")).toBe(true);
    }
  });

  it("states the honest empty window without inventing an event", () => {
    const snap = recentSnapshot();
    snap.recentTransitions = [];
    const view = createViewState({ instanceId: "recent-empty", getSnapshot: () => snap });
    const body = renderScreen(view.get(), snap, { cols: 160, rows: 80 }).lines.join("\n");
    expect(body).toContain("No recorded transitions in the current window.");
  });

  it("shortens canonical Claude model labels in the table only", () => {
    const snap = recentSnapshot();
    const driver = snap.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
    driver.model = "claude-fable-5.1";
    const view = createViewState({ instanceId: "model-label", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build", target: { host: "vm-host" } });
    const screen = renderScreen(view.get(), snap, { cols: 160, rows: 80 });
    expect(screen.lines.join("\n")).toContain("fable-5.1");
    expect(screen.lines.join("\n")).not.toContain("claude-fable-5.1");

    expect(driver.model).toBe("claude-fable-5.1");
  });
});

function longSlice(): SliceScopeSnap {
  const base = demoSnapshot().scopes![0]!.slices[0]!;
  return {
    ...base,
    intent: "Make the first terminal screen answer what this slice is for without forcing the operator to decode raw Markdown or clipped prose.",
    miniRequirements: [
      "At wide and medium widths, keep stable columns while continuation lines remain inside the requirement column instead of drifting under state.",
      "At eighty-four columns, stack labeled rows deliberately and keep every long word and proof relationship reachable through vertical scrolling.",
    ],
    proof: { paired: 2, total: 3 },
    proofContract: [
      {
        index: 1,
        paired: true,
        text: "The real terminal frame preserves semantic hierarchy at all three founder target geometries without horizontal overflow.",
        drops: [
          { file: "mission-160x42.ansi", artifactType: "qa", verdict: "PASS", media: ["mission-160x42.txt", "mission-120x34.txt"] },
          { file: "mission-84x28.ansi", artifactType: "guard", verdict: "CLEAR", media: ["mission-84x28.txt"] },
        ],
      },
      {
        index: 2,
        paired: false,
        text: "The clipboard selection is proven by a human paste/readback rather than inferred from entering copy mode.",
        drops: [],
      },
      {
        index: 3,
        paired: true,
        text: "Every proof drop remains visually subordinate to the exact requirement it proves and its full file identity remains reachable.",
        drops: [{ file: "focused-independent-review-receipt-with-a-long-name.md", artifactType: "rev1-r2", verdict: "CLEAR", media: [] }],
      },
    ],
  };
}

describe("founder live-QA correction — slice information architecture", () => {
  it("uses semantic regions and responsive proof rows instead of delimiter prose", () => {
    for (const cols of [160, 120, 84]) {
      const width = cols - explorerWidth(cols) - 2;
      const lines = scopesContentLines(longSlice(), "release-0.5.9", { collapseReqs: false, narrative: false, width }) as SemanticLine[];
      const body = lines.map((line) => line.text).join("\n");
      const intent = lines.findIndex((line) => line.text.includes("── INTENT "));
      const requirements = lines.findIndex((line) => line.text.includes("── REQUIREMENTS "));
      const proof = lines.findIndex((line) => line.text.includes("── PROOF ·"));
      expect(intent).toBeGreaterThan(0);
      expect(requirements).toBeGreaterThan(intent);
      expect(proof).toBeGreaterThan(requirements);
      expect(lines.every((line) => line.text.length <= width), `${cols}: no overflow`).toBe(true);
      expectTokens(lines, ["accentBright", "bright", "ok", "warn", "dim", "chrome"]);
      expect(body).not.toContain("C1 drop ·");
      expect(body).not.toMatch(/── .* ── .* ──/);
      if (cols > 84) {
        expect(body).toMatch(/STATE\s+#\s+REQUIREMENT\s+EVIDENCE/);
      } else {
        expect(body).toContain("REQ 1 · PROVED");
        expect(body).toContain("EVIDENCE");
      }
      expect(body).toContain("mission-84x28.ansi");
      const evidenceText = width >= 70
        ? lines.map((line) => line.text.slice(width - Math.max(20, Math.floor(width * 0.28))).trim()).join("")
        : body.replace(/\s+/g, "");
      expect(evidenceText).toContain("focused-independent-review-receipt-with-a-long-name.md");
    }
  });

  it("renders and scrolls the real slice page at 160x42, 120x34, and 84x28 with ANSI geometry intact", () => {
    for (const { cols, rows } of [{ cols: 160, rows: 42 }, { cols: 120, rows: 34 }, { cols: 84, rows: 28 }]) {
      const snap = missionSnapshot();
      const scope = { ...longSlice(), id: "OPR.0.5.9.1", dirName: "01-slice-1", displayName: "Slice 01 — canonical detail" };
      snap.scopes![0]!.slices[0] = scope;
      const view = openMission(snap);
      view.dispatch({ type: "scopes-open", mission: "release-0.5.9", slice: scope.dirName });
      let screen = renderScreen(view.get(), snap, { cols, rows });
      const seen = [screen.lines.join("\n")];
      expect(screen.lines.join("\n")).toContain("01-slice-1");
      expect(screen.lines.join("\n")).toMatch(/STATE\s+building/);
      expect(screen.lines.join("\n")).toMatch(/PROOF\s+2\/3/);
      expect(screen.lines.join("\n")).toContain("OWNERSHIP");
      expect(screen.lines.join("\n")).toContain("EVIDENCE · declared spec");
      const styled = stylizeLines(screen, createStyle("truecolor"));
      styled.forEach((line, i) => expect(stripAnsi(line), `${cols}: strip line ${i}`).toBe(screen.lines[i]));
      expect(stylizeLines(screen, createStyle("none"))).toEqual(screen.lines);
      if (screen.contentMaxOffset > 0) {
        view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
        const page = Math.max(1, Math.floor(rows / 2));
        while (view.get().contentOffset < screen.contentMaxOffset) {
          view.dispatch({ type: "content-scroll", delta: page });
          screen = renderScreen(view.get(), snap, { cols, rows });
          seen.push(screen.lines.join("\n"));
        }
      }
      const reachable = seen.join("\n");
      expect(reachable, `${cols}: operational ownership reachable`).toContain("OWNERSHIP");
      expect(reachable, `${cols}: authored intent reachable`).toContain("── INTENT ");
      expect(reachable, `${cols}: authored proof reachable`).toContain("── PROOF ·");
      expect(reachable, `${cols}: provenance reachable`).toContain("SOURCES");
      expect(reachable, `${cols}: evidence start reachable`).toContain("focused-independent");
      expect(reachable, `${cols}: evidence end reachable`).toContain("ame.md");
    }
  });

  it("uses one canonical complete slice destination from mission graph and Explorer", () => {
    const snap = missionSnapshot();
    const scope = { ...longSlice(), id: "OPR.0.5.9.1", dirName: "01-slice-1", displayName: "Slice 01 — canonical detail" };
    snap.scopes![0]!.slices[0] = scope;
    snap.sliceDetail = {
      name: scope.dirName,
      status: "active",
      rawStatus: "building",
      qitemIds: ["qitem-current-slice"],
      commitRefs: ["5f7bc3c2c"],
      lastActivityAt: "2026-09-03T22:20:25.862Z",
      story: { events: [
        { ts: "2026-09-03T22:20:25.862Z", kind: "transition.in-progress", actorSession: "dev-qa@v-openrig-build", qitemId: "qitem-current-slice", summary: "claimed", phase: null },
        { ts: "2026-09-03T22:21:00.000Z", kind: "transition.pending", actorSession: "review-r2@v-openrig-build", qitemId: "qitem-review", summary: "review queued", phase: null },
      ] },
      decisions: { rows: [{
        actionId: "decision-1", ts: "2026-09-03T22:19:00.000Z", actor: "orch-lead@v-openrig-build", verb: "resolve",
        qitemId: "qitem-current-slice", reason: "Founder selected the canonical terminal-native slice composition.",
      }] },
    };

    for (const cols of [160, 120, 84]) {
      const fromGraph = openMission(snap);
      fromGraph.dispatch({ type: "execution-open", key: "slice:OPR.0.5.9.1" });
      const graphScreen = renderScreen(fromGraph.get(), snap, { cols, rows: 220 });

      const fromExplorer = openMission(snap);
      fromExplorer.dispatch({ type: "scopes-open", mission: "release-0.5.9", slice: scope.dirName });
      const explorerScreen = renderScreen(fromExplorer.get(), snap, { cols, rows: 220 });
      const graphContent = graphScreen.lines.map((line) => line.slice(graphScreen.explorerWidth + 1)).join("\n");
      const explorerContent = explorerScreen.lines.map((line) => line.slice(explorerScreen.explorerWidth + 1)).join("\n");
      const compact = graphContent.replace(/\s+/g, " ");

      expect(explorerContent).toBe(graphContent);
      expect(graphContent).toContain("TOUCHED");
      expect(compact).toContain("review-r2@v-openrig-build");
      if (cols > 84) expect(compact).toContain("dev-qa@v-openrig-build");
      else expect(compact).toContain("2 served actors · latest 1 shown");
      expect(graphContent).toContain("RULING");
      expect(compact).toContain("Founder selected the canonical");
      expect(compact).toContain("terminal-native slice composition.");
      expect(graphContent).toContain("OWNERSHIP");
      expect(graphContent).toContain("EVIDENCE");
      expect(graphContent).toContain("NEEDS YOU");
      expect(graphContent).toContain("TYPED ROWS");
      expect(graphContent).toContain("DEPENDENCIES");
      expect(graphContent).toContain("── INTENT ");
      expect(graphContent).toContain("── REQUIREMENTS ");
      expect(graphContent).toContain("── PROOF ·");
      expect(graphContent).toContain("SOURCES");
      expect(graphContent.match(/── INTENT /g)).toHaveLength(1);
    }
  });
});

describe("founder live-QA correction — small filter lifecycle", () => {
  it("applies, replaces, cancels an edit without changing the applied value, then clears on bare Escape", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "filter-life", getSnapshot: () => snap });
    view.dispatch(parseCommand("/dev50"));
    expect(view.get().filter).toBe("dev50");
    view.dispatch(parseCommand("/guard"));
    expect(view.get().filter).toBe("guard");

    const decoder = createInputDecoder();
    decoder.write("\x1b");
    const escape = decoder.flush()[0] as Extract<ReturnType<typeof decoder.flush>[number], { type: "key" }>;
    expect(resolveEscapeAction(escape, view.get(), true), "Esc while /replacement is being typed only cancels that edit").toBeNull();
    expect(view.get().filter).toBe("guard");
    expect(resolveEscapeAction(escape, view.get(), false)).toEqual({ type: "filter", text: "" });
    view.dispatch(resolveEscapeAction(escape, view.get(), false)!);
    expect(view.get().filter).toBe("");
    expect(resolveEscapeAction(escape, view.get(), false), "unfiltered Escape keeps its prior meaning").toBeNull();
  });

  it("clears an applied filter before navigating back and tells the operator how to replace or clear it", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "filter-priority", getSnapshot: () => snap });
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.2" });
    view.dispatch({ type: "scopes-open", mission: "release-0.5.2", slice: "gateway-m1" });
    view.dispatch({ type: "filter", text: "gateway" });
    const decoder = createInputDecoder();
    decoder.write("\x1b");
    const escape = decoder.flush()[0] as Extract<ReturnType<typeof decoder.flush>[number], { type: "key" }>;
    expect(resolveEscapeAction(escape, view.get(), false)).toEqual({ type: "filter", text: "" });

    view.dispatch({ type: "jump", section: "topology" });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
    view.dispatch({ type: "filter", text: "dev50" });
    const topology = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    expect(topology.lines.join("\n")).toContain("/ filter agents: dev50 · / replace · esc clear");
    const agentLine = topology.lines.findIndex((line) => line.includes("driver"));
    const agentX = topology.lines[agentLine]!.indexOf("driver") + 1;
    expect(hitAt(topology, agentX, agentLine + 1)?.action).toEqual(expect.objectContaining({ type: "drill", resource: "agent" }));

    view.dispatch({ type: "jump", section: "specs" });
    view.dispatch({ type: "filter", text: "review" });
    const specs = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    expect(specs.lines.join("\n")).toContain("/ filter specs: review · / replace · esc clear");
  });
});
