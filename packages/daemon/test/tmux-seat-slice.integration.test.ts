// Per-rig seat grouping on a real host (#80): the synthetic suite (tmux-seat-slice.test.ts) pins the commands the adapter
// runs; this one checks where the processes really are. Through TmuxAdapter.createSession on a private tmux server:
//   - rig it80-<tag>-alpha (seat_slice: rig) with three seats, one with tasks_max and memory_max, two without;
//   - rig it80-<tag>-beta (seat_slice: rig) with one seat, with tasks_max;
//   - a rig without the setting: one seat with tasks_max, one without (today's paths);
//   - rig it80-<tag>-masked (seat_slice: rig) whose slice the test masks, so the user manager refuses the grouped scope: one
//     seat with tasks_max, one without (grouping not applied: today's paths, the limit kept).
// Each pane's process must be in the right cgroup: openrigseats.slice/openrigseats-<rig>.slice/openrig-seat-*.scope for a
// grouped seat, with every requested limit read back; openrigseats.slice/openrig-seat-*.scope for an ungrouped seat with
// a limit; outside openrigseats.slice (the tmux server's cgroup, or tmux's own per-pane scope) for an ungrouped seat
// without one. OpenRig sets no CPU weight: the rig slice reads
// the default, then the weight a user sets on it with `systemctl --user set-property --runtime` reads back.
//
// Opt-in, and skipped (never passed) unless all of these hold: Linux, OPENRIG_TEST_SEAT_SCOPE=1, a systemd user manager
// that answers through XDG_RUNTIME_DIR (or /run/user/<uid>), cgroup v2 and tmux on PATH. It creates real transient units
// under the user manager; run it as tmux-seat-process-limits.integration.test.ts says (an outer scope with its own
// TasksMax and MemoryMax, TMUX, TMUX_PANE and MANAGERPID unset):
//
//   systemd-run --user --scope -p TasksMax=2000 -p MemoryMax=4G env -u TMUX -u TMUX_PANE -u MANAGERPID \
//     OPENRIG_TEST_SEAT_SCOPE=1 npx vitest run test/tmux-seat-slice.integration.test.ts
//
// Each run's rig names carry a random tag, and the test first checks that the user manager knows none of their slices.
// Cleanup touches only what the run made: the private socket's server, the seat scopes it saw, the rig slices a scope of
// its own was seen in, the runtime weight it set (systemctl revert) and the runtime mask it set (unmask).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxAdapter, SEAT_SCOPE_SLICE, cgroupV2Path, type SeatProcessLimits, type TmuxResult } from "../src/adapters/tmux.js";
import { rigSeatSlice } from "../src/adapters/seat-slice.js";
import { execArgvCommand, execTmuxCommand } from "../src/adapters/tmux-exec.js";
import { seatRuntimeDir } from "../src/domain/seat-runtime-dir.js";

const run = promisify(execFile);
const enabled = process.platform === "linux" && process.env.OPENRIG_TEST_SEAT_SCOPE === "1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MIB = 1024 * 1024;

async function waitFor<T>(what: string, ms: number, check: () => Promise<T | null> | T | null): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const value = await check();
    if (value !== null) return value;
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

const sliceName = (rig: string) => {
  const slice = rigSeatSlice(rig);
  if (slice.kind !== "slice") throw new Error(slice.reason);
  return slice.name;
};
const re = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Seat = { node: string; rig?: string; limits?: SeatProcessLimits };
// Each run's rigs carry a tag of their own, so their slices are this run's and no other rig's or test run's.
const TAG = randomBytes(4).toString("hex");
const RIGS = { alpha: `it80-${TAG}-alpha`, beta: `it80-${TAG}-beta`, masked: `it80-${TAG}-masked` };
const SEATS: Seat[] = [
  { node: "a1", rig: RIGS.alpha, limits: { tasksMax: 64, memoryMax: 256 * MIB } },
  { node: "a2", rig: RIGS.alpha },
  { node: "a3", rig: RIGS.alpha },
  { node: "b1", rig: RIGS.beta, limits: { tasksMax: 32 } },
  { node: "o1", limits: { tasksMax: 48 } },
  { node: "o2" },
  { node: "m1", rig: RIGS.masked, limits: { tasksMax: 40 } },
  { node: "m2", rig: RIGS.masked },
];

