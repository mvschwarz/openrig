import { describe, it, expect, vi, beforeEach } from "vitest";

// 51-04 step-3 — the daemon-standup OPT-IN seam at runScenarioFile. Container-mode is a
// PURELY ADDITIVE opt-in: when the caller supplies no `daemon` spawner, the host-mode
// path is byte-identical to pre-51-04 (spawnScenarioDaemon with { rigBin }); when it
// supplies one, that override is used instead. This suite pins BOTH halves of that
// contract — the fence that keeps the 51-02 host-mode contract byte-intact (no PM gate).
//
// Isolated in its own file so the scenario-daemon module-mock (below) cannot contaminate
// the other scenario-* suites.

const { spawnScenarioDaemon } = vi.hoisted(() => ({ spawnScenarioDaemon: vi.fn() }));
vi.mock("./helpers/scenario-daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers/scenario-daemon.js")>();
  return { ...actual, spawnScenarioDaemon };
});

import {
  defaultHostDaemon,
  resolveScenarioDaemonSpawner,
  type ScenarioDaemonSpawner,
  type RunScenarioFileOptions,
} from "./helpers/scenario-pipeline.js";
import type { HermeticScaffold } from "./helpers/hermetic-env.js";
import type { ScenarioDaemon } from "./helpers/scenario-daemon.js";

const FAKE_DAEMON = { port: 1 } as unknown as ScenarioDaemon;
const scaffold = { root: "/scratch", env: {} } as unknown as HermeticScaffold;

beforeEach(() => {
  spawnScenarioDaemon.mockReset();
  spawnScenarioDaemon.mockResolvedValue(FAKE_DAEMON);
});

describe("defaultHostDaemon — the unchanged host-mode standup", () => {
  it("forwards to spawnScenarioDaemon with exactly { rigBin } (byte-identical to line 195)", async () => {
    const opts: RunScenarioFileOptions = { rigBin: "/path/to/rig" };
    const daemon = await defaultHostDaemon(scaffold, opts);
    expect(spawnScenarioDaemon).toHaveBeenCalledTimes(1);
    expect(spawnScenarioDaemon).toHaveBeenCalledWith(scaffold, { rigBin: "/path/to/rig" });
    expect(daemon).toBe(FAKE_DAEMON);
  });
});

describe("resolveScenarioDaemonSpawner — the additive opt-in selection", () => {
  it("returns the host-mode default when no `daemon` override is supplied (fence)", () => {
    expect(resolveScenarioDaemonSpawner({ rigBin: "x" })).toBe(defaultHostDaemon);
  });

  it("returns the caller's override when one is supplied (container-mode opt-in)", () => {
    const override: ScenarioDaemonSpawner = async () => FAKE_DAEMON;
    expect(resolveScenarioDaemonSpawner({ rigBin: "x", daemon: override })).toBe(override);
  });

  it("does not invoke the host-mode spawner merely by resolving an override", () => {
    const override: ScenarioDaemonSpawner = async () => FAKE_DAEMON;
    resolveScenarioDaemonSpawner({ rigBin: "x", daemon: override });
    expect(spawnScenarioDaemon).not.toHaveBeenCalled();
  });
});
