import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";

describe("Claude configured budget telemetry", () => {
  let dir: string;
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  afterAll(() => { db.close(); });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "configured-context-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function collect(budget = "200000", current: unknown = {
    input_tokens: 10000, cache_read_input_tokens: 90000,
    cache_creation_input_tokens: 50000, output_tokens: 20000,
  }, window = 1000000) {
    const path = join(dir, "sample.json");
    execFileSync(process.execPath, [join(import.meta.dirname, "../assets/claude-statusline-context.cjs"), path], {
      env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: budget, OPENRIG_OCCUPANT_GENERATION: "generation-1" },
      input: JSON.stringify({ session_name: "dev-lead@test", session_id: "native-1", context_window: {
        used_percentage: 15, remaining_percentage: 85, context_window_size: window, current_usage: current,
      } }),
    });
    return JSON.parse(readFileSync(path, "utf8"));
  }

  it("carries an input-only budget percentage through collection and storage without changing raw usage", () => {
    const store = new ContextUsageStore(db, { stateDir: dir });
    const repo = new RigRepository(db);
    const rig = repo.createRig("budget-roundtrip");
    const node = repo.addNode(rig.id, "dev.lead", { runtime: "claude-code" });
    const usage = store.normalizeSample(collect());
    store.persist(node.id, usage);
    const restored = store.getForNode(node.id, "dev-lead@test");
    expect(restored.usedPercentage).toBe(15);
    expect(restored.remainingPercentage).toBe(85);
    expect(restored.configuredBudget).toEqual({ tokens: 200000, usedPercentage: 75, source: "CLAUDE_CODE_AUTO_COMPACT_WINDOW" });
    expect(restored.fresh).toBe(true);
    expect(store.getForNode(node.id, "another-session").configuredBudget ?? null).toBeNull();
    const old = collect();
    old.sampled_at = "2020-01-01T00:00:00.000Z";
    store.persist(node.id, store.normalizeSample(old));
    expect(store.getForNode(node.id, "dev-lead@test").fresh).toBe(false);
    const successor = new ContextUsageStore(db, { stateDir: dir, resolveOccupantBootAt: () => new Date().toISOString(), resolveOccupantGeneration: () => "generation-2" });
    expect(successor.getForNode(node.id, "dev-lead@test").configuredBudget ?? null).toBeNull();
  });

  it.each(["", "auto", "garbage", "200k", "200", "99999", "1000001", "200000junk"])("does not guess a budget for unsupported value %s", value => {
    const store = new ContextUsageStore(db, { stateDir: dir });
    expect(store.normalizeSample(collect(value)).configuredBudget ?? null).toBeNull();
  });

  it("caps the configured budget at the model window without subtracting a reserve", () => {
    const store = new ContextUsageStore(db, { stateDir: dir });
    expect(store.normalizeSample(collect("500000", { input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 200000)).configuredBudget)
      .toEqual({ tokens: 200000, usedPercentage: 75, source: "CLAUDE_CODE_AUTO_COMPACT_WINDOW" });
  });

  it.each([null, {}, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { input_tokens: -1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }])("keeps the percentage unknown for empty or invalid current usage", current => {
    const store = new ContextUsageStore(db, { stateDir: dir });
    expect(store.normalizeSample(collect("200000", current)).configuredBudget)
      .toEqual({ tokens: 200000, usedPercentage: null, source: "CLAUDE_CODE_AUTO_COMPACT_WINDOW" });
  });
});
