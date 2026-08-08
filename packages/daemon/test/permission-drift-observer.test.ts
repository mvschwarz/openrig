import { describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";
import { ClaudePermissionModeCache, PermissionDriftObserver } from "../src/domain/permission-drift-observer.js";

describe("PermissionDriftObserver", () => {
  it("reads only the exact current generation and runtime-native effective surface", () => {
    const db = createFullTestDb();
    try {
      const rigs = new RigRepository(db);
      const sessions = new SessionRegistry(db);
      const rig = rigs.createRig("observer-rig");
      const node = rigs.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/project" });
      sessions.registerClaimedSession(node.id, "dev-impl@observer-rig");
      const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
      new AppliedLaunchObservationStore(db).recordGeneration(generation, observeClaudePermission("--permission-mode acceptEdits"));
      const readFile = vi.fn(() => JSON.stringify({ permissions: { defaultMode: "manual", allow: [], ask: [], deny: [] } }));
      const observer = new PermissionDriftObserver({
        db,
        fs: {
          readFile,
          cwdReadable: () => true,
          commandAvailable: () => true,
          claudePermissionModes: () => ["acceptEdits", "manual"],
        },
        now: () => new Date("2026-08-08T00:00:00.000Z"),
      });

      expect(observer.diagnose(node.id)).toMatchObject({
        transport: { state: "healthy" },
        cwdRead: { state: "visible" },
        commandPath: { state: "available" },
        enforcement: {
          axis: "permission",
          state: "drift",
          expected: "acceptEdits",
          effective: { defaultMode: "manual" },
          sourcePath: "/work/project/.claude/settings.local.json",
        },
      });
      expect(readFile).toHaveBeenCalledWith("/work/project/.claude/settings.local.json");
    } finally {
      db.close();
    }
  });

  it("never blocks a request on a cold or slow Claude help process", async () => {
    let resolve!: (modes: string[] | null) => void;
    const cache = new ClaudePermissionModeCache(() => new Promise((done) => { resolve = done; }));
    cache.warm();
    expect(cache.read()).toBeNull();
    resolve(["acceptEdits", "manual"]);
    await vi.waitFor(() => expect(cache.read()).toEqual(["acceptEdits", "manual"]));
  });

  it("refreshes harness vocabulary asynchronously after its cache expires", async () => {
    let now = 1;
    let modes = ["acceptEdits", "manual"];
    const load = vi.fn(async () => modes);
    const cache = new ClaudePermissionModeCache(load, 10, () => now);
    cache.warm();
    await vi.waitFor(() => expect(cache.read()).toEqual(["acceptEdits", "manual"]));

    modes = ["acceptEdits", "manual", "futureMode"];
    now = 12;
    expect(cache.read()).toEqual(["acceptEdits", "manual"]);
    await vi.waitFor(() => expect(cache.read()).toEqual(["acceptEdits", "manual", "futureMode"]));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
