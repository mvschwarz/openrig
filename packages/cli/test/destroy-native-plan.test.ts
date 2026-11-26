import { expect, it } from "vitest";
import { buildDestroyPlan, isWithinPath } from "../src/destroy-helpers.js";

it.runIf(process.platform === "win32")("plans native state children once and retains distinct external targets", () => {
  const stateRoot = "C:\\Owned\\.openrig";
  const config = { stateRoot, dbPath: "c:/owned/.openrig/db/openrig.sqlite", transcriptsPath: "C:\\Owned\\.openrig\\transcripts", daemonHost: "127.0.0.1", daemonPort: 7433 };
  const deps = { exists: () => true, listManagedTmuxSessions: () => { throw new Error("state-only planning must not enumerate sessions"); }, now: () => new Date(0) };
  const plan = buildDestroyPlan("state", false, config, deps);
  expect(plan.targets).toEqual([{ path: stateRoot, kind: "state_root" }]);
  expect(plan.warnings).toEqual([]);
  expect(isWithinPath("C:\\Owned\\.openrig\\..\\other", stateRoot)).toBe(false);
  expect(isWithinPath("C:\\Owned\\.openrig-neighbor\\file", stateRoot)).toBe(false);
  expect(isWithinPath("D:\\Owned\\.openrig\\file", stateRoot)).toBe(false);
  expect(isWithinPath("c:/owned/.openrig/", stateRoot)).toBe(true);
  const external = buildDestroyPlan("state", false, { ...config, dbPath: "D:\\Owned\\db.sqlite", transcriptsPath: "C:\\Owned\\.openrig-neighbor\\transcripts" }, deps);
  expect(external.targets.map(t => t.kind)).toEqual(["state_root", "db_file", "db_shm", "db_wal", "transcripts_dir"]);
  expect(external.warnings).toHaveLength(4);
});
