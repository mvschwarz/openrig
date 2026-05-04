// Operator Surface Reconciliation v0 — steering composer tests.
//
// Drives SteeringComposer against a fixture filesystem layout
// (workspaceRoot containing STEERING.md + roadmap/PROGRESS.md +
// delivery-ready/mode-{0..3}/PROGRESS.md). Pins:
//   - isReady() true when at least one source resolvable; false when none
//   - priority stack section returns verbatim STEERING.md content
//   - roadmap rail extracts checkbox rows + railItemCode + isNextUnchecked
//   - lane rails group by mode-N; top-N items prefer non-done; next-pull
//     marker on first non-done, non-blocked checkbox
//   - per-section overrides (steeringPath / roadmapPath / deliveryReadyDir)
//     trump workspace-root-derived defaults
//   - unavailable sources surface structured diagnostics with envVar hints
//   - empty/unset env yields composer with isReady() false

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SteeringComposer,
  matchRailItemCode,
  steeringOptsFromEnv,
  steeringOptsFromSettings,
} from "../src/domain/steering/steering-composer.js";

describe("Operator Surface Reconciliation v0 — matchRailItemCode", () => {
  it("extracts PL-XXX codes from arbitrary text", () => {
    expect(matchRailItemCode("ship PL-019 topology indicators")).toBe("PL-019");
    expect(matchRailItemCode("PL-005 Phase A")).toBe("PL-005");
    expect(matchRailItemCode("no rail code here")).toBeNull();
  });
});

describe("Operator Surface Reconciliation v0 — steeringOptsFromEnv", () => {
  it("returns null workspaceRoot when env unset", () => {
    expect(steeringOptsFromEnv({})).toMatchObject({ workspaceRoot: null });
  });

  it("reads OPENRIG_STEERING_WORKSPACE + per-section overrides", () => {
    const opts = steeringOptsFromEnv({
      OPENRIG_STEERING_WORKSPACE: "/abs/workspace",
      OPENRIG_STEERING_PATH: "/abs/override/STEERING.md",
      OPENRIG_ROADMAP_PATH: "/abs/override/roadmap.md",
      OPENRIG_DELIVERY_READY_DIR: "/abs/override/delivery-ready",
    });
    expect(opts.workspaceRoot).toBe("/abs/workspace");
    expect(opts.steeringPath).toBe("/abs/override/STEERING.md");
    expect(opts.roadmapPath).toBe("/abs/override/roadmap.md");
    expect(opts.deliveryReadyDir).toBe("/abs/override/delivery-ready");
  });

  it("falls back to RIGGED_STEERING_WORKSPACE when OPENRIG var is empty (|| not ??)", () => {
    expect(steeringOptsFromEnv({ OPENRIG_STEERING_WORKSPACE: "", RIGGED_STEERING_WORKSPACE: "/legacy" }))
      .toMatchObject({ workspaceRoot: "/legacy" });
  });

  it("uses typed workspace settings as the fresh-install default, with env overrides still winning", () => {
    const opts = steeringOptsFromSettings(
      {
        workspaceRoot: "/Users/me/.openrig/workspace",
        workspaceSteeringPath: "/Users/me/.openrig/workspace/steering/STEERING.md",
      },
      {},
    );
    expect(opts).toMatchObject({
      workspaceRoot: "/Users/me/.openrig/workspace",
      steeringPath: "/Users/me/.openrig/workspace/steering/STEERING.md",
    });

    const overridden = steeringOptsFromSettings(
      {
        workspaceRoot: "/Users/me/.openrig/workspace",
        workspaceSteeringPath: "/Users/me/.openrig/workspace/steering/STEERING.md",
      },
      {
        OPENRIG_STEERING_WORKSPACE: "/env/workspace",
        OPENRIG_STEERING_PATH: "/env/STEERING.md",
      },
    );
    expect(overridden).toMatchObject({
      workspaceRoot: "/env/workspace",
      steeringPath: "/env/STEERING.md",
    });
  });
});

