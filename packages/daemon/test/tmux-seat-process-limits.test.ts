// Seat process limits (#3253): a seat whose rig spec sets `process_limits.tasks_max` launches its pane command in a
// transient `systemd-run --user --scope` of its own with TasksMax as its only limit, under the shared tmux server; the
// other seats, the server and the daemon stay where they are. Without the option nothing changes. A host that can't
// give the seat that scope refuses its launch (no silent fallback to no limit), and the limit is reported from the
// kernel's readback (requested, applied, unsupported, unknown), never from config alone.
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

function makeAdapter(opts: { limits?: Record<string, number>; inherit?: boolean; probe?: Probe; noLaunchEnvironment?: boolean } = {}) {
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
    adapter.seatProcessLimits = (nodeId) => (limits[nodeId] !== undefined ? { tasksMax: limits[nodeId]! } : undefined);
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
    expect(await off.adapter.seatProcessLimitsRefusal("node-a")).toBeNull();
    expect(off.adapter.seatProcessLimitsSet("node-a")).toBe(false);
  });
});

describe("a seat with tasks_max, on Linux with a user manager", () => {
  it("only that seat's pane command starts in its own scope in the seats' slice, TasksMax its only limit", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const control = makeAdapter();
    const a = (await h.plan(A))!;
    const sep = a.indexOf("--");
    expect(a.slice(0, 4)).toEqual(["/usr/bin/env", "-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${RT}`]);
    expect(a.slice(4, 9)).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--collect"]);
    expect(a[a.indexOf("--slice") + 1]).toBe(SEAT_SCOPE_SLICE);
    expect(a[a.indexOf("--unit") + 1]).toMatch(/^openrig-seat-impl-a_demo-[0-9a-f]{8}$/);
    const props = a.slice(0, sep).flatMap((x, i, all) => (all[i - 1] === "-p" ? [x] : []));
    expect(props).toEqual(["OOMPolicy=continue", "TasksMax=256"]);
    expect(a).toContain("--expand-environment=no");
    // After the separator, exactly the command the seat gets without a limit.
    expect(normalize(a.slice(sep + 1))).toEqual(normalize(await control.plan(A)));
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
    expect(h.shellCalls.filter(c => c.includes("systemctl --user show"))).toHaveLength(2);
    expect(await h.adapter.seatProcessLimitsRefusal("node-a")).toBeNull();
    expect(h.adapter.seatProcessLimitsSet("node-a")).toBe(true);
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
    expect(result.ok).toBe(true);
    const respawn = h.tmuxCalls("respawn-pane")[0]!;
    expect(respawn).toContain("systemd-run");
    expect(respawn).toContain("TasksMax=256");
  });
});

describe("a host that can't give the seat its scope refuses its launch, never starts it without the limit", () => {
  const cases: Array<[string, () => ReturnType<typeof makeAdapter>, RegExp]> = [
    ["the daemon is not a user service", () => { vi.stubEnv("MANAGERPID", ""); return makeAdapter({ limits: { "node-a": 256 } }); }, /MANAGERPID is unset/],
    ["not Linux", () => { Object.defineProperty(process, "platform", { value: "darwin" }); return makeAdapter({ limits: { "node-a": 256 } }); }, /not Linux/],
    ["systemd-run is missing", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: fail("/bin/sh: 1: systemd-run: not found", 127) } }), /systemd-run: not found/],
    ["the throwaway scope is refused", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: fail("Failed to start transient scope unit: Access denied") } }), /Access denied/],
    ["TasksMax accepted but not enforced (no pids controller)", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "max\n" } }), /pids\.max "max" for TasksMax=256/],
    ["the user bus does not answer", () => makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("Failed to connect to bus: No such file or directory") } }), /bus did not answer/],
    ["inherit_tmux_environment is on", () => makeAdapter({ limits: { "node-a": 256 }, inherit: true }), /inherit_tmux_environment/],
    ["no launch environment", () => makeAdapter({ limits: { "node-a": 256 }, noLaunchEnvironment: true }), /no launch environment/],
  ];
  for (const [name, make, reason] of cases) {
    it(name, async () => {
      const h = make();
      const result = await h.adapter.createSession("impl-a@demo", "/work", A);
      expect(result).toMatchObject({ ok: false, code: "process_limits_unsupported" });
      expect(result.ok ? "" : result.message).toMatch(reason);
      expect(h.newSessions()).toEqual([]);
      expect(await h.adapter.seatProcessLimitsRefusal("node-a")).toMatch(reason);
      // A seat without a limit still launches on the same host, as today.
      h.argvCalls.length = 0;
      h.shellCalls.length = 0;
      h.writes.length = 0;
      expect((await h.adapter.createSession("impl-b@demo", "/work", B)).ok).toBe(true);
      expect(h.newSessions()).toHaveLength(1);
      expect(h.newSessions()[0]).not.toContain("systemd-run");
    });
  }

  it("a bus that did not answer refuses the next minute without asking again, then asks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("Failed to connect to bus") } });
      await h.adapter.createSession("impl-a@demo", "/work", A);
      await h.adapter.createSession("impl-a@demo", "/work", A);
      expect(h.shellCalls.filter(c => c.includes("systemctl"))).toHaveLength(1);
      vi.setSystemTime(Date.now() + 61_000);
      await h.adapter.createSession("impl-a@demo", "/work", A);
      expect(h.shellCalls.filter(c => c.includes("systemctl"))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
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

  it("applied: the pane's process is in a seat scope whose pids.max is the limit; a hit is counted", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("256", "max 3\n"));
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toEqual({
      state: "applied", requested: { tasksMax: 256 }, scope: "openrig-seat-impl-a_demo-1a2b3c4d.scope",
      pidsMax: "256", pidsCurrent: 37, limitHits: 3,
    });
  });

  it("requested: another pids.max, or a process outside a seat scope (launched before the limit was set)", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("512"));
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "requested", pidsMax: "512" });
    h.adapter.procRead = reader({ "/proc/4321/cgroup": "0::/user.slice/user@1000.service/openrig-tmux-1234abcd.scope\n" });
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "requested" });
  });

  it("unknown: no cgroup v2 line, or unreadable files", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader({ "/proc/4321/cgroup": "12:pids:/user.slice\n" });
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "unknown" });
    h.adapter.procRead = reader({});
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "unknown" });
  });

  it("a daemon that can't make scopes now still reads a seat already under its limit as applied; one outside it, unsupported", async () => {
    vi.stubEnv("MANAGERPID", "");
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("256"));
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "applied" });
    h.adapter.procRead = reader({ "/proc/4321/cgroup": "0::/user.slice/user@1000.service/openrig-tmux-1234abcd.scope\n" });
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "unsupported" });
  });

  it("seatProcessLimitsNotApplied: null when applied or without limits, the state otherwise", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("256"));
    expect(await h.adapter.seatProcessLimitsNotApplied("node-a", "impl-a@demo")).toBeNull();
    expect(await h.adapter.seatProcessLimitsNotApplied("node-b", "impl-b@demo")).toBeNull();
    h.adapter.procRead = reader(seatFiles("512"));
    expect(await h.adapter.seatProcessLimitsNotApplied("node-a", "impl-a@demo")).toMatch(/^requested/);
  });

  it("reads the cgroup v2 path only from the 0:: line", () => {
    expect(cgroupV2Path("0::/a/b.scope\n")).toBe("/a/b.scope");
    expect(cgroupV2Path("1:name=systemd:/x\n")).toBeNull();
  });
});
