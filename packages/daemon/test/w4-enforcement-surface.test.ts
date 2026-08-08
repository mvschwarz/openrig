import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import {
  ClaudeCompactionEnforcer,
  type EnforcerInput,
} from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";

const STORE_MODULE = ["../src/domain", "enforcer-decision-store.js"].join("/");
const KIND = "claude_compaction";
const SEAT = "claude-seat@rig";

type DecisionStoreConstructor = new (
  db: Database.Database,
  opts: { now: () => Date; authorizeTtlMinutes: () => number },
) => {
  create(input: Record<string, unknown>): Record<string, unknown>;
  list(input?: Record<string, unknown>): Array<Record<string, unknown>>;
  clear(input: Record<string, unknown>): Record<string, unknown>;
  findActiveHold(input: Record<string, unknown>): Record<string, unknown> | null;
  consumeAuthorizationForAttempt(input: Record<string, unknown>): boolean;
  recordAuthorizationAttempt(input: Record<string, unknown>): void;
};

async function loadDecisionStore(): Promise<DecisionStoreConstructor> {
  let mod: { EnforcerDecisionStore?: DecisionStoreConstructor } | null = null;
  try {
    mod = await import(/* @vite-ignore */ STORE_MODULE);
  } catch {
    // Assertion below keeps the RED feature-shaped instead of surfacing a loader error.
  }
  expect(mod, "durable enforcer decision store module must exist").not.toBeNull();
  expect(mod?.EnforcerDecisionStore).toBeTypeOf("function");
  return mod!.EnforcerDecisionStore!;
}

function makeDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function humanInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enforcerKind: KIND,
    sessionName: SEAT,
    generationUuid: "gen-1",
    direction: "hold",
    reason: "seat is inside a load-bearing atomic step",
    actorSession: "orch-lead@rig",
    identityProvenance: "transport:v1",
    ...overrides,
  };
}

