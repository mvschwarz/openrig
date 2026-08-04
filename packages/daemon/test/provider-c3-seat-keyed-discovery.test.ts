// Slice-04 (OPR.0.5.0.4) C3 — PRODUCTION-ALTITUDE pin for the Claude provider_usage discovery
// (PM Option A, per-SEAT). This SUPERSEDES the helper-only false-green (provider-service-impl.test.ts
// "surfaces ... from the collectClaudeSignals dep" + provider-claude-usage-reader.test.ts hand-fed
// account/cache stubs), which greened seat-keyed-unknown WITHOUT exercising production discovery.
//
// The contract (Option A): a LIVE claude-code node-inventory seat with NO (or absent/malformed)
// provider_usage cache must still emit a SEAT-keyed EXPLICIT unknown row — discovery is
// node-inventory-driven, NOT cache-parse-dependent. Driven through the REAL ProviderServiceImpl
// .getReadModel (the sealed C1 surface), never an injected signal.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { spawnSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { collectClaudeSignalsFromProviderUsageDirectory } from "../src/domain/provider/claude-usage-reader.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function emptyCodexHomeEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-c3-codex-"));
  return { CODEX_HOME: home } as NodeJS.ProcessEnv;
}

/** Seed a live claude-code seat into node-inventory (rig + pod + node + running session/binding). */
function seedClaudeSeat(db: Database.Database, sessionName = "dev-impl@test-rig") {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
  db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", "rig-1", "dev", "Dev");
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile, resolved_spec_name, resolved_spec_version, resolved_spec_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("node-1", "rig-1", "dev.impl", "claude-code", "/project", "pod-1", "local:agents/impl", "default", "impl", "1.0.0", "abc123");
  db.prepare(
    "INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)"
  ).run("sess-node-1", "node-1", sessionName, "running", "ready");
  db.prepare("INSERT OR REPLACE INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run("bind-node-1", "node-1", sessionName);
}

describe("Slice-04 C3 — seat-keyed Claude provider_usage discovery (production-altitude, PM Option A)", () => {
  it("a live claude-code seat with NO provider_usage cache yields a SEAT-keyed explicit-unknown via real getReadModel", async () => {
    const db = createFullTestDb();
    seedClaudeSeat(db);
    // collectClaudeSignals (the cache lane) is intentionally NOT provided — cache absent. Discovery
    // must still emit the seat-keyed unknown from node-inventory. Real getReadModel, C1 surface unchanged.
    const svc = new ProviderServiceImpl({ db, listRigs: () => [{ id: "rig-1" }], env: emptyCodexHomeEnv(), now: () => ASOF });
    const model = await svc.getReadModel();

    const claude = model.signals.filter((s) => s.provider === "claude");
    expect(claude.length, `expected exactly one seat-keyed Claude unknown row; got ${JSON.stringify(model.signals)}`).toBe(1);
    const sig = claude[0]! as Record<string, unknown>;
    expect(sig["seatSession"], "Option A: SEAT-keyed").toBe("dev-impl@test-rig");
    expect(sig["accountRef"], "Option A: NO fabricated account identity").toBeUndefined();
    expect(sig["sourceClass"]).toBe("unknown");
    expect(sig["authority"]).toBe("unknown");
    expect(sig["automationUse"]).toBe("do_not_automate");
    expect(sig["usedPercent"], "never a fabricated zero").toBeUndefined();
  });

  it("no claude-code seats (empty inventory) → no Claude signals (never a fabricated row)", async () => {
    const db = createFullTestDb();
    const svc = new ProviderServiceImpl({ db, listRigs: () => [], env: emptyCodexHomeEnv(), now: () => ASOF });
    const model = await svc.getReadModel();
    expect(model.signals.filter((s) => s.provider === "claude")).toEqual([]);
  });

  it("composes the shipped collector and production cache reader through real getReadModel", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-c3-altitude-"));
    try {
      const contextDir = nodePath.join(root, "context");
      const usageDir = nodePath.join(root, "provider-usage");
      const seatSession = "dev-impl@test-rig";
      const collectorPath = nodePath.join(import.meta.dirname, "../assets/claude-statusline-context.cjs");
      const result = spawnSync(process.execPath, [collectorPath, contextDir, usageDir], {
        encoding: "utf-8",
        input: JSON.stringify({
          session_id: "sess-123",
          session_name: seatSession,
          context_window: { context_window_size: 200_000, used_percentage: 10 },
          rate_limits: {
            five_hour: { used_percentage: 0, resets_at: "2026-08-04T05:00:00.000Z" },
            seven_day: { used_percentage: 7, resets_at: "2026-08-10T00:00:00.000Z" },
          },
        }),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(nodePath.join(usageDir, `${seatSession}.json`))).toBe(true);

      const db = createFullTestDb();
      seedClaudeSeat(db, seatSession);
      const svc = new ProviderServiceImpl({
        db,
        listRigs: () => [{ id: "rig-1" }],
        env: emptyCodexHomeEnv(),
        now: () => ASOF,
        collectClaudeSignals: () => collectClaudeSignalsFromProviderUsageDirectory(usageDir, () => ASOF),
      });
      const model = await svc.getReadModel();
      const claude = model.signals.filter((signal) => signal.provider === "claude");

      expect(claude).toHaveLength(2);
      expect(claude.map((signal) => signal.window).sort()).toEqual(["five_hour", "weekly"]);
      expect(claude.find((signal) => signal.window === "five_hour")?.usedPercent).toBe(0);
      expect(claude.every((signal) => signal.seatSession === seatSession && signal.accountRef === undefined)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