describe.runIf(enabled)("per-rig seat grouping on a real user manager (#80)", () => {
  const saved: Record<string, string | undefined> = {};
  let runtimeDir: string | undefined;
  let skipReason: string | undefined;

  beforeAll(async () => {
    for (const key of ["TMUX", "TMUX_PANE", "MANAGERPID"]) { saved[key] = process.env[key]; delete process.env[key]; }
    const uid = process.getuid?.();
    runtimeDir = seatRuntimeDir(process.env) ?? (uid !== undefined && existsSync(`/run/user/${uid}`) ? `/run/user/${uid}` : undefined);
    if (!runtimeDir) { skipReason = "no XDG_RUNTIME_DIR and no /run/user/<uid>"; return; }
    try {
      await run("/usr/bin/env", ["-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${runtimeDir}`,
        "systemctl", "--user", "show", "--property=Version", "--value"], { timeout: 10_000 });
    } catch (error) { skipReason = `no systemd user manager answers: ${(error as Error).message}`; return; }
    if (!cgroupV2Path(readFileSync("/proc/self/cgroup", "utf8"))) { skipReason = "not cgroup v2"; return; }
    try { await run("tmux", ["-V"], { timeout: 10_000 }); } catch { skipReason = "no tmux on PATH"; }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  it("places each seat beneath its own rig's slice, keeps every limit, and falls back where grouping can't apply", async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const dir = mkdtempSync(join(tmpdir(), "seat-slice-"));
    const sock = join(dir, "s");
    const tmux = (...args: string[]) => run("tmux", ["-f", "/dev/null", "-S", sock, ...args], { timeout: 10_000 })
      .then((result) => result.stdout.trim());
    const systemctl = (...args: string[]) => run("/usr/bin/env", ["-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${runtimeDir}`,
      "systemctl", "--user", ...args], { timeout: 10_000 }).then((result) => result.stdout.trim());
    const cgroupOf = (pid: number | string) => cgroupV2Path(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
    const scopes: string[] = [];
    const alpha = sliceName(RIGS.alpha);
    const masked = sliceName(RIGS.masked);
    // Cleanup touches only what this run made: slices a scope of this run was seen in, the mask and the weight it set.
    const ownedSlices = new Set<string>();
    let weightSet = false;
    let maskSet = false;
    try {
      // This run's slices must be unused: inactive, with no unit file, drop-in or mask. One the user manager already
      // runs or has configuration for is not this run's to change or stop. (Any slice name reads as loaded.)
      for (const rig of Object.values(RIGS)) {
        const state = await systemctl("show", "--property=ActiveState", "--property=FragmentPath",
          "--property=DropInPaths", "--property=UnitFileState", "--", sliceName(rig));
        expect(state.split("\n").sort(), sliceName(rig))
          .toEqual(["ActiveState=inactive", "DropInPaths=", "FragmentPath=", "UnitFileState="]);
      }
      writeFileSync(join(dir, "seat.sh"), "exec sleep 300\n");
      // The user manager refuses a scope in a masked slice: a real failure of the grouped scope.
      await systemctl("mask", "--runtime", "--", masked);
      maskSet = true;

      const adapter = new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, ["-f", "/dev/null", "-S", sock]);
      adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DBUS_SESSION_BUS_ADDRESS: "disabled:" }, runtimeDir: undefined });
      const byNode = new Map(SEATS.map((seat) => [`it80-${seat.node}`, seat]));
      adapter.seatProcessLimits = (nodeId) => byNode.get(nodeId)?.limits;
      adapter.seatSliceRig = (nodeId) => byNode.get(nodeId)?.rig;

      expect(await adapter.startServer()).toEqual({ ok: true });
      await tmux("set-option", "-g", "default-shell", "/bin/sh");
      await tmux("set-option", "-g", "default-command", `/bin/sh ${dir}/seat.sh`);
      const serverCgroup = cgroupOf(await tmux("display-message", "-p", "#{pid}"))!;

      const results = new Map<string, TmuxResult>();
      for (const seat of SEATS) {
        const name = `it80-${seat.node}@scope`;
        results.set(seat.node, await adapter.createSession(name, dir, { OPENRIG_NODE_ID: `it80-${seat.node}`, OPENRIG_SESSION_NAME: name }));
      }
      const where = new Map<string, string>();
      for (const seat of SEATS) {
        const result = results.get(seat.node)!;
        expect(result, seat.node).toMatchObject({ ok: true });
        const [pane] = await adapter.listPanes(`it80-${seat.node}@scope`);
        // A seat in a scope moves there as its wrapper execs; wait until it has (or, without one, read it once).
        const expectScope = seat.limits !== undefined || (seat.rig !== undefined && seat.rig !== RIGS.masked);
        const path = await waitFor(`${seat.node}'s pane process`, 10_000, async () => {
          const pid = await adapter.getPanePid(pane!.id);
          const p = pid === null ? null : cgroupOf(pid);
          return p && (!expectScope || /\/openrig-seat-[^/]+\.scope$/.test(p)) ? p : null;
        });
        where.set(seat.node, path);
        const scope = /\/(openrig-seat-[^/]+\.scope)$/.exec(path)?.[1];
        if (scope) scopes.push(scope);
        const parent = path.split("/").at(-2);
        if (scope && seat.rig && parent === sliceName(seat.rig)) ownedSlices.add(parent);
      }

      // A seat without a scope stays where tmux put it: the server's cgroup, or the scope of its own that a tmux built with
      // systemd support gives each pane (tmux-spawn-*.scope); never beneath openrigseats.slice.
      const outsideSeatScopes = (path: string) => (path === serverCgroup || /\/tmux-spawn-[^/]+\.scope$/.test(path))
        && !path.includes(`/${SEAT_SCOPE_SLICE}/`);
      const under = (parent: string) => new RegExp(`/${re(parent)}/openrig-seat-it80-[a-z0-9]+_scope-[0-9a-f]{8}\\.scope$`);
      // Grouped: each seat beneath its own rig's slice (nested under openrigseats.slice), with or without a limit.
      for (const node of ["a1", "a2", "a3"]) expect(where.get(node), node).toMatch(under(`${SEAT_SCOPE_SLICE}/${alpha}`));
      expect(where.get("b1")).toMatch(under(`${SEAT_SCOPE_SLICE}/${sliceName(RIGS.beta)}`));
      // Not grouped: today's paths.
      expect(where.get("o1")).toMatch(under(SEAT_SCOPE_SLICE));
      expect(outsideSeatScopes(where.get("o2")!)).toBe(true);
      // Grouping refused by the user manager: today's paths, the limit kept, reported.
      expect(where.get("m1")).toMatch(under(SEAT_SCOPE_SLICE));
      expect(outsideSeatScopes(where.get("m2")!)).toBe(true);
      for (const node of ["m1", "m2"]) {
        expect((results.get(node) as { warnings?: string[] }).warnings?.join("\n"), node).toContain("grouping not applied");
      }
      for (const node of ["a1", "a2", "a3", "b1", "o1", "o2"]) {
        expect((results.get(node) as { warnings?: string[] }).warnings ?? [], node).toEqual([]);
      }

      // Every requested limit reads back as its value, grouped or not.
      const limitOf = (node: string, file: string) => readFileSync(`/sys/fs/cgroup${where.get(node)}/${file}`, "utf8").trim();
      expect(limitOf("a1", "pids.max")).toBe("64");
      expect(limitOf("a1", "memory.max")).toBe(String(256 * MIB));
      expect(limitOf("b1", "pids.max")).toBe("32");
      expect(limitOf("o1", "pids.max")).toBe("48");
      expect(limitOf("m1", "pids.max")).toBe("40");
      const [paneA1] = await adapter.listPanes("it80-a1@scope");
      expect(await adapter.readSeatProcessLimits(paneA1!.id, SEATS[0]!.limits!, "it80-a1")).toMatchObject({ state: "applied" });

      // OpenRig set no weight on the rig's slice; a weight the user sets there reads back from the kernel.
      const alphaDir = `/sys/fs/cgroup${where.get("a1")!.replace(/\/[^/]+$/, "")}`;
      expect(alphaDir.endsWith(`/${alpha}`)).toBe(true);
      const weightFile = `${alphaDir}/cpu.weight`;
      // systemd turns the cpu controller on for a slice only once a unit there asks for it: before the user's weight the
      // file is absent, or reads the kernel default 100. Whether the user manager has cpu at all is read from its root.
      const managerDir = `/sys/fs/cgroup${where.get("a1")!.split(`/${SEAT_SCOPE_SLICE}/`)[0]}`;
      const cpuDelegated = readFileSync(`${managerDir}/cgroup.controllers`, "utf8").split(/\s+/).includes("cpu");
      let weightNote: string;
      if (cpuDelegated) {
        const before = existsSync(weightFile) ? readFileSync(weightFile, "utf8").trim() : "absent";
        expect(["absent", "100"]).toContain(before);
        await systemctl("set-property", "--runtime", "--", alpha, "CPUWeight=250");
        weightSet = true;
        expect(readFileSync(weightFile, "utf8").trim()).toBe("250");
        expect(await systemctl("show", "--property=CPUWeight", "--value", "--", alpha)).toBe("250");
        weightNote = `cpu.weight ${before} before (no OpenRig weight), 250 after the user set CPUWeight=250`;
      } else {
        weightNote = "NOT RUN: the cpu controller is not delegated to the user manager";
      }
      console.info(`placement: ${SEATS.map((seat) => `${seat.node} ${where.get(seat.node)!.split("/").slice(-3).join("/")}`).join("; ")}; ${weightNote}`);
    } finally {
      await tmux("kill-server").catch(() => undefined);
      for (const scope of scopes) await systemctl("stop", "--", scope).catch(() => undefined);
      if (weightSet) await systemctl("revert", "--", alpha).catch(() => undefined);
      if (maskSet) await systemctl("unmask", "--runtime", "--", masked).catch(() => undefined);
      for (const slice of ownedSlices) await systemctl("stop", "--", slice).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