describe("W4 durable enforcer decision store", () => {
  it("registers migration 068 and creates the durable decision table", () => {
    expect(ALL_MIGRATIONS.map((migration) => migration.name)).toContain(
      "068_enforcer_decisions.sql",
    );
    const db = makeDb();
    try {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'enforcer_decisions'",
      ).get() as { name: string } | undefined;
      expect(row?.name).toBe("enforcer_decisions");
    } finally {
      db.close();
    }
  });

  it("persists an attributable generation-scoped hold with enforcer kind", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const created = store.create(humanInput());
      expect(created).toMatchObject({
        enforcerKind: KIND,
        sessionName: SEAT,
        generationUuid: "gen-1",
        direction: "hold",
        actorSession: "orch-lead@rig",
        identityProvenance: "transport:v1",
        reason: "seat is inside a load-bearing atomic step",
        active: true,
      });
    } finally {
      db.close();
    }
  });

  it("makes authorize expiring, reason-matched, and limited to the locked lift set", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      for (const [index, automaticReason] of [
        "disabled",
        "post_restore_cooldown",
        "stale_generation",
      ].entries()) {
        const created = store.create(humanInput({
          generationUuid: `gen-${index + 1}`,
          direction: "authorize",
          automaticReason,
          reason: `lift ${automaticReason} once`,
        }));
        expect(created).toMatchObject({
          direction: "authorize",
          automaticReason,
          expiresAt: "2026-08-08T18:15:00.000Z",
          active: true,
        });
      }

      for (const automaticReason of [
        "runtime_filter",
        "no_usage_data",
        "invalid_policy",
        "below_threshold",
        "already_triggered_above_threshold",
        "dedup_window",
        "send_failed",
        "human_hold",
      ]) {
        expect(() => store.create(humanInput({
          generationUuid: `excluded-${automaticReason}`,
          direction: "authorize",
          automaticReason,
          reason: "must be refused",
        }))).toThrow(/automatic reason|not authorizable|liftable/i);
      }
    } finally {
      db.close();
    }
  });

  it("enforces one active decision and resolves conflicts toward hold", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const authorization = store.create(humanInput({
        direction: "authorize",
        automaticReason: "disabled",
        reason: "one disabled-policy attempt",
      }));
      const hold = store.create(humanInput({ reason: "new work began; stop before acting" }));
      expect(hold).toMatchObject({ direction: "hold", active: true });
      const rows = store.list({ sessionName: SEAT });
      expect(rows.find((row) => row["decisionId"] === authorization["decisionId"])).toMatchObject({
        active: false,
        releaseKind: "revoked_by_hold",
        releasedBySession: "orch-lead@rig",
        releaseIdentityProvenance: "transport:v1",
      });
      expect(() => store.create(humanInput({
        direction: "authorize",
        automaticReason: "disabled",
        reason: "must not outrank hold",
      }))).toThrow(/active hold/i);
    } finally {
      db.close();
    }
  });

  it("consumes one authorization atomically for one machine send attempt", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const created = store.create(humanInput({
        direction: "authorize",
        automaticReason: "disabled",
        reason: "allow one disabled-policy attempt",
      }));
      const consumeInput = {
        decisionId: created["decisionId"],
        enforcerKind: KIND,
        liftedReason: "disabled",
      };
      expect(store.consumeAuthorizationForAttempt(consumeInput)).toBe(true);
      expect(store.consumeAuthorizationForAttempt(consumeInput)).toBe(false);
      store.recordAuthorizationAttempt({
        decisionId: created["decisionId"],
        outcome: "failed",
        failureReason: "send_failed",
      });
      expect(store.list({ sessionName: SEAT })[0]).toMatchObject({
        consumedByEnforcerKind: KIND,
        liftedReason: "disabled",
        attemptOutcome: "failed",
        attemptFailureReason: "send_failed",
      });
      expect(store.list({ sessionName: SEAT })[0]).not.toHaveProperty("consumedByActorSession");
      expect(store.list({ sessionName: SEAT })[0]).not.toHaveProperty("consumeIdentityProvenance");
    } finally {
      db.close();
    }
  });

  it("records explicit human clear and lazy expiry without erasing history", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    let now = new Date("2026-08-08T18:00:00.000Z");
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => now,
        authorizeTtlMinutes: () => 15,
      });
      const hold = store.create(humanInput());
      store.clear({
        decisionId: hold["decisionId"],
        actorSession: "orch-lead@rig",
        identityProvenance: "transport:v1",
        reason: "atomic step completed",
      });
      expect(store.list({ sessionName: SEAT })[0]).toMatchObject({
        active: false,
        releaseKind: "cleared",
        releasedBySession: "orch-lead@rig",
        releaseIdentityProvenance: "transport:v1",
        releaseReason: "atomic step completed",
      });

      store.create(humanInput({
        generationUuid: "gen-2",
        direction: "authorize",
        automaticReason: "disabled",
        reason: "short-lived one-shot",
      }));
      now = new Date("2026-08-08T18:16:00.000Z");
      const expired = store.list({ sessionName: SEAT }).find((row) => row["generationUuid"] === "gen-2");
      expect(expired).toMatchObject({ active: false, releaseKind: "expired" });
    } finally {
      db.close();
    }
  });

  it("refuses anonymous, reasonless, and blanket decisions loudly", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      expect(() => store.create(humanInput({ actorSession: "" }))).toThrow(/actor|required|attribut/i);
      expect(() => store.create(humanInput({ reason: "  " }))).toThrow(/reason|required/i);
      expect(() => store.create(humanInput({
        generationUuid: "gen-blanket",
        direction: "authorize",
        automaticReason: undefined,
        reason: "ignore refusals",
      }))).toThrow(/automatic reason|required|blanket/i);
    } finally {
      db.close();
    }
  });
});

const BASE_POLICY = {
  enabled: true,
  thresholdPercent: 80,
  preCompactInstruction: "prepare",
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
  postRestoreAuditInstruction: "audit",
  authorizeTtlMinutes: 15,
};

function settings(policy: Record<string, unknown> = BASE_POLICY) {
  return { resolveClaudeCompactionPolicy: () => policy } as never;
}

function transport() {
  const send = vi.fn(async () => ({ ok: true as const }));
  return { send, value: { send } as unknown as SessionTransport };
}