describe("Operator Surface Reconciliation v0 — SteeringComposer", () => {
  let workspaceRoot: string;
  let cleanup: string;

  beforeEach(() => {
    cleanup = mkdtempSync(join(tmpdir(), "steering-composer-"));
    workspaceRoot = join(cleanup, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(cleanup, { recursive: true, force: true }));

  it("isReady() = false when no sources resolvable (empty workspace + no overrides)", () => {
    const composer = new SteeringComposer({ workspaceRoot: null });
    expect(composer.isReady()).toBe(false);
  });

  it("isReady() = true when at least one source resolves (priority stack only)", () => {
    writeFileSync(join(workspaceRoot, "STEERING.md"), "# steering");
    const composer = new SteeringComposer({ workspaceRoot });
    expect(composer.isReady()).toBe(true);
  });

  it("priority stack returns verbatim STEERING.md content + mtime + byteCount", () => {
    writeFileSync(join(workspaceRoot, "STEERING.md"), "# Priority\n- Do X\n- Avoid Y\n");
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.priorityStack).not.toBeNull();
    expect(out.priorityStack!.content).toBe("# Priority\n- Do X\n- Avoid Y\n");
    expect(out.priorityStack!.byteCount).toBeGreaterThan(0);
    expect(out.priorityStack!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("priority stack null + unavailable diagnostic when STEERING.md absent", () => {
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.priorityStack).toBeNull();
    expect(out.unavailableSources.find((s) => s.section === "priorityStack")).toBeDefined();
  });

  it("roadmap rail extracts checkbox rows with railItemCode + isNextUnchecked on first unchecked", () => {
    mkdirSync(join(workspaceRoot, "roadmap"), { recursive: true });
    writeFileSync(join(workspaceRoot, "roadmap", "PROGRESS.md"),
      "# Roadmap\n- [x] PL-005 Phase A\n- [x] PL-019 done\n- [ ] PL-022 next\n- [ ] PL-030 later\n");
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.roadmapRail).not.toBeNull();
    const items = out.roadmapRail!.items;
    expect(items).toHaveLength(4);
    expect(items[0]?.railItemCode).toBe("PL-005");
    expect(items[0]?.done).toBe(true);
    expect(items[2]?.railItemCode).toBe("PL-022");
    expect(items[2]?.isNextUnchecked).toBe(true);
    expect(items[3]?.isNextUnchecked).toBe(false);
    expect(out.roadmapRail!.counts.done).toBe(2);
    expect(out.roadmapRail!.counts.total).toBe(4);
    expect(out.roadmapRail!.counts.nextUncheckedLine).toBe(items[2]?.line);
  });

  it("lane rails group by mode-N; top-N prefers non-done; next-pull marks first non-done non-blocked", () => {
    mkdirSync(join(workspaceRoot, "delivery-ready", "mode-2"), { recursive: true });
    mkdirSync(join(workspaceRoot, "delivery-ready", "mode-3"), { recursive: true });
    writeFileSync(join(workspaceRoot, "delivery-ready", "mode-2", "PROGRESS.md"),
      "# Mode 2\n- [x] alpha done\n- [~] beta blocked\n- [ ] gamma next\n- [ ] delta later\n");
    writeFileSync(join(workspaceRoot, "delivery-ready", "mode-3", "PROGRESS.md"),
      "# Mode 3\n- [x] one done\n- [x] two done\n");
    const composer = new SteeringComposer({ workspaceRoot, topNPerLane: 3 });
    const out = composer.compose();
    expect(out.laneRails).toHaveLength(2);
    const mode2 = out.laneRails.find((l) => l.laneId === "mode-2")!;
    expect(mode2.healthBadges).toEqual({ active: 2, blocked: 1, done: 1, total: 4 });
    expect(mode2.nextPullLine).not.toBeNull();
    const nextPullItem = mode2.topItems.find((i) => i.isNextPull);
    expect(nextPullItem?.text).toBe("gamma next");
    // Top-3 prefers non-done — beta (blocked) and gamma+delta (active) come before alpha (done).
    expect(mode2.topItems.map((i) => i.text)).toEqual(["beta blocked", "gamma next", "delta later"]);
    const mode3 = out.laneRails.find((l) => l.laneId === "mode-3")!;
    expect(mode3.nextPullLine).toBeNull();
  });

  it("per-section overrides trump workspace-root defaults", () => {
    const overrideRoot = join(cleanup, "elsewhere");
    mkdirSync(overrideRoot, { recursive: true });
    writeFileSync(join(overrideRoot, "STEERING-CUSTOM.md"), "# overridden steering");
    writeFileSync(join(workspaceRoot, "STEERING.md"), "# default steering");
    const composer = new SteeringComposer({
      workspaceRoot,
      steeringPath: join(overrideRoot, "STEERING-CUSTOM.md"),
    });
    const out = composer.compose();
    expect(out.priorityStack?.content).toBe("# overridden steering");
  });

  it("composer with no sources returns empty payload + 3 unavailable diagnostics", () => {
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.priorityStack).toBeNull();
    expect(out.roadmapRail).toBeNull();
    expect(out.laneRails).toEqual([]);
    expect(out.unavailableSources.map((s) => s.section).sort()).toEqual(["laneRails", "priorityStack", "roadmapRail"]);
  });
});
