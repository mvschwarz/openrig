// Seat process limits (#3253): a seat whose rig spec sets `process_limits.tasks_max` launches its pane command in a
// transient `systemd-run --user --scope` of its own with TasksMax as its only limit, under the shared tmux server; the
// other seats, the server and the daemon stay where they are. Without the option nothing changes. Where the limit can't
// be applied, a fresh launch is not started and says why: `process_limits_unsupported` only for a positive inability,
// `process_limits_unverified` (retryable, with a cached observation's age) when it is not known; a recovery (a
// handover, a provider switch, a restart in place) goes ahead without it, with a structured warning. The limit is
// reported from the kernel's readback (applied; requested, not applied; unsupported; unknown; invalid).
//
// Synthetic only: the string exec, the argv exec and the /proc readers are fakes that record what the adapter runs, so
// nothing here touches the host's systemd, cgroups or tmux.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter, SEAT_SCOPE_SLICE, cgroupV2Path } from "../src/adapters/tmux.js";

type Plan = string[] | null;
type Answer = string | Error;
type Probe = { scope?: Answer; bus?: Answer };
const RT = "/run/user/1000";
const fail = (stderr: string, code = 1) =>
  Object.assign(new Error(`Command failed\n${stderr}`), { execStderr: `${stderr}\n`, stderr: `${stderr}\n`, code });

const A = { OPENRIG_NODE_ID: "node-a", OPENRIG_SESSION_NAME: "impl-a@demo" };
const B = { OPENRIG_NODE_ID: "node-b", OPENRIG_SESSION_NAME: "impl-b@demo" };

function makeAdapter(opts: { limits?: Record<string, number | "invalid">; inherit?: boolean; probe?: Probe; noLaunchEnvironment?: boolean } = {}) {
  const shellCalls: string[] = [];
  const argvCalls: string[][] = [];
  const get = (k: keyof Probe, fallback: string): Answer => (opts.probe && k in opts.probe ? opts.probe[k]! : fallback);
  const answer = (value: Answer) => { if (value instanceof Error) throw value; return value; };
  const exec = async (command: string) => {
    shellCalls.push(command);
    if (command.includes("openrig-seat-probe-")) {
      // The probe prints its own pids.max: by default, the TasksMax it was given.
      return answer(get("scope", `${/TasksMax=(\d+)/.exec(command)?.[1] ?? "max"}\n`));
    }
    if (command.includes("systemctl --user show")) return answer(get("bus", "255\n"));
    return "";
  };
  const argvExec = async (args: string[]) => {
    argvCalls.push(args);
    if (args.some(arg => arg.includes("default-shell"))) return "/bin/bash";
    if (args.includes("#{pane_pid}")) return "4321";
    return args.includes("new-session") || args.includes("source-file") ? "%1" : "";
  };
  let n = 0;
  // Commands with an environment to pass reach tmux as a file it sources: the file's text is what tmux runs.
  const writes: string[] = [];
  const files = { writeFile: async (_p: string, content: string) => { writes.push(content); }, unlink: async () => {},
    tmpName: () => `/tmp/synthetic-seat-env-${++n}`, bufferName: () => "unused" };
  const adapter = new TmuxAdapter(exec, files, argvExec);
  if (!opts.noLaunchEnvironment) {
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: opts.inherit === true, env: { PATH: "/bin" }, runtimeDir: RT });
  }
  if (opts.limits) {
    const limits = opts.limits;
    adapter.seatProcessLimits = (nodeId) => {
      const v = limits[nodeId];
      if (v === "invalid") throw new Error(`Seat ${nodeId} process_limits: stored value is not valid JSON`);
      return v !== undefined ? { tasksMax: v } : undefined;
    };
  }
  const plan = (env: Record<string, string>, command = "/bin/sh") =>
    (adapter as unknown as { scopedLaunchCommand(e: Record<string, string>, c: string, w: string[]): Promise<Plan> })
      .scopedLaunchCommand(env, command, []);
  // tmux commands go through the argv exec or, with an environment to pass, the string exec: read both.
  const tmuxCalls = (verb: string) => [...argvCalls.map(a => a.join(" ")), ...shellCalls, ...writes].filter(c => c.includes(verb));
  const newSessions = () => tmuxCalls("new-session");
  return { adapter, plan, shellCalls, argvCalls, writes, newSessions, tmuxCalls };
}

