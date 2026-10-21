// SCOPES VIEW (plan d64d2f5c) — render pins per the v4 mock contract + the data-path rule.
import { describe, it, expect } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { parseCommand } from "../src/grammar.js";
import { proofBadge, scopeContractLines, scopeIdentityLines } from "../src/scopes/scopes-model.js";

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
    expect(out).toContain("STATE building · PROOF 2/9 paired · LOCKS spec locked · delivery open");
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

  it("M collapses mini-requirements; N shows PROGRESS.md as narrative DISPLAY (never feeding counts)", () => {
    const { snap, view } = openGateway();
    view.dispatch(parseCommand("reqs"));
    let out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("collapsed · M expands");
    view.dispatch(parseCommand("narrative"));
    out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("PROGRESS · narrative only · N closes");
    expect(out).toContain("A2 held on arch consult");
    // the data-path rule: the narrative panel does NOT change the store-derived counts
    expect(out).toContain("PROOF 2/9 paired");
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

describe("scopes header proof count reads as acceptance only when judges are configured", () => {
  type Judged = "accepted" | "pending";
  const slice = (cited: boolean, judged: Judged[] | null) => {
    const detail = demoSnapshot().scopes![0]!.slices[0]!;
    detail.proofContract = (judged ?? ["pending", "pending", "pending"]).map((_, i) => (
      { id: `item-${i}`, index: i + 1, text: `Item ${i + 1}`, paired: cited, drops: [] }));
    detail.proof = { paired: cited ? detail.proofContract.length : 0, total: detail.proofContract.length };
    detail.readiness = judged
      ? { configured: true, policy: { judges: ["judge@scratch"] }, state: judged.every(s => s === "accepted") ? "ready" : "not-ready", revision: "basis",
        items: judged.map((state, i) => ({ id: `item-${i}`, index: i + 1, text: `Item ${i + 1}`, state, reason: state, judgment: null })) }
      : undefined;
    return detail;
  };
  // The segment carrying the proof count, in the wide header line and the narrow PROOF row.
  const proofSeg = (detail: ReturnType<typeof slice>, width: number) => {
    const lines = scopeIdentityLines(detail, "m", width);
    const segs = lines.flatMap(l => l.segs ?? []);
    const at = segs.findIndex(s => s.text.trim() === "PROOF");
    return { text: segs[at + 1]!.text, token: segs[at + 1]!.token };
  };

  it.each([60, 160])("shows 0/N accepted, not ok, when every item is cited but none is judged (width %i)", (width) => {
    expect(proofSeg(slice(true, ["pending", "pending", "pending"]), width)).toEqual({ text: "0/3 accepted", token: "warn" });
  });

  it.each([60, 160])("shows N/N accepted in ok when every item is accepted (width %i)", (width) => {
    expect(proofSeg(slice(true, ["accepted", "accepted", "accepted"]), width)).toEqual({ text: "3/3 accepted", token: "ok" });
  });

  it.each([60, 160])("shows partial acceptance in warn (width %i)", (width) => {
    expect(proofSeg(slice(true, ["accepted", "pending", "pending"]), width)).toEqual({ text: "1/3 accepted", token: "warn" });
  });

  // `configured` is also true for a judgments directory left after the policy was removed, and for a failed policy read.
  const withoutPolicy = (issues?: string[]) => {
    const detail = slice(true, ["pending", "pending", "pending"]);
    detail.readiness = { ...detail.readiness!, policy: null, ...(issues ? { issues, state: "unknown" } : {}) };
    return detail;
  };

  it.each([60, 160])("says n/m paired, ok, when only a judgments directory is left after the policy was removed (width %i)", (width) => {
    expect(proofSeg(withoutPolicy(), width)).toEqual({ text: "3/3 paired", token: "ok" });
  });

  it.each([60, 160])("keeps the paired count but never ok when the policy could not be read (width %i)", (width) => {
    expect(proofSeg(withoutPolicy(["proofPolicy.judges must name authorized actors"]), width)).toEqual({ text: "3/3 paired", token: "warn" });
  });

  it.each([60, 160])("falls back to paired, warn, when a present policy reports issues (width %i)", (width) => {
    const detail = slice(true, ["accepted", "accepted", "accepted"]);
    detail.readiness = { ...detail.readiness!, issues: ["No authored proof contract"], state: "unknown" };
    expect(proofSeg(detail, width)).toEqual({ text: "3/3 paired", token: "warn" });
  });

  // The header must never cut the lock state with an ellipsis: above the narrow layout it is one line only while it fits.
  const lockLines = (detail: ReturnType<typeof slice>, width: number) =>
    scopeIdentityLines(detail, "m", width).map(l => l.text).filter(t => /LOCKS/.test(t));

  it.each([73, 80])("keeps the whole lock state visible with judges configured at detail width %i", (width) => {
    const detail = slice(true, ["pending", "pending", "pending"]);
    detail.locks = { spec: { by: "orch-lead@x", at: "2026-10-14T00:00:00Z" }, delivery: null };
    const text = lockLines(detail, width);
    expect(text).toHaveLength(1);
    expect(text[0]).toContain("spec locked · delivery open");
    expect(text[0]).not.toContain("…");
  });

  it("uses one line as soon as the whole header fits and a stacked layout below that", () => {
    const detail = slice(true, ["pending", "pending", "pending"]);
    detail.locks = { spec: { by: "orch-lead@x", at: "2026-10-14T00:00:00Z" }, delivery: null };
    expect(lockLines(detail, 81)[0]).toBe("  STATE outcomes pending · PROOF 0/3 accepted · LOCKS spec locked · delivery open");
    expect(lockLines(detail, 80)[0]).toBe("  LOCKS  spec locked · delivery open");
  });

  it("never cuts the lock state at any detail width from 70, for the longest header", () => {
    const detail = slice(true, Array.from({ length: 10 }, () => "accepted" as Judged));
    detail.locks = { spec: { by: "orch-lead@x", at: "2026-10-14T00:00:00Z" }, delivery: { by: "orch-lead@x", at: "2026-10-14T00:00:00Z" } };
    for (let width = 70; width <= 140; width += 1) {
      const text = lockLines(detail, width);
      expect(text, `width ${width}`).toHaveLength(1);
      expect(text[0], `width ${width}`).toContain("spec locked · delivery locked");
      expect(text[0], `width ${width}`).not.toContain("…");
    }
  });

  it.each([60, 160])("says n/m paired without a policy (width %i)", (width) => {
    expect(proofSeg(slice(true, null), width)).toEqual({ text: "3/3 paired", token: "ok" });
    expect(proofSeg(slice(false, null), width)).toEqual({ text: "0/3 paired", token: "warn" });
  });
});
