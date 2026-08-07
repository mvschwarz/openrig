// SCOPES VIEW (plan d64d2f5c) — render pins per the v4 mock contract + the data-path rule.
import { describe, it, expect } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { parseCommand } from "../src/grammar.js";
import { proofBadge } from "../src/scopes/scopes-model.js";

function openGateway() {
  const snap = demoSnapshot();
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch(parseCommand(":scopes"));
  view.dispatch({ type: "toggle-expand", key: "scopes-mission:release-0.5.2" });
  view.dispatch({ type: "scopes-open", mission: "release-0.5.2", slice: "gateway-m1" });
  return { snap, view };
}

describe("scopes view (store-direct render, v4 mock contract)", () => {
  it("explorer: SCOPES section lists missions; expanding shows slice glyphs (● building, ✓ delivery-locked)", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "toggle-expand", key: "scopes-mission:release-0.5.2" });
    const labels = computeExplorerRows(view.get(), snap).map((r) => r.label);
    expect(labels.some((l) => l.includes("release-0.5.2"))).toBe(true);
    expect(labels.some((l) => l.includes("● gateway-m1"))).toBe(true);
    expect(labels.some((l) => l.includes("✓ crash-cart"))).toBe(true);
  });

  it("detail renders the mock structure: header card w/ proof N/M, spec-lock line, INTENT, MINI-REQUIREMENTS, PROOF CONTRACT with ✓/○ + C1 drop lines", () => {
    const { snap, view } = openGateway();
    const out = renderScreen(view.get(), snap, { cols: 160, rows: 48 }).lines.join("\n");
    expect(out).toContain("gateway-m1 ── release-0.5.2 ── stage: building ── proof: 2/9");
    expect(out).not.toContain("proof: 2/9 🔒"); // NOT delivery-locked -> no lock glyph
    expect(out).toContain("spec🔒");
    expect(out).toContain("INTENT (verbatim)");
    expect(out).toContain("Slack to the founder");
    expect(out).toContain("MINI-REQUIREMENTS (2)");
    expect(out).toContain("PROOF CONTRACT (2/9 paired)");
    expect(out).toContain("✓ 1 The ack-after-delivery repair");
    expect(out).toContain("○ 2 A registered entity");
    expect(out).toContain("└ C1 drop · qa PASS · qa-relay.md · relay-repair-e2e.txt");
  });

  it("the founder lock-glyph form: 🔒 renders ONLY when delivery-locked; the count carries the honesty", () => {
    const snap = demoSnapshot();
    const cc = snap.scopes![0]!.slices.find((s) => s.dirName === "crash-cart")!;
    expect(proofBadge(cc)).toBe("proof: 4/4 🔒");
    const gm = snap.scopes![0]!.slices.find((s) => s.dirName === "gateway-m1")!;
    expect(proofBadge(gm)).toBe("proof: 2/9"); // no del token, no unproven suffix — the count speaks
  });

  it("m collapses mini-requirements; n shows PROGRESS.md as narrative DISPLAY (never feeding counts)", () => {
    const { snap, view } = openGateway();
    view.dispatch(parseCommand("reqs"));
    let out = renderScreen(view.get(), snap, { cols: 160, rows: 48 }).lines.join("\n");
    expect(out).toContain("(collapsed — m expands)");
    view.dispatch(parseCommand("narrative"));
    out = renderScreen(view.get(), snap, { cols: 160, rows: 48 }).lines.join("\n");
    expect(out).toContain("PROGRESS (narrative — display only)");
    expect(out).toContain("A2 held on arch consult");
    // the data-path rule: the narrative panel does NOT change the store-derived counts
    expect(out).toContain("proof: 2/9");
  });
});