const systemdCalls = (calls: string[]) => calls.filter(c => c.includes("systemd-run") || c.includes("systemctl"));
const normalize = (plan: Plan) => plan?.map(x => x.replace(/synthetic-seat-env-\d+/, "F"));

let platform: PropertyDescriptor | undefined;
beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.stubEnv("MANAGERPID", "4242");
  vi.stubEnv("XDG_RUNTIME_DIR", RT);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("no process limits (the default)", () => {
  it("the pane command is today's: no systemd-run in it and nothing asked of systemd", async () => {
    const off = makeAdapter();
    const plan = await off.plan(A);
    expect(plan?.[0]).toBe("/bin/sh");
    expect(plan?.join(" ")).not.toContain("systemd-run");
    expect(systemdCalls(off.shellCalls)).toEqual([]);
    expect(await off.adapter.seatProcessLimitsRecoveryPlan("node-a")).toBeNull();
    expect(off.adapter.seatProcessLimitsSet("node-a")).toBe(false);
    const created = await off.adapter.createSession("impl-a@demo", "/work", A);
    expect(created).toEqual({ ok: true });
  });
});

describe("a seat with tasks_max, on Linux with a user manager", () => {
  it("only that seat's pane command starts in its own scope in the seats' slice, TasksMax its only limit", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const control = makeAdapter();
    const a = (await h.plan(A))!;
    const today = normalize(await control.plan(A))!;
    // The seat's environment file runs first, outside the scope (its /bin/rm forks): that head is today's.
    expect(normalize(a.slice(0, 5))).toEqual(today.slice(0, 5));
    const sep = a.indexOf("--");
    const scope = a.slice(5, sep);
    expect(scope.slice(0, 4)).toEqual(["/usr/bin/env", "-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${RT}`]);
    expect(scope.slice(4, 9)).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--collect"]);
    expect(scope[scope.indexOf("--slice") + 1]).toBe(SEAT_SCOPE_SLICE);
    expect(scope[scope.indexOf("--unit") + 1]).toMatch(/^openrig-seat-impl-a_demo-[0-9a-f]{8}$/);
    const props = scope.flatMap((x, i, all) => (all[i - 1] === "-p" ? [x] : []));
    expect(props).toEqual(["OOMPolicy=continue", "TasksMax=256"]);
    expect(scope).toContain("--expand-environment=no");
    // After the separator: the seat's own bus and runtime directory back (systemd-run needed them set otherwise),
    // then exactly the shell command the seat gets without a limit.
    const tail = today.slice(5);
    // (the seat's launch environment turns its session bus off on purpose: that value comes back)
    expect(a.slice(sep + 1, a.length - tail.length)).toEqual(
      ["/usr/bin/env", "DBUS_SESSION_BUS_ADDRESS=disabled:", `XDG_RUNTIME_DIR=${RT}`]);
    expect(normalize(a.slice(a.length - tail.length))).toEqual(tail);
    // The other seat of the same daemon: today's command, unchanged.
    expect(normalize(await h.plan(B))).toEqual(normalize(await control.plan(B)));
  });

  it("proves the limit once per value with a throwaway scope that reads its own pids.max, and asks the bus at every launch", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    await h.plan(A); await h.plan(A);
    const probes = h.shellCalls.filter(c => c.includes("openrig-seat-probe-"));
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatch(/timeout 10 systemd-run --user --scope .*--slice openrig-seats\.slice .*-p TasksMax=256 -- \/bin\/sh -c /);
    expect(probes[0]).toContain("pids.max");
    // shell builtins only: nothing forks inside the probe's scope, so even TasksMax=1 can be proven
    expect(probes[0]).not.toMatch(/\$\(|\bsed\b|\bcat\b/);
    expect(h.shellCalls.filter(c => c.includes("systemctl --user show"))).toHaveLength(2);
    expect(await h.adapter.seatProcessLimitsRecoveryPlan("node-a")).toBeNull();
    expect(h.adapter.seatProcessLimitsSet("node-a")).toBe(true);
  });

  it("tasks_max 1 is proven and applied like any other value", async () => {
    const h = makeAdapter({ limits: { "node-a": 1 } });
    expect((await h.adapter.createSession("impl-a@demo", "/work", A)).ok).toBe(true);
    expect(h.newSessions()[0]).toMatch(/TasksMax=1(?!\d)/);
  });

  it("a daemon that is not a systemd user service (MANAGERPID unset) still gets the scope: the probe decides", async () => {
    vi.stubEnv("MANAGERPID", "");
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result.ok).toBe(true);
    expect(h.newSessions()[0]).toContain("TasksMax=256");
  });

  it("drops only the option systemd says it lacks, as for the server's scope", async () => {
    let calls = 0;
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const exec = (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec;
    (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec = async (c: string) => {
      if (c.includes("openrig-seat-probe-") && calls++ === 0) throw fail("systemd-run: unrecognized option '--expand-environment=no'");
      return exec(c);
    };
    const plan = (await h.plan(A))!;
    expect(plan).not.toContain("--expand-environment=no");
    expect(plan).toContain("TasksMax=256");
  });

  it("a respawn with the seat's environment is wrapped too", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A });
    expect(result).toEqual({ ok: true });
    const respawn = h.tmuxCalls("respawn-pane")[0]!;
    expect(respawn).toContain("systemd-run");
    expect(respawn).toContain("TasksMax=256");
  });
});

