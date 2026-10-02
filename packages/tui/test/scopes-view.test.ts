// SCOPES VIEW (plan d64d2f5c) — render pins per the v4 mock contract + the data-path rule.
import { describe, it, expect } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { parseCommand } from "../src/grammar.js";
import { proofBadge, scopeContractLines } from "../src/scopes/scopes-model.js";

function openGateway() {
  const snap = demoSnapshot();
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch(parseCommand(":scopes"));
  view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.2" });
  view.dispatch({ type: "scopes-open", mission: "release-0.5.2", slice: "gateway-m1" });
  return { snap, view };
}

describe("scopes view (store-direct render, v4 mock contract)", () => {
  it("explorer: selecting a mission atomically opens it and reveals its slices", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.2" });
    expect(view.get().scopesMission).toBe("release-0.5.2");
    expect(view.get().expanded).toContain("scopes-mission:release-0.5.2");
    const labels = computeExplorerRows(view.get(), snap).map((r) => r.label);
    expect(labels.some((l) => l.includes("release-0.5.2"))).toBe(true);
    expect(labels.some((l) => l.includes("● gateway-m1"))).toBe(true);
    expect(labels.some((l) => l.includes("✓ crash-cart"))).toBe(true);
  });

  it("never renders a prior mission's execution data under the newly selected mission heading", () => {
    const snap = {
      ...demoSnapshot(),
      executionMission: "older-release",
      execution: { view: "execution" as const, mission: "older-release", sources: {}, q1_lanes: [], q2_sequencing: [], q4_ladder: [], q5_park: [] },
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.2" });
    const out = renderScreen(view.get(), snap, { cols: 160, rows: 40 }).lines.join("\n");
    expect(out).toContain("release-0.5.2 EXECUTION");
    expect(out).toContain("read pending");
    expect(out).not.toContain("older-release");
  });

  it("detail renders a compact identity/state header and separated Intent, Requirements, and Proof regions", () => {
    const { snap, view } = openGateway();
    const out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("● gateway-m1 · OPR.0.5.2.9 · release-0.5.2");
    expect(out).toContain("STATE building · PROOF 2/9 · LOCKS spec locked · delivery open");
    expect(out).toContain("── INTENT ");
    expect(out).toContain("Slack to the founder");
    expect(out).toContain("── REQUIREMENTS (2)");
    expect(out).toContain("── PROOF · 2/9 paired");
    expect(out).toMatch(/STATE\s+#\s+REQUIREMENT\s+EVIDENCE/);
    expect(out).toMatch(/PAIRED\s+1\s+The ack-after-delivery repair/);
    expect(out).toMatch(/OPEN\s+2\s+A registered entity/);
    expect(out).toContain("↳ QA PASS");
    expect(out).toContain("qa-relay.md");
    expect(out).toContain("media relay-repair-e2e.txt");
  });

  it("the founder lock-glyph form: 🔒 renders ONLY when delivery-locked; the count carries the honesty", () => {
    const snap = demoSnapshot();
    const cc = snap.scopes![0]!.slices.find((s) => s.dirName === "crash-cart")!;
    expect(proofBadge(cc)).toBe("proof: 4/4 paired 🔒");
    const gm = snap.scopes![0]!.slices.find((s) => s.dirName === "gateway-m1")!;
    expect(proofBadge(gm)).toBe("proof: 2/9 paired"); // no del token, no unproven suffix — the count speaks
  });

  it("m collapses mini-requirements; n shows PROGRESS.md as narrative DISPLAY (never feeding counts)", () => {
    const { snap, view } = openGateway();
    view.dispatch(parseCommand("reqs"));
    let out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("collapsed · m expands");
    view.dispatch(parseCommand("narrative"));
    out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("PROGRESS · narrative only · n closes");
    expect(out).toContain("A2 held on arch consult");
    // the data-path rule: the narrative panel does NOT change the store-derived counts
    expect(out).toContain("PROOF 2/9");
  });
});


it.each([60, 160])("joins scope states and evidence by ID at width %i, not position", (width) => {
  const detail = demoSnapshot().scopes![0]!.slices[0]!;
  detail.proofContract = [
    { id: "b", index: 1, text: "Second item", paired: false, drops: [] },
    { id: "a", index: 2, text: "First item", paired: false, drops: [] },
    { id: "missing", index: 3, text: "Unknown item", paired: false, drops: [] },
  ];
  detail.readiness = { configured: true, state: "not-ready", revision: "basis", items: [
    { id: "a", index: 1, text: "First item", state: "rejected", reason: "Only A rejected", judgment: { id: "a-receipt" } },
    { id: "b", index: 2, text: "Second item", state: "accepted", reason: "Only B accepted", judgment: { id: "b-receipt" } },
  ] };
  const render = scopeContractLines(detail, { collapseReqs: false, narrative: null, width }).map(l => l.text).join("\n");
  const b = render.indexOf("Second item"), a = render.indexOf("First item"), missing = render.indexOf("Unknown item");
  expect(render).toMatch(width === 60 ? /REQ 1 · ACCEPTED/ : /ACCEPTED\s+1\s+Second item/);
  expect(render).toMatch(width === 60 ? /REQ 2 · REJECTED/ : /REJECTED\s+2\s+First item/);
  expect(render.slice(b, a)).toContain("Only B accepted");
  expect(render.slice(a, missing)).toContain("Only A rejected");
  expect(render).toContain("UNKNOWN");
});


it.each([60, 100])("separates current judgment evidence from every retained round at width %i", (width) => {
  const detail = demoSnapshot().scopes![0]!.slices[0]!;
  const sha = "0123456789abcdef".repeat(4);
  detail.proofContract = [{ id: "proof-a", index: 1, text: "Useful artifact", paired: true, drops: [
    { file: "proof/old-a.md", artifactType: "review", verdict: "BLOCKING", media: ["old-output.txt"] },
    { file: "proof/old-b.md", artifactType: "review", verdict: "CONCERNING", media: [] },
    { file: "proof/current-c.md", artifactType: "review", verdict: "CLEAR", media: [] },
    { file: "proof/new-uncited-d.md", artifactType: "review", verdict: "BLOCKING", media: [] },
  ] }];
  detail.readiness = { configured: true, state: "ready", revision: "basis", items: [{
    id: "proof-a", index: 1, text: "Useful artifact", state: "accepted", reason: "Explicit correction accepted",
    judgment: { id: "current-judgment", previous: "old-judgment", subject: { kind: "commit", ref: "new-candidate" },
      evidence: [{ ref: "proof/current-c.md", sha256: sha }] },
  }] };
  const render = () => scopeContractLines(detail, { collapseReqs: false, narrative: false, width }).map(l => l.text).join("\n").replace(/\s/g, "");
  const before = JSON.stringify(detail);
  const body = render();
  const parts = body.split("Retainedproofdrops—allrounds");
  expect(parts).toHaveLength(2);
  expect(parts[0]).toContain("Currentjudgment");
  expect(parts[0]).toContain("proof/current-c.md");
  expect(parts[0]).toContain(sha);
  expect(parts[0]).toContain("Corrects:old-judgment");
  expect(parts[0]).not.toMatch(/BLOCKING|CONCERNING|old-a.md|new-uncited/);
  for (const drop of detail.proofContract[0]!.drops) expect(parts[1]).toContain(drop.file);
  expect(parts[1]).toContain("old-output.txt");
  expect(JSON.stringify(detail)).toBe(before);
  detail.readiness.items[0]!.judgment!.previous = null;
  expect(render()).not.toContain("Corrects:");
  expect(render()).toContain("ACCEPTED");
});

it.each([60, 100])("does not promote retained drops when current evidence was not served at width %i", (width) => {
  const detail = demoSnapshot().scopes![0]!.slices[0]!;
  detail.proofContract = [{ id: "a", index: 1, text: "Artifact", paired: true, drops: [
    { file: "proof/legacy.md", artifactType: "qa", verdict: "CLEAR", media: [] },
  ] }];
  detail.readiness = { configured: true, state: "ready", revision: "basis", items: [{
    id: "a", index: 1, text: "Artifact", state: "accepted", reason: "accepted", judgment: { id: "receipt" },
  }] };
  const body = scopeContractLines(detail, { collapseReqs: false, narrative: false, width }).map(l => l.text).join("\n").replace(/\s/g, "");
  const [current, history] = body.split("Retainedproofdrops—allrounds");
  expect(current).toContain("Evidencereferencesnotserved");
  expect(current).not.toContain("proof/legacy.md");
  expect(history).toContain("proof/legacy.md");
});
