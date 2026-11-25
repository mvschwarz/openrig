// Seat process limits on a real host (#3253): the synthetic suite (tmux-seat-process-limits.test.ts) pins the commands
// the adapter runs; this one checks the effect. Through TmuxAdapter.createSession on a private tmux server, seat A
// (`tasks_max: 8`) and seat B (no limit) each fork 13 sleeps. A's pane process must be in its own openrig-seat-*.scope,
// whose pids.events counts the refused forks, and A's batch must stop short; B and the tmux server stay in the server's
// cgroup and fork all 13 without a hit. No pane of the test is moved into a tmux-spawn-*.scope (a systemd-enabled tmux
// 3.4 moves each new pane there unless its server process has no session bus), and a pane that inherits the server's
// global environment still reaches the session bus the test process uses. The memory limit (`memory_max`) has no real-host case here: the synthetic suite
// pins its commands, probe and readback.
//
// Opt-in, and skipped (never passed) unless all of these hold: Linux, OPENRIG_TEST_SEAT_SCOPE=1, a systemd user manager
// that answers through XDG_RUNTIME_DIR (or /run/user/<uid>), cgroup v2 and tmux on PATH. The session bus check runs only
// where this process itself reaches a session bus (`busctl --user status`); without one it is skipped with a line saying so. It creates real transient
// units under the user manager, so run it on an isolated host, inside an outer scope that has its own TasksMax and
// MemoryMax, with TMUX, TMUX_PANE and MANAGERPID unset (so the server stays in that outer scope), e.g.:
//
//   systemd-run --user --scope -p TasksMax=2000 -p MemoryMax=4G env -u TMUX -u TMUX_PANE -u MANAGERPID \
//     OPENRIG_TEST_SEAT_SCOPE=1 npx vitest run test/tmux-seat-process-limits.integration.test.ts
//
// Cleanup touches only what the test made: the private socket's server (kill-server) and seat A's scope unit, by the
// name the adapter gave it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxAdapter, SEAT_SCOPE_SLICE, cgroupV2Path } from "../src/adapters/tmux.js";
import { execArgvCommand, execTmuxCommand } from "../src/adapters/tmux-exec.js";
import { seatRuntimeDir } from "../src/domain/seat-runtime-dir.js";
import { TMUX_SERVER_SESSION_BUS } from "../src/tmux-server-start.js";