/** The fresh launch's result, and that nothing was started for it while a seat without a limit still launches. */
async function freshRefused(h: ReturnType<typeof makeAdapter>, code: string) {
  const result = await h.adapter.createSession("impl-a@demo", "/work", A);
  expect(result).toMatchObject({ ok: false, code });
  expect(h.newSessions()).toEqual([]);
  h.argvCalls.length = 0; h.shellCalls.length = 0; h.writes.length = 0;
  expect(await h.adapter.createSession("impl-b@demo", "/work", B)).toEqual({ ok: true });
  expect(h.newSessions()).toHaveLength(1);
  expect(h.newSessions()[0]).not.toContain("systemd-run");
  return result as Extract<typeof result, { ok: false }>;
}

describe("a positive inability: the fresh launch is not started, process_limits_unsupported", () => {
  const cases: Array<[string, () => ReturnType<typeof makeAdapter>, RegExp]> = [
    ["not Linux", () => { Object.defineProperty(process, "platform", { value: "darwin" }); return makeAdapter({ limits: { "node-a": 256 } }); }, /not Linux/],
    ["no runtime directory to reach the user manager", () => { vi.stubEnv("XDG_RUNTIME_DIR", ""); return makeAdapter({ limits: { "node-a": 256 } }); }, /XDG_RUNTIME_DIR/],
    ["systemd-run is missing", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: fail("/bin/sh: 1: systemd-run: not found", 127) } }), /not installed/],
    ["no user manager runs for this user", () => makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("Failed to connect to bus: No such file or directory") } }), /no systemd user manager is running/],
    ["TasksMax accepted but not enforced (no pids controller)", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "max\n" } }), /pids\.max "max" for TasksMax=256: the pids limit is not enforced/],
    ["the user manager's scopes have no cgroup v2 path", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "nocgroup2\n" } }), /no cgroup v2 path/],
    ["a throwaway scope has no pids.max", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "nopids\n" } }), /pids controller is not delegated/],
    ["the user bus socket is not there (via local transport)", () => makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("Failed to connect to bus via local transport: No such file or directory") } }), /no systemd user manager is running/],
    ["the user bus reports no medium", () => makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("Failed to connect to user scope bus via local transport: No medium found") } }), /no systemd user manager is running/],
  ];
  for (const [name, make, reason] of cases) {
    it(name, async () => {
      const r = await freshRefused(make(), "process_limits_unsupported");
      expect(r.message).toMatch(reason);
      expect(r).toMatchObject({ retryable: false, processLimits: { kind: "unsupported", requested: { tasksMax: 256 } } });
    });
  }
});

