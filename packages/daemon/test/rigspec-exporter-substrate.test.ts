import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import type { RigSpec } from "../src/domain/types.js";

/** Export of a seat's terminal substrate (PR #2785 review): a Herdr seat is always pinned; a tmux seat is pinned only
 *  when this host's default isn't tmux, so re-importing on that host can't move it. */
describe("RigSpecExporter terminal substrate", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  function exportMixed() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("mixed");
    const pod = podRepo.createPod(rig.id, "dev", "Dev", {});
    rigRepo.addNode(rig.id, "dev.old", { runtime: "terminal", podId: pod.id, agentRef: "builtin:terminal", profile: "none", cwd: "." });
    rigRepo.addNode(rig.id, "dev.new", { runtime: "terminal", podId: pod.id, agentRef: "builtin:terminal", profile: "none", cwd: ".", terminalSubstrate: "herdr" });
    const spec = new RigSpecExporter({ rigRepo, sessionRegistry: new SessionRegistry(db), podRepo }).exportRig(rig.id) as RigSpec;
    const members = Object.fromEntries(spec.pods[0]!.members.map(m => [m.id, m.terminalSubstrate]));
    db.close();
    return members;
  }

  it("on a tmux-default host, pins Herdr seats only (tmux exports stay as before)", () => {
    vi.stubEnv("OPENRIG_TERMINAL_SUBSTRATE", "tmux");
    expect(exportMixed()).toEqual({ old: undefined, new: "herdr" });
  });

  it("on a herdr-default host, also pins tmux seats so a re-import keeps them on tmux", () => {
    vi.stubEnv("OPENRIG_TERMINAL_SUBSTRATE", "herdr");
    expect(exportMixed()).toEqual({ old: "tmux", new: "herdr" });
  });
});
