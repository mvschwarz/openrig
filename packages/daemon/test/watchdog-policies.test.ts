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
    target: { session: "a@rig" },
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

describe("periodicReminderPolicy (POC contract)", () => {
  it("returns send with target object + message from job.message", async () => {
    const out = await periodicReminderPolicy.evaluate(
      makeJob({
        target: { session: "alice@rig" },
        message: "ping",
        context: {},
      }),
    );
    expect(out).toEqual({ action: "send", target: { session: "alice@rig" }, message: "ping" });
  });

  it("returns send with message from context.message when job.message absent", async () => {
    const out = await periodicReminderPolicy.evaluate(
      makeJob({
        target: { session: "alice@rig" },
        context: { message: "ctx-ping" },
      }),
    );
    expect(out).toEqual({ action: "send", target: { session: "alice@rig" }, message: "ctx-ping" });
  });

  it("throws policy_spec_invalid when target.session is missing", async () => {
    try {
      await periodicReminderPolicy.evaluate(
        makeJob({ target: { session: "" }, context: { message: "x" } }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });

  it("throws policy_spec_invalid when no message anywhere", async () => {
    try {
      await periodicReminderPolicy.evaluate(makeJob({ context: {} }));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });
});

describe("artifactPoolReadyPolicy (POC contract)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `watchdog-pool-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("skip with reason no_actionable_artifacts when pool empty", async () => {
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp }] },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });

  it("send with formatted message when pool has actionable artifacts", async () => {
    writeFileSync(join(tmp, "a.md"), "---\nstatus: ready\n---\nbody-a\n");
    writeFileSync(join(tmp, "b.md"), "---\nstatus: ready\n---\nbody-b\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        target: { session: "a@rig" },
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"] }],
          label: "things",
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target).toEqual({ session: "a@rig" });
    expect(out.message).toMatch(/things has 2 actionable artifact/);
    expect(out.message).toContain("a.md");
    expect(out.message).toContain("b.md");
    // POC trailer message
    expect(out.message).toContain("Claim and process the next artifact");
  });

  it("respects include_statuses filter (artifact with non-matching status is excluded)", async () => {
    writeFileSync(join(tmp, "a.md"), "---\nstatus: ready\n---\nbody-a\n");
    writeFileSync(join(tmp, "b.md"), "---\nstatus: draft\n---\nbody-b\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toMatch(/has 1 actionable/);
    expect(out.message).toContain("a.md");
    expect(out.message).not.toContain("b.md");
  });

  it("respects max_items cap (formatted bullet list capped)", async () => {
    for (const c of ["a", "b", "c", "d", "e", "f", "g"]) {
      writeFileSync(join(tmp, `${c}.md`), "---\nstatus: ready\n---\n");
    }
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"] }],
          max_items: 3,
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toMatch(/has 7 actionable/);
    const bulletCount = out.message
      .split("\n")
      .filter((l) => l.startsWith("- ") && !l.startsWith("- ..."))
      .length;
    expect(bulletCount).toBe(3);
    expect(out.message).toContain("- ... 4 more");
  });

  it("missing pool directory yields skip (ENOENT-tolerant)", async () => {
    rmSync(tmp, { recursive: true, force: true });
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp }] },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });

  // R1 fix: POC scanner parity (guard blocker 3).
  it("default-ignores README.md (POC parity)", async () => {
    writeFileSync(join(tmp, "README.md"), "# Pool docs\n");
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("ready.md");
    expect(out.message).not.toContain("README.md");
  });

  it("default-ignores .DS_Store (POC parity)", async () => {
    writeFileSync(join(tmp, ".DS_Store"), "binary-junk");
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).not.toContain(".DS_Store");
  });

  it("excludes malformed-frontmatter artifacts unless include_malformed_frontmatter=true", async () => {
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    writeFileSync(
      join(tmp, "malformed.md"),
      "---\nstatus: ready\nbroken: value: still broken\n---\n",
    );
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("ready.md");
    expect(out.message).not.toContain("malformed.md");
  });

  it("supports configured ignore_names (POC parity)", async () => {
    writeFileSync(join(tmp, "skip-me.md"), "---\nstatus: ready\n---\n");
    writeFileSync(join(tmp, "include-me.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"], ignore_names: ["skip-me.md"] }],
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("include-me.md");
    expect(out.message).not.toContain("skip-me.md");
  });

  it("recursive=true descends into subdirectories", async () => {
    const sub = join(tmp, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "nested-ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: {
          pools: [{ path: tmp, include_statuses: ["ready"], recursive: true }],
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("nested-ready.md");
  });

  it("recursive default=false excludes subdirectories", async () => {
    const sub = join(tmp, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "nested-ready.md"), "---\nstatus: ready\n---\n");
    const out = await artifactPoolReadyPolicy.evaluate(
      makeJob({
        context: { pools: [{ path: tmp, include_statuses: ["ready"] }] },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
  });
});

describe("edgeArtifactRequiredPolicy (POC contract)", () => {
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

  // R1 fix (guard blocker 2): POC contract uses context.source / context.target.
  it("skip when downstream raw content references source key (POC body-match)", async () => {
    writeFileSync(
      join(src, "x.md"),
      "---\nentry: coordination-stream-queue-view-intake-pilot-a-vertical\nstatus: shipped\n---\n# Pilot A\n",
    );
    writeFileSync(
      join(tgt, "old.md"),
      "---\nstatus: closed\n---\n# Old item\n\nThis item mentions agent-starter-v1-vertical only.\n",
    );
    writeFileSync(
      join(tgt, "new.md"),
      "---\nstatus: ready\n---\nLifecycle edge for coordination-stream-queue-view-intake-pilot-a-vertical.\n",
    );
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "delivery-orch-lead@openrig-velocity" },
        context: {
          edge_label: "delivery-to-lifecycle",
          source: { path: src, include_statuses: ["shipped"], key_field: "entry" },
          target: { path: tgt },
        },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_missing_edge_artifacts" });
  });

  it("send when downstream raw does NOT reference source key (POC body-match)", async () => {
    writeFileSync(
      join(src, "x.md"),
      "---\nentry: coordination-stream-queue-view-intake-pilot-a-vertical\nstatus: shipped\n---\n# Pilot A\n",
    );
    writeFileSync(
      join(tgt, "old.md"),
      "---\nstatus: closed\n---\n# Old item\n\nThis item mentions agent-starter-v1-vertical only.\n",
    );
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "delivery-orch-lead@openrig-velocity" },
        context: {
          edge_label: "delivery-to-lifecycle",
          source: { path: src, include_statuses: ["shipped"], key_field: "entry" },
          target: { path: tgt },
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target).toEqual({ session: "delivery-orch-lead@openrig-velocity" });
    expect(out.message).toContain("delivery-to-lifecycle");
    expect(out.message).toContain("coordination-stream-queue-view-intake-pilot-a-vertical");
    expect(out.message).toContain("Producer loop owns creating the missing downstream artifact");
  });

  it("source key falls back to basename-sans-md when frontmatter[key_field] absent", async () => {
    writeFileSync(join(src, "no-frontmatter-key.md"), "---\nstatus: ready\n---\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "a@rig" },
        context: {
          source: { path: src, include_statuses: ["ready"] },
          target: { path: tgt },
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.message).toContain("no-frontmatter-key");
  });

  it("target scan ignores source's include_statuses (POC override)", async () => {
    writeFileSync(join(src, "x.md"), "---\nentry: x\nstatus: ready\n---\n");
    // Target has matching key in body but a non-listed status; match still counts.
    writeFileSync(join(tgt, "x-down.md"), "---\nstatus: rejected\n---\nReferences x here.\n");
    const out = await edgeArtifactRequiredPolicy.evaluate(
      makeJob({
        target: { session: "a@rig" },
        context: {
          source: { path: src, include_statuses: ["ready"] },
          target: { path: tgt, include_statuses: ["accepted"] },
        },
      }),
    );
    expect(out).toEqual({ action: "skip", reason: "no_missing_edge_artifacts" });
  });

  it("throws policy_spec_invalid when context.source is missing", async () => {
    try {
      await edgeArtifactRequiredPolicy.evaluate(
        makeJob({
          target: { session: "a@rig" },
          context: { target: { path: tgt } },
        }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });

  it("throws policy_spec_invalid when context.target is missing", async () => {
    try {
      await edgeArtifactRequiredPolicy.evaluate(
        makeJob({
          target: { session: "a@rig" },
          context: { source: { path: src } },
        }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });
});