describe("a setup that can't use the scope: process_limits_setup, with the way out", () => {
  const cases: Array<[string, () => ReturnType<typeof makeAdapter>, RegExp]> = [
    ["inherit_tmux_environment is on", () => makeAdapter({ limits: { "node-a": 256 }, inherit: true }), /inherit_tmux_environment is on: .*set terminal\.inherit_tmux_environment to false/],
    ["the daemon gives seats no launch environment", () => makeAdapter({ limits: { "node-a": 256 }, noLaunchEnvironment: true }), /no launch environment/],
  ];
  for (const [name, make, reason] of cases) {
    it(name, async () => {
      const h = make();
      const result = await h.adapter.createSession("impl-a@demo", "/work", A);
      expect(result).toMatchObject({ ok: false, code: "process_limits_setup", retryable: false,
        processLimits: { kind: "setup", requested: { tasksMax: 256 } } });
      expect(result.ok ? "" : result.message).toMatch(reason);
      expect(h.newSessions()).toEqual([]);
      // nothing asked of systemd for a setup that can't use the answer
      expect(systemdCalls(h.shellCalls)).toEqual([]);
    });
  }

  it("it is a setup limitation on the status too, not 'unsupported'", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, inherit: true });
    h.adapter.procRead = async (p: string) => {
      if (p === "/proc/4321/cgroup") return "0::/user.slice/user@1000.service/openrig-tmux-1234abcd.scope\n";
      throw new Error(`ENOENT: ${p}`);
    };
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 }))
      .toMatchObject({ state: "not_applied", reason: expect.stringMatching(/this setup can't make the scope: .*inherit_tmux_environment/) });
  });
});

