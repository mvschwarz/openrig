import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPoolReadyPolicy } from "../src/domain/policies/artifact-pool-ready.js";
import { edgeArtifactRequiredPolicy } from "../src/domain/policies/edge-artifact-required.js";
import { periodicReminderPolicy } from "../src/domain/policies/periodic-reminder.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

function makeJob(overrides: Partial<PolicyJob> & { context: Record<string, unknown> }): PolicyJob {
  return {
    jobId: "job-1",
    policy: "periodic-reminder",
    targetSession: "a@rig",
    intervalSeconds: 60,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "ops@kernel",
    registeredAt: "2026-05-03T07:00:00.000Z",
    ...overrides,
  };
}

describe("periodicReminderPolicy", () => {
  it("returns send with explicit target+message from context", async () => {
    const out = await periodicReminderPolicy.evaluate(
      makeJob({
        context: { target: { session: "alice@rig" }, message: "ping" },
      }),
    );
    expect(out).toEqual({ action: "send", target: "alice@rig", message: "ping" });
  });

  it("throws policy_spec_invalid when context.target.session is missing", async () => {
    try {
      await periodicReminderPolicy.evaluate(makeJob({ context: { message: "x" } }));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });

  it("throws policy_spec_invalid when context.message is missing", async () => {
    try {
      await periodicReminderPolicy.evaluate(makeJob({ context: { target: { session: "a@rig" } } }));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });
});

describe("artifactPoolReadyPolicy", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `watchdog-pool-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("skip with reason no_actionable_artifacts when pool empty", async () => {
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { target: { session: "a@rig" }, pools: { path: tmp } },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });

  it("send with formatted message when pool has actionable artifacts", async () => {
    writeFileSync(join(tmp, "a.md"), "---\nstatus: ready\n---\nbody-a\n");
    writeFileSync(join(tmp, "b.md"), "---\nstatus: ready\n---\nbody-b\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          pools: { path: tmp, include_statuses: ["ready"] },
          label: "things",
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target).toBe("a@rig");
    expect(out.message).toMatch(/things has 2 actionable artifact/);
    expect(out.message).toContain("a.md");
    expect(out.message).toContain("b.md");
  });

  it("respects include_statuses filter (artifact with non-matching status is excluded)", async () => {
    writeFileSync(join(tmp, "a.md"), "---\nstatus: ready\n---\nbody-a\n");
    writeFileSync(join(tmp, "b.md"), "---\nstatus: draft\n---\nbody-b\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          pools: { path: tmp, include_statuses: ["ready"] },
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toMatch(/has 1 actionable/);
    expect(out.message).toContain("a.md");
    expect(out.message).not.toContain("b.md");
  });

  it("respects max_items cap in formatted bullet list", async () => {
    for (const c of ["a", "b", "c", "d", "e", "f", "g"]) {
      writeFileSync(join(tmp, `${c}.md`), "---\nstatus: ready\n---\n");
    }
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          pools: { path: tmp, include_statuses: ["ready"] },
          max_items: 3,
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toMatch(/has 7 actionable/);
    const bulletCount = out.message.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(bulletCount).toBe(3);
  });

  it("missing pool directory yields skip (no actionable)", async () => {
    rmSync(tmp, { recursive: true, force: true });
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { target: { session: "a@rig" }, pools: { path: tmp } },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });
});

describe("edgeArtifactRequiredPolicy", () => {
  let src: string;
  let tgt: string;
  beforeEach(() => {
    src = join(tmpdir(), `wd-edge-src-${Date.now()}-${Math.random()}`);
    tgt = join(tmpdir(), `wd-edge-tgt-${Date.now()}-${Math.random()}`);
    mkdirSync(src, { recursive: true });
    mkdirSync(tgt, { recursive: true });
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(tgt, { recursive: true, force: true });
  });

  it("skip when every source key has matching target", async () => {
    writeFileSync(join(src, "x.md"), "---\nentry: x\nstatus: ready\n---\n");
    writeFileSync(join(tgt, "x-downstream.md"), "---\nentry: x\nstatus: anything\n---\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          source_pools: { path: src, include_statuses: ["ready"] },
          target_pools: { path: tgt },
        },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_missing_edge_artifacts" });
  });

  it("send with missing-edge list when sources lack matching targets", async () => {
    writeFileSync(join(src, "x.md"), "---\nentry: x\nstatus: ready\n---\n");
    writeFileSync(join(src, "y.md"), "---\nentry: y\nstatus: ready\n---\n");
    writeFileSync(join(tgt, "x-downstream.md"), "---\nentry: x\n---\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          source_pools: { path: src, include_statuses: ["ready"] },
          target_pools: { path: tgt },
          label: "myedge",
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target).toBe("a@rig");
    expect(out.message).toMatch(/myedge has 1 upstream artifact/);
    expect(out.message).toContain("y.md");
    expect(out.message).not.toContain("x.md");
  });

  it("source key falls back to basename-sans-md when frontmatter[key_field] absent", async () => {
    writeFileSync(join(src, "no-frontmatter-key.md"), "---\nstatus: ready\n---\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          source_pools: { path: src, include_statuses: ["ready"] },
          target_pools: { path: tgt },
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("no-frontmatter-key.md");
  });

  it("target match honors target_key_field override", async () => {
    writeFileSync(join(src, "x.md"), "---\nentry: foo\nstatus: ready\n---\n");
    writeFileSync(join(tgt, "x.md"), "---\nlinks_to: foo\n---\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          source_pools: { path: src, include_statuses: ["ready"] },
          target_pools: { path: tgt },
          source_key_field: "entry",
          target_key_field: "links_to",
        },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_missing_edge_artifacts" });
  });

  it("target scan ignores include_statuses (matches POC override)", async () => {
    writeFileSync(join(src, "x.md"), "---\nentry: x\nstatus: ready\n---\n");
    // Target has matching key but a non-listed status; match should still count.
    writeFileSync(join(tgt, "x-down.md"), "---\nentry: x\nstatus: rejected\n---\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        context: {
          target: { session: "a@rig" },
          source_pools: { path: src, include_statuses: ["ready"] },
          target_pools: { path: tgt, include_statuses: ["accepted"] },
        },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_missing_edge_artifacts" });
  });
});