function decisionHarness(opts: {
  hold?: (generation: string | null) => Record<string, unknown> | null;
  authorizationReason?: string;
} = {}) {
  const findActiveHold = vi.fn((input: { liveGenerationUuid: string | null }) =>
    opts.hold?.(input.liveGenerationUuid) ?? null);
  const findMatchingAuthorization = vi.fn((input: { automaticReason: string }) =>
    input.automaticReason === opts.authorizationReason
      ? { decisionId: "authorize-1", automaticReason: input.automaticReason }
      : null);
  return {
    findActiveHold,
    findMatchingAuthorization,
    observeHold: vi.fn(),
    consumeAuthorizationForAttempt: vi.fn(() => true),
    recordAuthorizationAttempt: vi.fn(),
  };
}

const highInput = (usedPercentage = 90): EnforcerInput => ({
  sessionName: SEAT,
  runtime: "claude-code",
  usedPercentage,
  transcriptPath: "/tmp/claude.jsonl",
});

describe("W4 ClaudeCompactionEnforcer decision consumption", () => {
  it("a hold prevents firing and reports human_hold durably", async () => {
    const tx = transport();
    const decisions = decisionHarness({ hold: () => ({ decisionId: "hold-1" }) });
    const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
      resolveOccupantGeneration: () => "gen-1",
      decisionStore: decisions,
    } as never);

    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
      triggered: false,
      reason: "human_hold",
      decisionId: "hold-1",
    });
    expect(tx.send).not.toHaveBeenCalled();
    expect(decisions.observeHold).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: "hold-1",
      outcome: "human_hold",
    }));
  });

  it("a null live generation fails closed on a hold, then known N+1 makes the N hold inert", async () => {
    const tx = transport();
    let liveGeneration: string | null = null;
    const decisions = decisionHarness({
      hold: (generation) => generation === null ? { decisionId: "hold-N" } : null,
    });
    const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
      resolveOccupantGeneration: () => liveGeneration,
      decisionStore: decisions,
    } as never);

    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
      triggered: false,
      reason: "human_hold",
      decisionId: "hold-N",
    });
    liveGeneration = "gen-N+1";
    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({ triggered: true });
    expect(tx.send).toHaveBeenCalledTimes(1);
  });

  it("matches a persisted generation-N hold and makes it inert for generation N+1", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const hold = store.create(humanInput({ generationUuid: "gen-N" }));
      const tx = transport();
      let liveGeneration = "gen-N";
      const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
        resolveOccupantGeneration: () => liveGeneration,
        decisionStore: store,
      } as never);

      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: false,
        reason: "human_hold",
        decisionId: hold["decisionId"],
      });
      expect(tx.send).not.toHaveBeenCalled();

      liveGeneration = "gen-N+1";
      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({ triggered: true });
      expect(tx.send).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("rechecks the real hold store after manual preparation and before the final action", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      let hold: Record<string, unknown> | null = null;
      const delivered: string[] = [];
      const send = vi.fn(async (
        _sessionName: string,
        message: string,
        opts?: { beforeSend?: () => Promise<{ reason: string; error?: string } | null> },
      ) => {
        if (send.mock.calls.length === 1) {
          hold = store.create(humanInput({
            generationUuid: "gen-N",
            reason: "hold activated during manual preparation",
          }));
        }
        const refusal = await opts?.beforeSend?.();
        if (refusal) return { ok: false as const, sessionName: SEAT, sent: false, ...refusal };
        delivered.push(message);
        return { ok: true as const };
      });
      const enforcer = new ClaudeCompactionEnforcer(settings(), { send } as never, {
        resolveOccupantGeneration: () => "gen-N",
        decisionStore: store,
      } as never);

      await expect(enforcer.triggerManualCompact(highInput(), { operatorInitiated: true })).resolves.toEqual({
        triggered: false,
        stage: "skipped-or-failed",
        reason: "human_hold",
        decisionId: expect.any(String),
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("automatic compaction preparation");
      expect(hold).not.toBeNull();
      expect(store.list({ sessionName: SEAT })).toContainEqual(expect.objectContaining({
        decisionId: hold?.["decisionId"],
        active: true,
        lastObservedOutcome: "human_hold",
        lastObservedAt: "2026-08-08T18:00:00.000Z",
      }));
    } finally {
      db.close();
    }
  });

  it("consumes a persisted authorization only for matching known generation N and only once", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const authorization = store.create(humanInput({
        generationUuid: "gen-N",
        direction: "authorize",
        automaticReason: "disabled",
        reason: "lift disabled once for generation N",
      }));
      const row = () => store.list({ sessionName: SEAT }).find(
        (candidate) => candidate["decisionId"] === authorization["decisionId"],
      );
      const tx = transport();
      let liveGeneration: string | null = null;
      const enforcer = new ClaudeCompactionEnforcer(
        settings({ ...BASE_POLICY, enabled: false }),
        tx.value,
        {
          resolveOccupantGeneration: () => liveGeneration,
          decisionStore: store,
        } as never,
      );

      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: false,
        reason: "disabled",
      });
      expect(row()).toMatchObject({ active: true });
      expect(row()?.["consumedAt"] ?? null).toBeNull();
      expect(tx.send).not.toHaveBeenCalled();

      liveGeneration = "gen-N+1";
      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: false,
        reason: "disabled",
      });
      expect(row()).toMatchObject({ active: true });
      expect(row()?.["consumedAt"] ?? null).toBeNull();
      expect(tx.send).not.toHaveBeenCalled();

      liveGeneration = "gen-N";
      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: true,
        decisionId: authorization["decisionId"],
        liftedReason: "disabled",
      });
      expect(row()).toMatchObject({ active: true });
      expect(row()?.["consumedAt"] ?? null).toBeNull();
      expect(tx.send).toHaveBeenCalledTimes(1);
      expect(tx.send.mock.calls[0]?.[1]).toContain("automatic compaction preparation");

      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: true,
        decisionId: authorization["decisionId"],
        liftedReason: "disabled",
      });
      expect(row()).toMatchObject({
        active: false,
        consumedByEnforcerKind: KIND,
        liftedReason: "disabled",
        attemptOutcome: "succeeded",
      });
      expect(tx.send).toHaveBeenCalledTimes(2);
      expect(tx.send.mock.calls[1]?.[1]).toMatch(/^\/compact/);

      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: false,
        reason: "disabled",
      });
      expect(tx.send).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it("lifts disabled once and reports decisionId + liftedReason on the triggered outcome", async () => {
    const tx = transport();
    const decisions = decisionHarness({ authorizationReason: "disabled" });
    const enforcer = new ClaudeCompactionEnforcer(
      settings({ ...BASE_POLICY, enabled: false }),
      tx.value,
      {
        resolveOccupantGeneration: () => "gen-1",
        decisionStore: decisions,
      } as never,
    );

    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
      triggered: true,
      decisionId: "authorize-1",
      liftedReason: "disabled",
    });
    expect(tx.send).toHaveBeenCalledTimes(1);
    expect(decisions.consumeAuthorizationForAttempt).not.toHaveBeenCalled();

    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
      triggered: true,
      decisionId: "authorize-1",
      liftedReason: "disabled",
    });
    expect(tx.send).toHaveBeenCalledTimes(2);
    expect(decisions.consumeAuthorizationForAttempt).toHaveBeenCalledTimes(1);
    expect(decisions.recordAuthorizationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: "authorize-1",
      outcome: "succeeded",
    }));
  });

  it("does not consume authorization when its reason is not the refusal that releases a send", async () => {
    const tx = transport();
    const decisions = decisionHarness({ authorizationReason: "disabled" });
    const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
      resolveOccupantGeneration: () => "gen-1",
      decisionStore: decisions,
    } as never);

    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({ triggered: true });
    expect(tx.send).toHaveBeenCalledTimes(1);
    expect(decisions.consumeAuthorizationForAttempt).not.toHaveBeenCalled();
  });

  it("lifts post_restore_cooldown for one send attempt", async () => {
    const tx = transport();
    const decisions = decisionHarness({ authorizationReason: "post_restore_cooldown" });
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
        dedupWindowMs: 0,
        postCompactRestoreCooldownMs: 60_000,
        openrigHome: "/tmp/openrig-w4",
        resolveOccupantGeneration: () => "gen-1",
        decisionStore: decisions,
      } as never);

      await enforcer.maybeAutoCompact(highInput());
      now += 1_000;
      await enforcer.maybeAutoCompact(highInput());
      for (let i = 0; i < 3; i += 1) {
        now += 1_000;
        await enforcer.maybeAutoCompact(highInput(20));
      }
      now += 1_000;
      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: true,
        decisionId: "authorize-1",
        liftedReason: "post_restore_cooldown",
      });
      expect(decisions.consumeAuthorizationForAttempt).not.toHaveBeenCalled();
      now += 1_000;
      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: true,
        decisionId: "authorize-1",
        liftedReason: "post_restore_cooldown",
      });
      expect(decisions.consumeAuthorizationForAttempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("checks stale_generation authorization before deleting the queued stage", async () => {
    const tx = transport();
    const decisions = decisionHarness({ authorizationReason: "stale_generation" });
    let generation = "gen-N";
    const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
      dedupWindowMs: 0,
      postCompactRestoreCooldownMs: 0,
      openrigHome: "/tmp/openrig-w4",
      resolveOccupantGeneration: () => generation,
      decisionStore: decisions,
    } as never);

    await enforcer.maybeAutoCompact(highInput());
    await enforcer.maybeAutoCompact(highInput());
    generation = "gen-N+1";
    await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual({
      triggered: true,
      decisionId: "authorize-1",
      liftedReason: "stale_generation",
    });
    expect(tx.send.mock.calls.at(-1)?.[1]).toContain("post-compaction turn boundary");
    expect(decisions.consumeAuthorizationForAttempt).toHaveBeenCalledTimes(1);
  });

  it("carries one real stale_generation authorization through the inherited restore occurrence", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const tx = transport();
      let generation = "gen-N";
      const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
        dedupWindowMs: 0,
        postCompactRestoreCooldownMs: 0,
        openrigHome: "/tmp/openrig-w4",
        resolveOccupantGeneration: () => generation,
        decisionStore: store,
      } as never);

      await enforcer.maybeAutoCompact(highInput());
      await enforcer.maybeAutoCompact(highInput());
      generation = "gen-N+1";
      const authorization = store.create(humanInput({
        generationUuid: generation,
        direction: "authorize",
        automaticReason: "stale_generation",
        reason: "allow the inherited restore occurrence once",
      }));
      const lifted = {
        triggered: true,
        decisionId: authorization["decisionId"],
        liftedReason: "stale_generation",
      };

      await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual(lifted);
      await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual(lifted);
      await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual(lifted);

      expect(tx.send).toHaveBeenCalledTimes(5);
      expect(tx.send.mock.calls[2]?.[1]).toContain("post-compaction turn boundary");
      expect(tx.send.mock.calls[3]?.[1]).toContain("restoring this Claude session");
      expect(tx.send.mock.calls[4]?.[1]).toContain("audit your compaction restore");
      expect(store.list({ sessionName: SEAT })).toContainEqual(expect.objectContaining({
        decisionId: authorization["decisionId"],
        active: false,
        consumedByEnforcerKind: KIND,
        liftedReason: "stale_generation",
        attemptOutcome: "succeeded",
      }));

      await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual({
        triggered: false,
        reason: "below_threshold",
      });
      expect(tx.send).toHaveBeenCalledTimes(5);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      failure: "result-false",
      failNextSend: (send: ReturnType<typeof vi.fn>) => send.mockResolvedValueOnce({
        ok: false as const,
        reason: "boundary refused",
      }),
      failureReason: "boundary refused",
    },
    {
      failure: "thrown",
      failNextSend: (send: ReturnType<typeof vi.fn>) => send.mockRejectedValueOnce(
        new Error("boundary exploded"),
      ),
      failureReason: "boundary exploded",
    },
  ])("clears a failed real stale_generation carry after a $failure send", async ({
    failNextSend,
    failureReason,
  }) => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const tx = transport();
      let generation = "gen-N";
      const enforcer = new ClaudeCompactionEnforcer(settings(), tx.value, {
        dedupWindowMs: 0,
        postCompactRestoreCooldownMs: 0,
        openrigHome: "/tmp/openrig-w4",
        resolveOccupantGeneration: () => generation,
        decisionStore: store,
      } as never);

      await enforcer.maybeAutoCompact(highInput());
      await enforcer.maybeAutoCompact(highInput());
      generation = "gen-N+1";
      const authorization = store.create(humanInput({
        generationUuid: generation,
        direction: "authorize",
        automaticReason: "stale_generation",
        reason: "allow one inherited boundary attempt",
      }));
      failNextSend(tx.send);

      await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual({
        triggered: false,
        reason: "send_failed",
      });
      expect(tx.send).toHaveBeenCalledTimes(3);
      expect(store.list({ sessionName: SEAT })).toContainEqual(expect.objectContaining({
        decisionId: authorization["decisionId"],
        active: false,
        consumedByEnforcerKind: KIND,
        liftedReason: "stale_generation",
        attemptOutcome: "failed",
        attemptFailureReason: failureReason,
      }));

      await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual({
        triggered: false,
        reason: "stale_generation",
      });
      await expect(enforcer.maybeAutoCompact(highInput(20))).resolves.toEqual({
        triggered: false,
        reason: "below_threshold",
      });
      expect(tx.send).toHaveBeenCalledTimes(3);
    } finally {
      db.close();
    }
  });

  it("consumes authorization on a failed compact attempt and records the actual failure", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: false as const, reason: "send_failed" });
    const decisions = decisionHarness({ authorizationReason: "disabled" });
    const enforcer = new ClaudeCompactionEnforcer(
      settings({ ...BASE_POLICY, enabled: false }),
      { send } as unknown as SessionTransport,
      {
        resolveOccupantGeneration: () => "gen-1",
        decisionStore: decisions,
      } as never,
    );

    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
      triggered: true,
      decisionId: "authorize-1",
      liftedReason: "disabled",
    });
    expect(decisions.consumeAuthorizationForAttempt).not.toHaveBeenCalled();

    await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
      triggered: false,
      reason: "send_failed",
    });
    expect(decisions.consumeAuthorizationForAttempt).toHaveBeenCalledTimes(1);
    expect(decisions.recordAuthorizationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: "authorize-1",
      outcome: "failed",
      failureReason: "send_failed",
    }));
  });

  it("records a thrown authorized send as failed and keeps the authorization one-shot", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const db = makeDb();
    try {
      const store = new EnforcerDecisionStore(db, {
        now: () => new Date("2026-08-08T18:00:00.000Z"),
        authorizeTtlMinutes: () => 15,
      });
      const authorization = store.create(humanInput({
        generationUuid: "gen-N",
        direction: "authorize",
        automaticReason: "disabled",
        reason: "allow one attempted send",
      }));
      const send = vi.fn()
        .mockResolvedValueOnce({ ok: true as const })
        .mockRejectedValueOnce(new Error("transport exploded"));
      const enforcer = new ClaudeCompactionEnforcer(
        settings({ ...BASE_POLICY, enabled: false }),
        { send } as unknown as SessionTransport,
        {
          resolveOccupantGeneration: () => "gen-N",
          decisionStore: store,
        } as never,
      );

      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: true,
        decisionId: authorization["decisionId"],
        liftedReason: "disabled",
      });
      expect(store.list({ sessionName: SEAT })).toContainEqual(expect.objectContaining({
        decisionId: authorization["decisionId"],
        active: true,
        consumedAt: null,
      }));

      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: false,
        reason: "send_failed",
      });
      expect(store.list({ sessionName: SEAT })).toContainEqual(expect.objectContaining({
        decisionId: authorization["decisionId"],
        active: false,
        consumedByEnforcerKind: KIND,
        liftedReason: "disabled",
        attemptOutcome: "failed",
        attemptFailureReason: "transport exploded",
      }));

      await expect(enforcer.maybeAutoCompact(highInput())).resolves.toEqual({
        triggered: false,
        reason: "disabled",
      });
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });
});