describe("not known either way: process_limits_unverified, retryable, never read as a fresh result", () => {
  const cases: Array<[string, Probe, RegExp]> = [
    ["the user bus timed out", { bus: fail("", 124) }, /timed out/],
    ["the probe read nothing", { scope: "\n" }, /read no pids\.max/],
    ["an error not recognized", { scope: fail("Failed to start transient scope unit: Access denied") }, /Access denied/],
  ];
  for (const [name, probe, reason] of cases) {
    it(name, async () => {
      const r = await freshRefused(makeAdapter({ limits: { "node-a": 256 }, probe }), "process_limits_unverified");
      expect(r.message).toMatch(reason);
      expect(r.message).toMatch(/retry the launch/);
      expect(r).toMatchObject({ retryable: true, processLimits: { kind: "unverified" } });
    });
  }

  it("a cached failure is unverified with its age; past the minute it asks again, and a setup fixed since works", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let bus: Answer = fail("", 124);
      const h = makeAdapter({ limits: { "node-a": 256 } });
      const exec = (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec;
      (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec = async (c: string) => {
        if (c.includes("systemctl --user show")) { h.shellCalls.push(c); if (bus instanceof Error) throw bus; return bus; }
        return exec(c);
      };
      await h.adapter.createSession("impl-a@demo", "/work", A);
      vi.setSystemTime(Date.now() + 23_000);
      const cached = await h.adapter.createSession("impl-a@demo", "/work", A);
      expect(cached).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: true,
        processLimits: { kind: "unverified", ageSeconds: 23 } });
      expect(cached.ok ? "" : cached.message).toMatch(/observed 23s ago/);
      expect(h.shellCalls.filter(c => c.includes("systemctl"))).toHaveLength(1);
      bus = "255\n";  // fixed meanwhile
      vi.setSystemTime(Date.now() + 61_000);
      expect((await h.adapter.createSession("impl-a@demo", "/work", A)).ok).toBe(true);
      expect(h.shellCalls.filter(c => c.includes("systemctl"))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("a positive answer is not cached: the next launch asks again and sees a manager started since", async () => {
    let bus: Answer = fail("Failed to connect to bus: No such file or directory");
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const exec = (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec;
    (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec = async (c: string) => {
      if (c.includes("systemctl --user show")) { h.shellCalls.push(c); if (bus instanceof Error) throw bus; return bus; }
      return exec(c);
    };
    expect(await h.adapter.createSession("impl-a@demo", "/work", A)).toMatchObject({ ok: false, code: "process_limits_unsupported" });
    bus = "255\n";
    expect((await h.adapter.createSession("impl-a@demo", "/work", A)).ok).toBe(true);
    expect(h.shellCalls.filter(c => c.includes("systemctl"))).toHaveLength(2);
  });
});

describe("a recovery goes ahead without the limit, with a structured warning; the request stays", () => {
  it("the respawn in recovery mode starts uncapped, says why, and is retryable when unverified", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("", 124) } });
    const plan = await h.adapter.seatProcessLimitsRecoveryPlan("node-a");
    expect(plan).toMatchObject({ state: "not_applied", kind: "unverified", retryable: true, requested: { tasksMax: 256 } });
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unverified", retryable: true } });
    expect(result.ok && result.warnings?.join(" ")).toMatch(/process_limits requested, not applied: .*the request stays stored/);
    expect(h.tmuxCalls("respawn-pane")[0]).not.toContain("systemd-run");
    expect(h.adapter.seatProcessLimitsSet("node-a")).toBe(true);
  });

  it("a scope failure late in the path (the check passed, the bus went away at the respawn) still ends in the warning", async () => {
    let late = false;
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const exec = (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec;
    (h.adapter as unknown as { exec: (c: string) => Promise<string> }).exec = async (c: string) => {
      if (late && c.includes("systemctl --user show")) throw fail("Failed to connect to bus: Connection refused");
      return exec(c);
    };
    expect(await h.adapter.seatProcessLimitsRecoveryPlan("node-a")).toBeNull();  // chosen before the stop: capped
    late = true;
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unsupported" } });
    // the same failure on a fresh launch is a refusal, not an unlimited start
    const fresh = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(fresh).toMatchObject({ ok: false });
  });

  // The capped respawn's start, seen from the pane: its process's cgroup, or the pane dead before it got there.
  const SEAT_CG = "0::/user.slice/user@1000.service/openrig.slice/openrig-seats.slice/openrig-seat-impl-a_demo-1a2b3c4d.scope\n";
  const SERVER_CG = "0::/user.slice/user@1000.service/openrig-tmux-1234abcd.scope\n";
  function startSeen(h: ReturnType<typeof makeAdapter>, steps: Array<"dead" | "server" | "seat">) {
    let i = 0;
    const at = () => steps[Math.min(i, steps.length - 1)]!;
    h.adapter.scopeStartSleep = async () => { i++; };
    const dead = vi.spyOn(h.adapter, "isPaneDead").mockImplementation(async () => at() === "dead");
    h.adapter.procRead = async (p: string) => {
      if (p !== "/proc/4321/cgroup") throw new Error(`ENOENT: ${p}`);
      return at() === "seat" ? SEAT_CG : SERVER_CG;
    };
    return dead;
  }

  it("a capped recovery respawn whose pane dies at once (systemd-run refused the scope then) starts again without it", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["dead"]);
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unverified", retryable: true,
      reason: expect.stringContaining("did not start") } });
    const respawns = h.tmuxCalls("respawn-pane");
    expect(respawns).toHaveLength(2);
    expect(respawns[0]).toContain("TasksMax=256");
    expect(respawns[1]).not.toContain("systemd-run");
    expect(dead).toHaveBeenCalledTimes(1);
  });

  it("a late failure (the user manager answered after a while, then the pane died) is seen too, and the recovery goes on uncapped", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    startSeen(h, ["server", "server", "server", "server", "server", "server", "server", "server", "dead"]);
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unverified" } });
    const respawns = h.tmuxCalls("respawn-pane");
    expect(respawns).toHaveLength(2);
    expect(respawns[1]).not.toContain("systemd-run");
  });

  it("a capped recovery respawn is kept once its process is in the seat scope; a fresh launch is never checked", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["server", "server", "seat"]);
    expect(await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" })).toEqual({ ok: true });
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
    expect(dead).toHaveBeenCalledTimes(3);
    dead.mockClear();
    expect(await h.adapter.respawnPane("%1", "/bin/bash", { env: A })).toEqual({ ok: true });
    expect(dead).not.toHaveBeenCalled();
  });

  it("a start neither seen nor failed in time is kept, with a warning and no notice (the status reads where it stands)", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["server"]);
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringMatching(/scope start was not confirmed/)] });
    expect("processLimits" in result).toBe(false);
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
    expect(dead).toHaveBeenCalledTimes(120);
  });

  it("a provider switch's staged successor (createSession in recovery) whose scope fails late starts again without it", async () => {
    for (const kept of [false, true]) {
      const h = makeAdapter({ limits: { "node-a": 256 } });
      startSeen(h, ["server", "server", "server", "dead"]);
      vi.spyOn(h.adapter, "probeSession").mockResolvedValue({ state: kept ? "present" : "absent" } as never);
      const result = await h.adapter.createSession("impl-a@demo", "/work", A, { processLimitsMode: "recovery" });
      expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unverified", retryable: true,
        reason: expect.stringContaining("did not start") } });
      expect(h.newSessions()[0]).toContain("TasksMax=256");
      // the retry: in the same pane when tmux kept it, else a new session of the same name; uncapped either way
      const retry = kept ? h.tmuxCalls("respawn-pane") : h.newSessions().slice(1);
      expect(retry).toHaveLength(1);
      expect(retry[0]).not.toContain("systemd-run");
      expect(kept ? h.newSessions() : h.tmuxCalls("respawn-pane")).toHaveLength(kept ? 1 : 0);
    }
  });

  it("a staged successor whose scope starts is kept; a fresh createSession is never watched", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["seat"]);
    expect(await h.adapter.createSession("impl-a@demo", "/work", A, { processLimitsMode: "recovery" })).toEqual({ ok: true });
    expect(h.newSessions()).toHaveLength(1);
    expect(dead).toHaveBeenCalledTimes(1);
    dead.mockClear();
    expect(await h.adapter.createSession("impl-a@demo", "/work", A)).toEqual({ ok: true });
    expect(dead).not.toHaveBeenCalled();
  });

  it("a positive inability on a recovery: not retryable, and the respawn is today's command", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "max\n" } });
    const control = makeAdapter();
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { kind: "unsupported", retryable: false } });
    await control.adapter.respawnPane("%1", "/bin/bash", { env: A });
    expect(h.tmuxCalls("respawn-pane")[0]!.replace(/synthetic-seat-env-\d+/, "F"))
      .toEqual(control.tmuxCalls("respawn-pane")[0]!.replace(/synthetic-seat-env-\d+/, "F"));
  });
});