const run = promisify(execFile);
const enabled = process.platform === "linux" && process.env.OPENRIG_TEST_SEAT_SCOPE === "1";
const TASKS_MAX = 8;
const FORKS = 13;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` every 100 ms until it returns a value, for at most `ms`. */
async function waitFor<T>(what: string, ms: number, check: () => Promise<T | null> | T | null): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const value = await check();
    if (value !== null) return value;
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

describe.runIf(enabled)("seat process limits on a real user manager (#3253)", () => {
  const saved: Record<string, string | undefined> = {};
  let runtimeDir: string | undefined;
  let skipReason: string | undefined;
  let busReachable = false;

  beforeAll(async () => {
    // The adapter's tmux clients copy this process's environment; the server must not be a nested one or a user
    // service's scope.
    for (const key of ["TMUX", "TMUX_PANE", "MANAGERPID"]) { saved[key] = process.env[key]; delete process.env[key]; }
    const uid = process.getuid?.();
    runtimeDir = seatRuntimeDir(process.env) ?? (uid !== undefined && existsSync(`/run/user/${uid}`) ? `/run/user/${uid}` : undefined);
    if (!runtimeDir) { skipReason = "no XDG_RUNTIME_DIR and no /run/user/<uid>"; return; }
    try {
      await run("/usr/bin/env", ["-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${runtimeDir}`,
        "systemctl", "--user", "show", "--property=Version", "--value"], { timeout: 10_000 });
    } catch (error) { skipReason = `no systemd user manager answers: ${(error as Error).message}`; return; }
    try { await run("busctl", ["--user", "status"], { timeout: 10_000 }); busReachable = true; } catch (error) {
      console.info(`session bus check skipped: no session bus this process reaches (${(error as Error).message})`);
    }
    if (!cgroupV2Path(readFileSync("/proc/self/cgroup", "utf8"))) { skipReason = "not cgroup v2"; return; }
    try { await run("tmux", ["-V"], { timeout: 10_000 }); } catch { skipReason = "no tmux on PATH"; }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  it("forks past tasks_max only inside seat A's scope; seat B and the tmux server are untouched", async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const dir = mkdtempSync(join(tmpdir(), "seat-scope-"));
    const sock = join(dir, "s");
    const tmux = (...args: string[]) => run("tmux", ["-f", "/dev/null", "-S", sock, ...args], { timeout: 10_000 })
      .then((result) => result.stdout.trim());
    const cgroupOf = (pid: number | string) => cgroupV2Path(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
    const tmuxSpawnScope = /\/tmux-spawn-[^/]+\.scope$/;
    const limitHits = (cgroup: string) => Number(/^max (\d+)$/m.exec(readFileSync(`/sys/fs/cgroup${cgroup}/pids.events`, "utf8"))?.[1]);
    let scopeA: string | undefined;
    try {
      // Each seat waits for its go file, then one shell forks the sleeps in the background, recording each pid. A
      // refused fork ends only that shell (dash), so its pane lives on and its exit status is kept.
      writeFileSync(join(dir, "seat.sh"), [
        `OUT="${dir}/$OPENRIG_NODE_ID"; while [ ! -e "$OUT.go" ]; do sleep 0.2; done`,
        `/bin/sh -c 'i=0; while [ $i -lt ${FORKS} ]; do sleep 30 & echo $! >>"$1.pids"; i=$((i+1)); done; echo done >>"$1.pids"' sh "$OUT"`,
        `echo "$?" >"$OUT.rc"; exec sleep 60`, ""].join("\n"));

      const adapter = new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, ["-f", "/dev/null", "-S", sock]);
      adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false,
        // A seat's own bus is off and no runtime directory is set for it: the scope's restore has to unset one and set
        // the other (the combination env reads wrong when an assignment comes before -u).
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DBUS_SESSION_BUS_ADDRESS: "disabled:" },
        runtimeDir: undefined });
      adapter.seatProcessLimits = (nodeId) => (nodeId === "it-a" ? { tasksMax: TASKS_MAX } : undefined);

      expect(await adapter.startServer()).toEqual({ ok: true });
      await tmux("set-option", "-g", "default-shell", "/bin/sh");
      await tmux("set-option", "-g", "default-command", `/bin/sh ${dir}/seat.sh`);

      const a = await adapter.createSession("it-a@scope", dir, { OPENRIG_NODE_ID: "it-a", OPENRIG_SESSION_NAME: "it-a@scope" });
      expect(a).toMatchObject({ ok: true });
      expect(a).not.toHaveProperty("processLimits");
      const b = await adapter.createSession("it-b@scope", dir, { OPENRIG_NODE_ID: "it-b", OPENRIG_SESSION_NAME: "it-b@scope" });
      expect(b).toMatchObject({ ok: true });
      // A pane that takes the server's global environment as it is (no seat launch environment): it records the session
      // bus address it got and whether `busctl --user` reaches that bus.
      if (busReachable) await tmux("new-session", "-d", "-s", "it-bus", "/bin/sh", "-c", `printf %s "\${DBUS_SESSION_BUS_ADDRESS-<unset>}" >${dir}/bus.addr; ` +
        `busctl --user status >/dev/null 2>&1; echo $? >${dir}/bus.rc.tmp; mv ${dir}/bus.rc.tmp ${dir}/bus.rc; exec sleep 60`);

      const [paneA] = await adapter.listPanes("it-a@scope");
      const [paneB] = await adapter.listPanes("it-b@scope");
      const scopePattern = new RegExp(`/${SEAT_SCOPE_SLICE.replace(/\./g, "\\.")}/(openrig-seat-it-a_scope-[0-9a-f]{8}\\.scope)$`);
      const cgroupA = await waitFor("seat A's pane in its scope", 10_000, async () => {
        const pid = await adapter.getPanePid(paneA!.id);
        const path = pid === null ? null : cgroupOf(pid);
        return path && scopePattern.test(path) ? path : null;
      });
      scopeA = scopePattern.exec(cgroupA)![1];

      // Before the forks: B is in the tmux server's cgroup, not a seat scope.
      const serverPid = await tmux("display-message", "-p", "#{pid}");
      const serverCgroup = cgroupOf(serverPid)!;
      expect(serverCgroup).not.toMatch(/\/openrig-seat-[^/]+\.scope$/);
      const pidB = await adapter.getPanePid(paneB!.id);
      expect(pidB).not.toBeNull();
      expect(cgroupOf(pidB!)).toBe(serverCgroup);
      const pidBus = busReachable ? await tmux("display-message", "-p", "-t", "=it-bus:", "#{pane_pid}") : null;
      const panePids = [await adapter.getPanePid(paneA!.id), pidB, ...(pidBus ? [pidBus] : [])];
      for (const pid of panePids) expect(cgroupOf(pid!)).not.toMatch(tmuxSpawnScope);
      let busRc = "not run";
      if (busReachable) {
        busRc = await waitFor("the bus pane's busctl", 10_000, () => {
          const file = join(dir, "bus.rc");
          return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
        });
        expect(readFileSync(join(dir, "bus.addr"), "utf8")).toBe(process.env.DBUS_SESSION_BUS_ADDRESS ?? "<unset>");
        expect(busRc).toBe("0");
      }
      const serverHitsBefore = existsSync(`/sys/fs/cgroup${serverCgroup}/pids.events`) ? limitHits(serverCgroup) : undefined;

      writeFileSync(join(dir, "it-a.go"), "");
      writeFileSync(join(dir, "it-b.go"), "");
      const rc = (seat: string) => waitFor(`${seat}'s fork batch`, 20_000, () => {
        const file = join(dir, `${seat}.rc`);
        return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
      });
      const pids = (seat: string) => (existsSync(join(dir, `${seat}.pids`)) ? readFileSync(join(dir, `${seat}.pids`), "utf8").trim().split("\n").filter(Boolean) : []);
      const [rcA, rcB] = [await rc("it-a"), await rc("it-b")];

      // A: the limit refused forks inside its scope, and its batch stopped short.
      const report = await adapter.readSeatProcessLimits(paneA!.id, { tasksMax: TASKS_MAX }, "it-a");
      expect(report).toMatchObject({ state: "applied", pidsMax: String(TASKS_MAX), scope: scopeA });
      expect(report.limitHits).toBeGreaterThan(0);
      expect(report.pidsCurrent).toBeLessThanOrEqual(TASKS_MAX);
      expect(limitHits(cgroupA)).toBeGreaterThan(0);
      expect(readFileSync(`/sys/fs/cgroup${cgroupA}/pids.max`, "utf8").trim()).toBe(String(TASKS_MAX));
      expect(rcA).not.toBe("0");
      expect(pids("it-a").filter(pid => /^\d+$/.test(pid)).length).toBeGreaterThan(0);  // it forked up to the limit, then was refused
      expect(pids("it-a").length).toBeLessThan(FORKS);
      expect(pids("it-a")).not.toContain("done");

      // B and the server: every fork went through, no limit hit, and both sessions still answer.
      expect(rcB).toBe("0");
      expect(pids("it-b")).toHaveLength(FORKS + 1);
      expect(pids("it-b").at(-1)).toBe("done");
      expect(cgroupOf(pidB!)).toBe(serverCgroup);
      for (const pid of panePids) expect(cgroupOf(pid!)).not.toMatch(tmuxSpawnScope);
      if (serverHitsBefore !== undefined) expect(limitHits(serverCgroup)).toBe(serverHitsBefore);
      expect(await adapter.hasSession("it-a@scope")).toBe(true);
      expect(await adapter.hasSession("it-b@scope")).toBe(true);
      // The capture a reviewer reads: what each seat got, as observed.
      console.info(`seat A: ${scopeA}, pids.max ${readFileSync(`/sys/fs/cgroup${cgroupA}/pids.max`, "utf8").trim()}, ` +
        `limit hits ${limitHits(cgroupA)}, ${pids("it-a").length}/${FORKS} sleeps forked, exit ${rcA}; seat B: in the ` +
        `tmux server's cgroup (not a seat scope), ${pids("it-b").length - 1}/${FORKS} sleeps forked, exit ${rcB}; ` +
        `no pane in a tmux-spawn-*.scope; bus pane: busctl --user exit ${busRc}; tmux server's own ` +
        `DBUS_SESSION_BUS_ADDRESS: ${/^DBUS_SESSION_BUS_ADDRESS=(.*)$/m.exec(readFileSync(`/proc/${serverPid}/environ`, "utf8").replace(/\0/g, "\n"))?.[1] ?? "<unset>"}`);
    } finally {
      await tmux("kill-server").catch(() => undefined);
      if (scopeA) {
        await run("/usr/bin/env", ["-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${runtimeDir}`,
          "systemctl", "--user", "stop", "--", scopeA], { timeout: 10_000 }).catch(() => undefined);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  // #3253: a daemon started from a shell (no MANAGERPID) whose first server start is implicit: a seat launch that takes
  // tmux's environment (terminal.inherit_tmux_environment, so no default-shell read starts the server first), or the
  // probe session. Either goes through startServer, so the server process has no session bus and its panes stay out of
  // tmux-spawn-*.scope, while the global environment keeps the bus this process has.
  it.for(["a seat launch that takes tmux's environment", "a probe session"])("a server that %s starts has no bus in its own process, and its panes stay in its cgroup", async (how, ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const dir = mkdtempSync(join(tmpdir(), "seat-implicit-"));
    const sock = join(dir, "s");
    const conf = join(dir, "tmux.conf");
    writeFileSync(conf, "set -g default-shell /bin/sh\nset -g default-command 'exec sleep 60'\n");
    const tmux = (...args: string[]) => run("tmux", ["-f", conf, "-S", sock, ...args], { timeout: 10_000 })
      .then((result) => result.stdout.trim());
    const cgroupOf = (pid: number | string) => cgroupV2Path(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
    const busOf = (pid: number | string) => /^DBUS_SESSION_BUS_ADDRESS=(.*)$/m.exec(readFileSync(`/proc/${pid}/environ`, "utf8").replace(/\0/g, "\n"))?.[1];
    try {
      const adapter = new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, ["-f", conf, "-S", sock]);
      adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: true, env: { PATH: process.env.PATH, HOME: process.env.HOME }, runtimeDir: undefined });
      adapter.seatProcessLimits = () => undefined;
      if (how === "a probe session") expect(await adapter.createProbeSession("openrig-it-probe")).toEqual({ ok: true });
      else expect(await adapter.createSession("it-c@scope", dir, { OPENRIG_NODE_ID: "it-c", OPENRIG_SESSION_NAME: "it-c@scope" })).toMatchObject({ ok: true });
      // A pane that takes the server's global environment as it is.
      await tmux("new-session", "-d", "-s", "it-d");
      const serverPid = await tmux("display-message", "-p", "#{pid}");
      const serverCgroup = cgroupOf(serverPid)!;
      expect(busOf(serverPid)).toBe(TMUX_SERVER_SESSION_BUS);
      const panes = (await tmux("list-panes", "-a", "-F", "#{pane_pid}")).split("\n").filter(Boolean);
      expect(panes.length).toBeGreaterThanOrEqual(2);
      for (const pid of panes) expect(cgroupOf(pid), `pane ${pid}`).toBe(serverCgroup);
      const paneD = await tmux("display-message", "-p", "-t", "=it-d:", "#{pane_pid}");
      // Until the pane's child has run its command, /proc shows the environment it was forked with (the server's).
      await waitFor("pane it-d to run its command", 10_000, () => readFileSync(`/proc/${paneD}/cmdline`, "utf8").startsWith("sleep\0") ? true : null);
      expect(busOf(paneD)).toBe(process.env.DBUS_SESSION_BUS_ADDRESS);
      console.info(`${how}: tmux server's own DBUS_SESSION_BUS_ADDRESS ${busOf(serverPid)}; ${panes.length} panes in its cgroup ` +
        `${serverCgroup}; a pane of the global environment has ${busOf(paneD) ?? "<unset>"}`);
    } finally {
      await tmux("kill-server").catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
