import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// OPR.0.5.6.24 F-14 — OPENING REDs, test-only commit (authoring released on row
// qitem-20260829174757-522bf77e; ruled RED classes R1-R5 from transition 41565).
// RED CHARACTER AT BASE d1d8f7059: the consumer module does not exist — every
// import-dependent case fails by missing module; the assertion bodies are the
// final behavior contract and activate at GREEN (one naming pass allowed at
// implementation, the S20 P3/P4 convention). Source-pin cases read the module
// file directly and fail at base because the file is absent.
import {
  makeParkedOwnerConsumerPolicy,
  type ParkedOwnerConsumerDeps,
} from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const SEAT = "dev-planner@test-rig";
const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/domain/policies/parked-owner-consumer.ts",
);
const readModuleSource = () => readFileSync(MODULE_PATH, "utf8");

function makeJob(overrides: Partial<PolicyJob> = {}): PolicyJob {
  return {
    jobId: "job-poc-1",
    policy: "parked-owner-consumer",
    target: { session: SEAT },
    intervalSeconds: 120,
    activeWakeIntervalSeconds: 600,
    scanIntervalSeconds: null,
    context: {},
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "orch-lead@test-rig",
    registeredAt: "2026-08-29T17:00:00.000Z",
    ...overrides,
  };
}

/** The F-14 specimen shape: claimed in-progress rows held by a seat whose
 *  ARBITRATED oracle verdict is idle-at-prompt. Seam-injected deps so the
 *  fixtures never touch raw hook surfaces (mini-req 2, the one-oracle law). */
function makeDeps(overrides: Partial<ParkedOwnerConsumerDeps> = {}): ParkedOwnerConsumerDeps {
  const receipts = new Map<string, { episodeKey: string; deliveredAt: string }>();
  return {
    // Arbitrated oracle seam — the SAME verdict surface `rig parked` consumes.
    getSeatState: () => ({
      value: "idle",
      needsInput: false,
      decidedBy: "arbitration",
      atPrompt: true,
    }) as never,
    // Destination-scoped open obligations (the shipped parked-query scope).
    listOpenObligations: () => ({
      rows: [
        { qitemId: "qitem-20260828190838-bd7eef84", state: "in-progress" as const, summary: "S20 build baton" },
        { qitemId: "qitem-20260828235231-f115c617", state: "in-progress" as const, summary: "repair ruling" },
        { qitemId: "qitem-20260829001330-64f888d1", state: "in-progress" as const, summary: "A5 repair baton" },
      ],
      limit: 500,
    }),
    receipts: {
      findForEpisode: (episodeKey: string) => receipts.get(episodeKey) ?? null,
      record: (r: { episodeKey: string; deliveredAt: string }) => void receipts.set(r.episodeKey, r),
    },
    ...overrides,
  };
}