describe("a stored value that can't be read stays local to its seat", () => {
  it("that seat's fresh launch says so; another seat launches; a recovery goes on with the warning", async () => {
    const h = makeAdapter({ limits: { "node-a": "invalid" } });
    const r = await freshRefused(h, "process_limits_invalid");
    expect(r.message).toMatch(/stored value can't be read .*not valid JSON/);
    expect(h.adapter.seatProcessLimitsSet("node-a")).toBe(true);
    expect(await h.adapter.seatProcessLimitsRecoveryPlan("node-a")).toMatchObject({ kind: "invalid", retryable: false });
    const respawn = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(respawn).toMatchObject({ ok: true, processLimits: { kind: "invalid" } });
  });
});

describe("readback: where the limit stands, from the kernel", () => {
  const SCOPE = "/user.slice/user-1000.slice/user@1000.service/openrig.slice/openrig-seats.slice/openrig-seat-impl-a_demo-1a2b3c4d.scope";
  const reader = (files: Record<string, string>) => async (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path]!;
  };
  const seatFiles = (pidsMax: string, events = "max 0\n") => ({
    "/proc/4321/cgroup": `0::${SCOPE}\n`,
    [`/sys/fs/cgroup${SCOPE}/pids.max`]: `${pidsMax}\n`,
    [`/sys/fs/cgroup${SCOPE}/pids.current`]: "37\n",
    [`/sys/fs/cgroup${SCOPE}/pids.events`]: events,
  });
  const OUTSIDE = { "/proc/4321/cgroup": "0::/user.slice/user@1000.service/openrig-tmux-1234abcd.scope\n" };

  it("applied: the pane's process is in a seat scope whose pids.max is the limit; a hit is counted", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("256", "max 3\n"));
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toEqual({
      state: "applied", requested: { tasksMax: 256 }, scope: "openrig-seat-impl-a_demo-1a2b3c4d.scope",
      pidsMax: "256", pidsCurrent: 37, limitHits: 3,
    });
  });

  it("requested, not applied: another pids.max, or a process outside a seat scope", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("512"));
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "not_applied", pidsMax: "512" });
    h.adapter.procRead = reader(OUTSIDE);
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "not_applied" });
  });

  it("unknown: no cgroup v2 line, or unreadable files", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader({ "/proc/4321/cgroup": "12:pids:/user.slice\n" });
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "unknown" });
    h.adapter.procRead = reader({});
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "unknown" });
  });

  it("unsupported only on a positive inability; MANAGERPID unset or an unverified check is still 'requested, not applied'", async () => {
    vi.stubEnv("MANAGERPID", "");
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("256"));
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "applied" });
    h.adapter.procRead = reader(OUTSIDE);
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "not_applied" });
    const timedOut = makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("", 124) } });
    await timedOut.adapter.createSession("impl-a@demo", "/work", A);
    timedOut.adapter.procRead = reader(OUTSIDE);
    expect(await timedOut.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "not_applied" });
    const noPids = makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "max\n" } });
    await noPids.adapter.createSession("impl-a@demo", "/work", A);
    noPids.adapter.procRead = reader(OUTSIDE);
    expect(await noPids.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 }))
      .toMatchObject({ state: "unsupported", reason: expect.stringMatching(/pids limit is not enforced.*observed \d+s ago/) });
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "unsupported" });
  });

  it("seatProcessLimitsNotApplied: null when applied or without limits, the warning otherwise", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("256"));
    expect(await h.adapter.seatProcessLimitsNotApplied("node-a", "impl-a@demo")).toBeNull();
    expect(await h.adapter.seatProcessLimitsNotApplied("node-b", "impl-b@demo")).toBeNull();
    h.adapter.procRead = reader(seatFiles("512"));
    expect(await h.adapter.seatProcessLimitsNotApplied("node-a", "impl-a@demo"))
      .toMatchObject({ state: "not_applied", kind: "setup", retryable: false, requested: { tasksMax: 256 },
        reason: expect.stringMatching(/a restart in place keeps the running process, and it is not under the limit: .*pids\.max is 512/) });
    // a readback that fails is unverified, not a known state
    h.adapter.procRead = reader({});
    expect(await h.adapter.seatProcessLimitsNotApplied("node-a", "impl-a@demo"))
      .toMatchObject({ state: "not_applied", kind: "unverified", retryable: true });
  });

  it("reads the cgroup v2 path only from the 0:: line", () => {
    expect(cgroupV2Path("0::/a/b.scope\n")).toBe("/a/b.scope");
    expect(cgroupV2Path("1:name=systemd:/x\n")).toBeNull();
  });
});
