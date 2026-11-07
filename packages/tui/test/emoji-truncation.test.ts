import { describe, expect, it } from "vitest";
import { configListLines } from "../src/config/config-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import { healthListLines, healthSummaryLine } from "../src/health/health-model.js";
import { renderLanes } from "../src/pulse/render-pulse.js";
import { renderScreen } from "../src/render.js";
import { scopeIdentityLines, type SliceScopeSnap } from "../src/scopes/scopes-model.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function slice(overrides: Partial<SliceScopeSnap>): SliceScopeSnap {
  return {
    dirName: "slice-01", id: "S1", displayName: "slice", stage: "active", status: "active",
    locks: { spec: null, delivery: null }, proof: { paired: 0, total: 0 }, readiness: null,
    prdExists: false, specShaShort: null, ...overrides,
  } as SliceScopeSnap;
}

describe("TUI truncation keeps emoji whole", () => {
  it("cuts a scopes title before an emoji instead of through it", () => {
    const lines = scopeIdentityLines(slice({ displayName: "abcdefgh😀xyz long title here" }), "m", 24);
    const title = lines.find((line) => line.text.includes("title"));
    expect(title?.text.endsWith("…")).toBe(true);
    expect(lines.some((line) => LONE_SURROGATE.test(line.text))).toBe(false);
  });

  it("hard-wraps an unbroken scopes value without splitting an emoji", () => {
    const lines = scopeIdentityLines(slice({ error: `${"x".repeat(23)}😀${"y".repeat(30)}` }), "m", 24);
    expect(lines.some((line) => LONE_SURROGATE.test(line.text))).toBe(false);
    expect(lines.map((line) => line.text).join("")).toContain("😀");
  });

  it("cuts a Pulse lane label before an emoji instead of through it", () => {
    const lines = renderLanes([
      { label: "NOW", count: 1, rows: [{ glyph: "●", token: "ok", label: `${"a".repeat(26)}🚀 ship it` }] },
      { label: "JUST FINISHED", count: 0, rows: [] },
      { label: "UP NEXT", count: 0, rows: [] },
    ] as Parameters<typeof renderLanes>[0]);
    const texts = lines.map((line) => line.segs.map((seg) => seg.text).join(""));
    expect(texts.some((text) => text.includes("…"))).toBe(true);
    expect(texts.some((text) => LONE_SURROGATE.test(text))).toBe(false);
  });

  it("cuts a health finding's summary before an emoji in the summary line and the findings table", () => {
    const scope = { kind: "rig", rigId: "openrig-build", rigName: "openrig-build", local: true } as const;
    const texts: string[] = [];
    // Every offset of the emoji, so one of them lands on each cut point whatever the column widths are.
    for (let k = 0; k < 40; k++) {
      const snap = healthSnapshot(`${"a".repeat(k)}🚀 context pressure keeps rising past the column edge`);
      texts.push(healthSummaryLine(snap, scope, 70).text, ...healthListLines(snap, scope, 60).map((line) => line.text));
    }
    expect(texts.some((text) => text.includes("…"))).toBe(true);
    expect(texts.filter((text) => LONE_SURROGATE.test(text))).toEqual([]);
  });

  it("cuts a config value before an emoji instead of through it", () => {
    const texts = Array.from({ length: 40 }, (_, k) => configListLines([{
      key: "workspace.root", group: "general", value: `${"v".repeat(k)}😀 tail of a long value`, defaultValue: "", source: "file",
      visibility: "shown", reason: null, scope: "Displayed daemon instance", application: "Running application unverified.",
    }], 60)).flat().map((line) => line.text);
    expect(texts.some((text) => text.includes("…"))).toBe(true);
    expect(texts.filter((text) => LONE_SURROGATE.test(text))).toEqual([]);
  });

  it("cuts a seat's NOW summary in the rig table before an emoji and keeps the columns aligned", () => {
    const rows: string[][] = [];
    for (let k = 0; k < 40; k++) {
      const snap = demoSnapshot();
      for (const list of [snap.attention, snap.blocked, snap.inProgress, snap.pending]) for (const row of list) {
        if (row.destinationSession === "dev50-driver@openrig-build") row.summary = `${"a".repeat(k)}🚀 incremental build of the pulse view`;
      }
      const view = createViewState({ instanceId: "emoji-table", getSnapshot: () => snap });
      view.dispatch({ type: "drill", resource: "rig", name: "openrig-build", target: { host: "vm-host" } });
      const screen = renderScreen(view.get(), snap, { cols: 180, rows: 40, nowMs: Date.parse("2026-08-06T12:00:00.000Z") });
      rows.push(screen.lines.filter((line) => /\b(driver|guard) +c[lx] /.test(line)));
    }
    expect(rows.flat().some((line) => line.includes("aaaa") && line.includes("…"))).toBe(true);
    expect(rows.flat().filter((line) => LONE_SURROGATE.test(line))).toEqual([]);
    for (const [driver, guard] of rows) expect(driver!.indexOf(" term ▸")).toBe(guard!.indexOf(" term ▸"));
  });
});

function healthSnapshot(summary: string): FleetSnapshot {
  const snap = demoSnapshot();
  const guard = snap.hosts[0]!.rigs[0]!.pods.flatMap((pod) => pod.agents).find((agent) => agent.name === "dev50.guard")!;
  Object.assign(guard, { nodeId: "node-guard" });
  Object.assign(snap, {
    health: {
      availability: "loaded", evaluatedAt: "2026-09-05T12:00:00.000Z", total: 1, truncated: false,
      records: [{
        schema: "openrig.health/v0alpha1", id: "health-emoji", detector: "context.pressure", category: "context",
        scope: { type: "seat", rigId: "openrig-build", seatId: "node-guard" }, severity: "warning", confidence: "high",
        status: "active", startedAt: "2026-09-05T11:30:00.000Z", lastObservedAt: "2026-09-05T11:59:00.000Z",
        window: { source: "context-usage", startedAt: "2026-09-04T12:00:00.000Z", endedAt: "2026-09-05T12:00:00.000Z", limit: 3, retentionSeconds: 86400 },
        freshness: { state: "fresh", evaluatedAt: "2026-09-05T12:00:00.000Z", newestSourceAt: "2026-09-05T11:59:00.000Z", maxAgeSeconds: 600, ageSeconds: 60 },
        summary, evidence: [], threshold: "fresh context utilization >= 95%", explanation: "Sustained context pressure.",
        suggestedInspection: "Inspect the seat's context source.", indeterminateReason: null,
      }],
    },
  });
  return snap;
}