describe("parked-owner-consumer policy (OPR.0.5.6.24 F-14)", () => {
  // R1 — THE SPECIMEN DIES: the 2026-08-29 dev-planner shape (three claimed
  // in-progress rows, seat idle at prompt, ~14h invisible) produces exactly one
  // fire naming every held row id. RED at base: no consumer exists at all.
  it("R1: claimed-rows x arbitrated-idle fires ONE wake naming every held obligation row", async () => {
    const policy = makeParkedOwnerConsumerPolicy(makeDeps());
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("fire");
    const named = JSON.stringify(result.notes ?? {});
    expect(named).toContain("qitem-20260828190838-bd7eef84");
    expect(named).toContain("qitem-20260828235231-f115c617");
    expect(named).toContain("qitem-20260829001330-64f888d1");
  });

  // R2 — ONCE PER EPISODE, both directions.
  it("R2a: a second evaluation inside one park episode SKIPS with the already-woken receipt as reason", async () => {
    const deps = makeDeps();
    const policy = makeParkedOwnerConsumerPolicy(deps);
    const first = await policy.evaluate(makeJob());
    expect(first.action).toBe("fire");
    const second = await policy.evaluate(makeJob());
    expect(second.action).toBe("skip");
    expect(String(second.reason)).toMatch(/already[-_]woken/);
  });

  it("R2b: resume then re-park is a NEW episode and earns its one wake", async () => {
    let idle = true;
    const deps = makeDeps({
      getSeatState: () => ({
        value: idle ? "idle" : "working",
        needsInput: idle,
        decidedBy: "arbitration",
        atPrompt: idle,
      }) as never,
    });
    const policy = makeParkedOwnerConsumerPolicy(deps);
    expect((await policy.evaluate(makeJob())).action).toBe("fire");
    idle = false; // the seat resumes — the episode ends
    expect((await policy.evaluate(makeJob())).action).toBe("skip");
    idle = true; // re-parks — a NEW episode
    expect((await policy.evaluate(makeJob())).action).toBe("fire");
  });

  // R3 — HONEST SKIP CELLS.
  it("R3a: obligations closed between derive and wake skip with that exact reason (no fire on empty scope)", async () => {
    const policy = makeParkedOwnerConsumerPolicy(
      makeDeps({ listOpenObligations: () => ({ rows: [], limit: 500 }) }),
    );
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String(result.reason)).toMatch(/no[-_]open[-_]obligation|obligation[-_]closed/);
  });

  it("R3b: a usage-limit park DEFERS to S16's timed wake — zero fires from this consumer, reason names the cause", async () => {
    const policy = makeParkedOwnerConsumerPolicy(
      makeDeps({
        getSeatState: () => ({
          value: "idle",
          needsInput: false,
          decidedBy: "arbitration",
          atPrompt: true,
          cause: "usage-limit",
        }) as never,
      }),
    );
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String(result.reason)).toMatch(/usage[-_]limit/);
  });

  it("R3c: an INDETERMINATE arbitrated verdict is NOT parked and gets no wake (S21 inheritance)", async () => {
    const policy = makeParkedOwnerConsumerPolicy(
      makeDeps({
        getSeatState: () => ({
          value: "unknown",
          needsInput: false,
          decidedBy: null,
          atPrompt: false,
        }) as never,
      }),
    );
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String(result.reason)).toMatch(/indeterminate|unknown|not[-_]parked/);
  });

  // R4 — ARBITRATED-ONLY, structurally: the module consumes the arbitrated
  // seam and NEVER the raw hook store (the first specimen's raw-vs-arbitrated
  // disagreement is exactly the hole this pin closes). Fails at base: no file.
  it("R4: the module reads the arbitrated derivation surface and has ZERO raw-hook reads", () => {
    const src = readModuleSource();
    expect(src).toMatch(/getSeatState|diagnoseSeatParked/);
    expect(src).not.toMatch(/AgentActivityStore|getLatestForNode|activity-relay|hook/);
  });

  // R5 — NO SECOND SCHEDULER, structurally: the module registers as a policy on
  // the existing watchdog engine and contains no timer entry point of its own.
  it("R5: no timer/scheduler/state-machine entry point outside the watchdog surface", () => {
    const src = readModuleSource();
    expect(src).not.toMatch(/setInterval|setTimeout|new\s+\w*Scheduler|cron/i);
    expect(src).toMatch(/makeParkedOwnerConsumerPolicy/);
  });

  // Quiet-is-cheap floor (the S02 heartbeat idiom): a clean scan — no held
  // obligations, seat active — records nothing.
  it("floor: a clean scan skips quietly and records no receipt", async () => {
    const recorded: unknown[] = [];
    const policy = makeParkedOwnerConsumerPolicy(
      makeDeps({
        getSeatState: () => ({ value: "working", needsInput: false, decidedBy: "arbitration", atPrompt: false }) as never,
        listOpenObligations: () => ({ rows: [], limit: 500 }),
        receipts: {
          findForEpisode: () => null,
          record: (r: unknown) => void recorded.push(r),
        },
      }),
    );
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(recorded).toHaveLength(0);
  });
});
