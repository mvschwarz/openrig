// Seat process limits (#3253): a seat whose rig spec sets `process_limits.tasks_max` and/or `memory_max` launches its pane
// command in a transient `systemd-run --user --scope` of its own with TasksMax and/or MemoryMax as its only limits, under
// the shared tmux server; the
// other seats, the server and the daemon stay where they are. Without the option nothing changes. Where the limit can't
// be applied, a fresh launch is not started and says why: `process_limits_unsupported` only for a positive inability,
// `process_limits_unverified` (retryable, with a cached observation's age) when it is not known; a recovery (a
// handover, a provider switch, a restart in place) goes ahead without it, with a structured warning. The limit is
// reported from the kernel's readback (applied; requested, not applied; unsupported; unknown; invalid).
//
// Synthetic only: the string exec, the argv exec and the /proc readers are fakes that record what the adapter runs, so
// nothing here touches the host's systemd, cgroups or tmux.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter, SEAT_SCOPE_SLICE, cgroupV2Path, noticeLine, restoreEnvArgv } from "../src/adapters/tmux.js";
import { parseStoredProcessLimits } from "../src/domain/process-limits.js";

type Plan = string[] | null;
type Answer = string | Error;
type Probe = { scope?: Answer; bus?: Answer };
const RT = "/run/user/1000";
const fail = (stderr: string, code = 1) =>
  Object.assign(new Error(`Command failed\n${stderr}`), { execStderr: `${stderr}\n`, stderr: `${stderr}\n`, code });

const A = { OPENRIG_NODE_ID: "node-a", OPENRIG_SESSION_NAME: "impl-a@demo" };
const B = { OPENRIG_NODE_ID: "node-b", OPENRIG_SESSION_NAME: "impl-b@demo" };
// The pane's process in a seat scope, and in the terminal server's scope.
const SEAT_CG = "0::/user.slice/user@1000.service/openrigseats.slice/openrig-seat-impl-a_demo-1a2b3c4d.scope\n";
const SERVER_CG = "0::/user.slice/user@1000.service/openrig-tmux-1234abcd.scope\n";
/** The synthetic temp files (launch environment files and scope markers). */
const SYNTHETIC = /^\/tmp\/synthetic-seat-env-\d+$/;

function makeAdapter(opts: { limits?: Record<string, number | "invalid" | { tasksMax?: number; memoryMax?: number }>; inherit?: boolean; probe?: Probe; noLaunchEnvironment?: boolean;
  /** Executables missing from the daemon's PATH (the rest resolve under /usr/bin). */
  missing?: string[];
  /** Whether /run/user/<uid> exists. */
  runDir?: boolean;
  /** tmux's session and global environment listings. */
  sessionEnv?: string; globalEnv?: string;
  /** A tmux call that fails. */
  failTmux?: (args: string[]) => boolean;
  /** What a capped new-session prints instead of its identity (default "%1 $3 4242 1700000000"). */
  printed?: string;
  /** The error a kill-session (and its detach) of the refused launch's session throws. */
  killError?: string;
  /** The guarded detach finds another session under that id on a replaced server (tmux prints the marker). */
  targetChanged?: boolean } = {}) {
  const shellCalls: string[] = [];
  const argvCalls: string[][] = [];
  const get = (k: keyof Probe, fallback: string): Answer => (opts.probe && k in opts.probe ? opts.probe[k]! : fallback);
  const answer = (value: Answer) => { if (value instanceof Error) throw value; return value; };
  const exec = async (command: string) => {
    shellCalls.push(command);
    if (command.includes("openrig-seat-probe-")) {
      // The probe prints its own pids.max: by default, the TasksMax it was given. With MemoryMax, one line per limit:
      // its memory.max, then its pids.max when TasksMax was given too.
      const memory = /MemoryMax=(\d+)/.exec(command)?.[1];
      const tasks = /TasksMax=(\d+)/.exec(command)?.[1];
      if (memory !== undefined) return answer(get("scope", `memory ${memory}\n${tasks !== undefined ? `pids ${tasks}\n` : ""}`));
      return answer(get("scope", `${tasks ?? "max"}\n`));
    }
    if (command.includes("systemctl --user show")) return answer(get("bus", "255\n"));
    return "";
  };
  const argvExec = async (args: string[]) => {
    argvCalls.push(args);
    if (opts.failTmux?.(args)) throw new Error("can't find pane: %1");
    if (args.includes("show-environment")) return (args.includes("-g") ? opts.globalEnv : opts.sessionEnv) ?? "";
    if (args.some(arg => arg.includes("default-shell"))) return "/bin/bash";
    if (args.includes("#{pane_pid}")) return "4321";
    if (opts.killError && args.some(arg => arg.includes("kill-session") || arg.includes("detach-client"))) throw new Error(opts.killError);
    if (opts.targetChanged && args.some(arg => arg.includes("detach-client"))) return "openrig-stop-target-changed\n";
    // A capped new-session prints its pane, its session and its server, from the same command.
    const capped = args.includes("source-file") ? writes.at(-1)?.includes("#{session_id} #{pid} #{start_time}") : args.some(arg => arg.includes("#{session_id} #{pid}"));
    if (capped) return opts.printed ?? "%1 $3 4242 1700000000";
    return args.includes("new-session") || args.includes("source-file") ? "%1" : "";
  };
  let n = 0;
  // Commands with an environment to pass reach tmux as a file it sources: the file's text is what tmux runs.
  const writes: string[] = [];
  const files = { writeFile: async (_p: string, content: string) => { writes.push(content); }, unlink: async () => {},
    tmpName: () => `/tmp/synthetic-seat-env-${++n}`, bufferName: () => "unused" };
  const adapter = new TmuxAdapter(exec, files, argvExec);
  // #3253: the calls pinned here are a daemon's that has already checked its server's bus once (on Linux, a daemon's
  // first launch runs startServer first; tmux-server-systemd-scope.test.ts covers that).
  (adapter as unknown as { sessionBusRestorePending: boolean }).sessionBusRestorePending = false;
  adapter.resolveExecutable = (name) => (opts.missing?.includes(name) ? null : `/usr/bin/${name}`);
  adapter.dirExists = () => opts.runDir === true;
  // By default a capped start is seen at once: its marker emptied (its command ran in the scope) and the pane's process
  // in a seat scope.
  adapter.scopeStartSleep = async () => {};
  adapter.procRead = async (path: string) => {
    if (SYNTHETIC.test(path)) return "";
    if (path === "/proc/4321/cgroup") return SEAT_CG;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
  if (!opts.noLaunchEnvironment) {
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: opts.inherit === true, env: { PATH: "/bin" }, runtimeDir: RT });
  }
  if (opts.limits) {
    const limits = opts.limits;
    adapter.seatProcessLimits = (nodeId) => {
      const v = limits[nodeId];
      if (v === "invalid") throw new Error(`Seat ${nodeId} process_limits: stored value is not valid JSON`);
      return v === undefined ? undefined : typeof v === "number" ? { tasksMax: v } : v;
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

  it("the pane command, the environment files and the tmux calls are the base's, byte for byte", async () => {
    // Golden recorded by running these same fakes against the adapter before #3253 (40df4e645): an unset option must
    // leave the launch exactly as it was, not just look like the head's own control.
    const reset = 'exec /usr/bin/env -i -- TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" TERM="$TERM" TERM_PROGRAM="${TERM_PROGRAM-}" ' +
      'TERM_PROGRAM_VERSION="${TERM_PROGRAM_VERSION-}" SHELL="$SHELL" /bin/sh "$@"';
    const envFile = (n: number, extra = "") => `/bin/rm -f -- '/tmp/synthetic-seat-env-${n}'\nexport PATH='/bin'\n${extra}` +
      "export OPENRIG_NODE_ID='node-a'\nexport OPENRIG_SESSION_NAME='impl-a@demo'\nexport XDG_RUNTIME_DIR='/run/user/1000'\n" +
      "export DBUS_SESSION_BUS_ADDRESS='disabled:'\nexec \"$@\"\n";
    const off = makeAdapter();
    expect(await off.plan(A)).toEqual(["/bin/sh", "-c", reset, "sh", "/tmp/synthetic-seat-env-1", "/bin/bash", "-c", "/bin/sh"]);
    expect(await off.adapter.createSession("impl-a@demo", "/work", A)).toEqual({ ok: true });
    expect(off.shellCalls).toEqual([]);
    expect(off.argvCalls).toEqual([
      ["tmux", "show-options", "-gv", "default-shell"], ["tmux", "show-options", "-gv", "update-environment"],
      ["tmux", "show-options", "-gv", "default-shell"], ["tmux", "show-options", "-gv", "default-command"],
      ["tmux", "display-message", "-p", "#{version}"], ["tmux", "show-options", "-gv", "update-environment"],
      ["tmux", "source-file", "/tmp/synthetic-seat-env-3"], ["tmux", "show-environment", "-g"]]);
    expect(off.writes).toEqual([
      envFile(1),
      envFile(2, "export OPENRIG_TRANSCRIPTS_LINES=''\nexport OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS=''\n"),
      "new-session -d -s 'impl-a@demo' -c '/work' -e 'OPENRIG_TRANSCRIPTS_LINES=' -e 'OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS=' " +
        "-e 'OPENRIG_NODE_ID=node-a' -e 'OPENRIG_SESSION_NAME=impl-a@demo' -P -F '#{pane_id}' '/bin/sh' '-c' " +
        `'${reset}' 'sh' '/tmp/synthetic-seat-env-2' '/bin/bash' '-l'\n`]);
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
    expect(scope.slice(4, 9)).toEqual(["/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--collect"]);
    expect(scope[scope.indexOf("--slice") + 1]).toBe(SEAT_SCOPE_SLICE);
    expect(scope[scope.indexOf("--unit") + 1]).toMatch(/^openrig-seat-impl-a_demo-[0-9a-f]{8}$/);
    const props = scope.flatMap((x, i, all) => (all[i - 1] === "-p" ? [x] : []));
    expect(props).toEqual(["OOMPolicy=continue", "TasksMax=256"]);
    expect(scope).toContain("--expand-environment=no");
    // After the separator: the marker that its command started in the scope, the seat's own bus and runtime directory
    // back (systemd-run needed them set otherwise), then exactly the shell command the seat gets without a limit.
    const tail = today.slice(5);
    // (the seat's launch environment turns its session bus off on purpose: that value comes back)
    expect(normalize(a.slice(sep + 1, a.length - tail.length))).toEqual(
      ["/bin/sh", "-c", ': > "$0" && exec "$@"', "/tmp/F", "/usr/bin/env", "DBUS_SESSION_BUS_ADDRESS=disabled:", `XDG_RUNTIME_DIR=${RT}`]);
    expect(normalize(a.slice(a.length - tail.length))).toEqual(tail);
    // The other seat of the same daemon: today's command, unchanged.
    expect(normalize(await h.plan(B))).toEqual(normalize(await control.plan(B)));
  });

  it("proves the limit once per value with a throwaway scope that reads its own pids.max, and asks the bus at every launch", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    await h.plan(A); await h.plan(A);
    const probes = h.shellCalls.filter(c => c.includes("openrig-seat-probe-"));
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatch(/\/usr\/bin\/timeout 10 \/usr\/bin\/systemd-run --user --scope .*--slice openrigseats\.slice .*-p TasksMax=256 -- \/bin\/sh -c /);
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

  it("the launch runs the absolute systemd-run the check proved; the seat's PATH stays its own", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const plan = (await h.plan({ ...A, PATH: "/opt/seat/bin" }))!;
    expect(plan).toContain("/usr/bin/systemd-run");
    expect(plan).not.toContain("systemd-run");
    expect(h.shellCalls.filter(c => c.includes("openrig-seat-probe-"))[0]).toContain("/usr/bin/timeout 10 /usr/bin/systemd-run ");
    expect(h.shellCalls.filter(c => c.includes("systemctl --user show"))[0]).toContain("/usr/bin/timeout 5 /usr/bin/systemctl --user show");
    expect(h.writes.join("\n")).toContain("export PATH='/opt/seat/bin'");
    // another systemd-run (a PATH changed since, an upgrade) is proven again before it is used
    h.adapter.resolveExecutable = (name) => `/opt/systemd/bin/${name}`;
    const again = (await h.plan(A))!;
    expect(again).toContain("/opt/systemd/bin/systemd-run");
    expect(h.shellCalls.filter(c => c.includes("openrig-seat-probe-"))).toHaveLength(2);
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

describe("a fresh launch with a limit counts only once its scope is seen to start", () => {
  function seen(h: ReturnType<typeof makeAdapter>, dead: boolean, marker: string, cgroup = SEAT_CG) {
    const isDead = vi.spyOn(h.adapter, "isPaneDead").mockResolvedValue(dead);
    h.adapter.procRead = async (p: string) => {
      if (SYNTHETIC.test(p)) return marker;
      if (p === "/proc/4321/cgroup") return cgroup;
      throw new Error(`ENOENT: ${p}`);
    };
    return isDead;
  }

  it("a fresh createSession whose command started in its scope is confirmed and kept", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = seen(h, false, "");
    expect(await h.adapter.createSession("impl-a@demo", "/work", A)).toEqual({ ok: true });
    expect(dead).toHaveBeenCalledTimes(1);
    expect(h.tmuxCalls("kill-session")).toEqual([]);
  });

  it("a fresh launch whose pane died before its command started: process_limits_unverified, retryable, its session removed, never a 2nd start", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, true, "pending\n");
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: true,
      processLimits: { kind: "unverified", requested: { tasksMax: 256 }, reason: expect.stringContaining("did not start") } });
    expect(h.newSessions()).toHaveLength(1);
    // the session it made, by the identity new-session printed: never by name (a same-named session made meanwhile
    // outside the daemon stays)
    expect(h.tmuxCalls("kill-session")).toEqual([expect.stringContaining("kill-session -t '$3'")]);
    expect(h.tmuxCalls("kill-session").join("\n")).toContain("#{==:#{pid},4242}");
    expect(h.tmuxCalls("kill-session").join("\n")).not.toContain("impl-a@demo");
    expect(h.tmuxCalls("respawn-pane")).toEqual([]);
    // no second read of the identity: new-session printed it
    expect(h.argvCalls.filter(a => a[1] === "display-message" && a.some(x => x.includes("#{session_id}")))).toEqual([]);
    expect(h.writes.at(-1)).toContain("-P -F '#{pane_id} #{session_id} #{pid} #{start_time}'");
    expect((result as { message: string }).message).not.toContain("may still be running");
  });

  it("a fresh launch whose start is not confirmed in time (pane alive) is refused, its session removed, as may have run", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = seen(h, false, "pending\n", SERVER_CG);
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    // the wrapper is alive and can still start the command after the last look: no retry
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { reason: expect.stringContaining("not confirmed in time"), commandStarted: "unknown" } });
    expect(dead).toHaveBeenCalledTimes(120);
    expect(h.newSessions()).toHaveLength(1);
    expect(h.tmuxCalls("kill-session")).toEqual([expect.stringContaining("kill-session -t '$3'")]);
  });

  it("a capped new-session whose output has a line after the identity still removes that session (the first line)", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, printed: "%1 $3 4242 1700000000\nsomething a hook printed" });
    seen(h, true, "pending\n");
    expect(await h.adapter.createSession("impl-a@demo", "/work", A)).toMatchObject({ ok: false, retryable: true });
    expect(h.tmuxCalls("kill-session")).toEqual([expect.stringContaining("kill-session -t '$3'")]);
  });

  it("a refused fresh launch whose session is already gone says nothing remains", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, killError: "can't find session: $3" });
    seen(h, true, "pending\n");
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: true });
    // the guarded removal of the printed identity was tried (its detach found the session gone)
    expect(h.tmuxCalls("detach-client").join("\n")).toContain("detach-client -s '$3'");
    expect(h.tmuxCalls("detach-client").join("\n")).toContain("#{==:#{pid},4242}");
    expect((result as { message: string }).message).not.toContain("may still be running");
    expect((result as { processLimits: object }).processLimits).not.toHaveProperty("possiblyRunning");
  });

  it("a fresh launch whose command ran but whose scope can't be read says it started, removed, and suggests no retry", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, false, "");   // the marker says the command ran inside the scope
    const read = h.adapter.procRead;
    h.adapter.procRead = async (path: string) => {   // but the pane process's cgroup can't be read
      if (path === "/proc/4321/cgroup") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return read(path);
    };
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { kind: "unverified", commandStarted: true } });
    expect((result as { processLimits: object }).processLimits).not.toHaveProperty("possiblyRunning");
    const message = (result as { message: string }).message;
    expect(message).toContain("its command started");
    expect(message).toContain("its terminal was removed");
    expect(message).not.toContain("not started");
    expect(message).not.toMatch(/retry/i);
    expect(h.tmuxCalls("kill-session")).toEqual([expect.stringContaining("kill-session -t '$3'")]);
  });

  it("a fresh launch whose live wrapper times out (the command starting during the last sleep) says it may have run, no retry", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, false, "pending\n");   // the pane alive and the marker pending at every check
    let marker = "pending\n";
    const read = h.adapter.procRead;
    h.adapter.procRead = async (path: string) => (SYNTHETIC.test(path) ? marker : read(path));
    let sleeps = 0;
    h.adapter.scopeStartSleep = async () => { if (++sleeps === 120) marker = ""; };   // it starts in the final sleep
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(sleeps).toBe(120);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { kind: "unverified", commandStarted: "unknown" } });
    const message = (result as { message: string }).message;
    expect(message).toContain("its command may have started");
    expect(message).toContain("its terminal was removed");
    expect(message).not.toContain("not started");
    expect(message).not.toMatch(/retry/i);
    expect(h.tmuxCalls("kill-session")).toEqual([expect.stringContaining("kill-session -t '$3'")]);
  });

  it("a fresh launch whose pane can't be read (isPaneDead throws) says its command may have started, no retry", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, false, "pending\n");
    vi.spyOn(h.adapter, "isPaneDead").mockRejectedValue(new Error("server exited unexpectedly"));
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { commandStarted: "unknown" } });
    expect((result as { message: string }).message).not.toContain("not started");
  });

  it("a fresh launch whose pane died with an unreadable marker says its command may have started, no retry", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, true, "something else\n");
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { commandStarted: "unknown" } });
    expect((result as { message: string }).message).not.toContain("not started");
  });

  it("a fresh launch whose marker can't be read says its command may have started, and suggests no retry", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, false, "something else\n", SERVER_CG);
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { commandStarted: "unknown" } });
    expect((result as { message: string }).message).toContain("its command may have started");
    expect((result as { message: string }).message).not.toMatch(/retry/i);
  });

  it("a fresh launch that failed before its command (pane dead, marker pending) still reads not started and retryable", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, true, "pending\n");
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: true });
    expect((result as { processLimits: object }).processLimits).not.toHaveProperty("commandStarted");
    expect((result as { message: string }).message).toContain("the seat was not started");
  });

  it("a capped new-session that printed nothing and can't be read back is refused as possibly running (no retry)", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, printed: "" });
    h.adapter.probeSession = async () => { throw new Error("no server running on /tmp/tmux-1000/default"); };
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { possiblyRunning: true, commandStarted: "unknown" } });
    expect((result as { message: string }).message).toContain("kill-session -t '=impl-a@demo'");
    expect(h.tmuxCalls("kill-session")).toEqual([]);
    // a recovery never stops for the limit: the same window stays the plain session_unconfirmed
    const recovery = makeAdapter({ limits: { "node-a": 256 }, printed: "" });
    recovery.adapter.probeSession = async () => { throw new Error("no server running on /tmp/tmux-1000/default"); };
    expect(await recovery.adapter.createSession("impl-a@demo", "/work", A, { processLimitsMode: "recovery" }))
      .toMatchObject({ ok: false, code: "session_unconfirmed" });
    // positively absent: still the plain session_not_created
    const gone = makeAdapter({ limits: { "node-a": 256 }, printed: "" });
    gone.adapter.probeSession = async () => ({ state: "absent" as const });
    expect(await gone.adapter.createSession("impl-a@demo", "/work", A)).toMatchObject({ ok: false, code: "session_not_created" });
  });

  it("a refused fresh launch whose session id now names another terminal (a replaced server) reads as gone, not possibly running", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, targetChanged: true });
    seen(h, true, "pending\n");
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    // the server that held this launch's session is gone with it: a plain refusal, retryable, nothing killed
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: true });
    expect((result as { processLimits: object }).processLimits).not.toHaveProperty("possiblyRunning");
    expect((result as { message: string }).message).not.toContain("may still be running");
    expect(h.tmuxCalls("detach-client").join("\n")).toContain("detach-client -s '$3'");
    expect(h.tmuxCalls("kill-session")).toEqual([]);
  });

  it("a refused fresh launch whose session can't be removed says it may still be running, and how to stop it", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, killError: "Command failed: tmux if-shell -F -t $3\nlost server: timed out" });
    seen(h, true, "pending\n");
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    // unknown, possibly running: no blind retry
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false,
      processLimits: { kind: "unverified", possiblyRunning: true } });
    const message = (result as { message: string }).message;
    expect(message).toContain("whether its terminal is running is unknown");
    expect(message).toContain(`Its session "impl-a@demo" ($3) may still be running: it could not be removed (lost server: timed out)`);
    expect(message).toContain("kill-session -t '=impl-a@demo'");
    expect(message).not.toContain("retry the launch");
    expect(message).not.toContain("Command failed");
  });

  it("a refused fresh launch whose new-session printed no identity removes nothing (never by name) and says so", async () => {
    for (const printed of ["", "%1"]) {
      const h = makeAdapter({ limits: { "node-a": 256 }, printed });
      seen(h, true, "pending\n");
      // with nothing printed, the session is confirmed by name first
      if (printed === "") h.adapter.probeSession = async () => ({ state: "present" as const });
      const result = await h.adapter.createSession("impl-a@demo", "/work", A);
      expect(result).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: false, processLimits: { possiblyRunning: true } });
      // no pane to watch (nothing printed): whether the command started can't be told
      if (printed === "") expect(result).toMatchObject({ processLimits: { commandStarted: "unknown" } });
      expect(h.tmuxCalls("kill-session")).toEqual([]);
      expect((result as { message: string }).message).toContain(`Its session "impl-a@demo" may still be running`);
    }
  });

  it("a fresh launch whose command started in its scope and ended counts as started (the scope was seen)", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, true, "");
    expect(await h.adapter.createSession("impl-a@demo", "/work", A)).toEqual({ ok: true });
    expect(h.tmuxCalls("kill-session")).toEqual([]);
  });

  it("a fresh respawn that isn't seen to start is refused, and the pane (not this launch's) is left alone", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    seen(h, true, "pending\n");
    expect(await h.adapter.respawnPane("%1", "/bin/bash", { env: A })).toMatchObject({ ok: false, code: "process_limits_unverified", retryable: true });
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
    expect(h.tmuxCalls("kill-")).toEqual([]);
  });

  it("the marker is written pending by the daemon, emptied inside the scope, and removed after the check", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const removed: string[] = [];
    const files = (h.adapter as unknown as { fileOps: { unlink: (p: string) => Promise<void> } }).fileOps;
    files.unlink = async (p: string) => { removed.push(p); };
    expect((await h.adapter.createSession("impl-a@demo", "/work", A)).ok).toBe(true);
    expect(h.writes).toContain("pending\n");
    const created = h.newSessions()[0]!;
    const marker = /: > "\$0" && exec "\$@"'? '?(\/tmp\/synthetic-seat-env-\d+)/.exec(created)?.[1];
    expect(marker).toMatch(SYNTHETIC);
    expect(removed).toContain(marker);
  });

  it("a capped new-session that fails, or prints no pane and returns unconfirmed or not created, still removes its marker", async () => {
    const cases = [
      { mode: "recovery" as const, probe: async () => { throw new Error("no server running on /tmp/tmux-1000/default"); },
        code: "session_unconfirmed" },
      { mode: undefined, probe: async () => ({ state: "absent" as const }), code: "session_not_created" },
      { mode: "recovery" as const, probe: async () => ({ state: "absent" as const }), code: "session_not_created" },
      // the new-session itself fails
      { mode: undefined, probe: undefined, code: undefined, fail: true },
    ];
    for (const c of cases) {
      const h = makeAdapter({ limits: { "node-a": 256 }, printed: "",
        ...(c.fail ? { failTmux: (args: string[]) => args.includes("new-session") || args.includes("source-file") } : {}) });
      if (c.probe) h.adapter.probeSession = c.probe as never;
      const removed: string[] = [];
      const files = (h.adapter as unknown as { fileOps: { unlink: (p: string) => Promise<void> } }).fileOps;
      files.unlink = async (p: string) => { removed.push(p); };
      const result = await h.adapter.createSession("impl-a@demo", "/work", A, c.mode ? { processLimitsMode: c.mode } : undefined);
      expect(result).toMatchObject({ ok: false, ...(c.code ? { code: c.code } : {}) });
      const marker = /: > "\$0" && exec "\$@"'? '?(\/tmp\/synthetic-seat-env-\d+)/.exec(h.newSessions()[0]!)?.[1];
      expect(marker).toMatch(SYNTHETIC);
      expect(removed).toContain(marker);
    }
  });

  it("a capped respawn whose respawn-pane fails still removes its marker", async () => {
    for (const mode of [undefined, "recovery" as const]) {
      const h = makeAdapter({ limits: { "node-a": 256 }, failTmux: (args) => args.includes("respawn-pane") || args.includes("source-file") });
      const removed: string[] = [];
      const files = (h.adapter as unknown as { fileOps: { unlink: (p: string) => Promise<void> } }).fileOps;
      files.unlink = async (p: string) => { removed.push(p); };
      const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, ...(mode ? { processLimitsMode: mode } : {}) });
      expect(result.ok).toBe(false);
      const marker = /: > "\$0" && exec "\$@"'? '?(\/tmp\/synthetic-seat-env-\d+)/.exec(h.tmuxCalls("respawn-pane")[0]!)?.[1];
      expect(marker).toMatch(SYNTHETIC);
      expect(removed).toContain(marker);
    }
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
    ["systemd-run is missing", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: fail("/bin/sh: 1: systemd-run: not found", 127) } }), /not installed/],
    ["systemd-run is not in the daemon's PATH", () => makeAdapter({ limits: { "node-a": 256 }, missing: ["systemd-run"] }), /systemd-run is not in the daemon's PATH/],
    ["systemctl is not in the daemon's PATH", () => makeAdapter({ limits: { "node-a": 256 }, missing: ["systemctl"] }), /systemctl is not in the daemon's PATH/],
    ["systemctl without --value (systemd < 230)", () => makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("systemctl: unrecognized option '--value'") } }), /systemd is too old for seat scopes/],
    ["systemd-run without --collect (systemd < 236)", () => makeAdapter({ limits: { "node-a": 256 }, probe: { scope: fail("systemd-run: unrecognized option '--collect'") } }), /systemd is too old for seat scopes/],
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
    ["XDG_RUNTIME_DIR is unset and /run/user/<uid> does not exist", () => { vi.stubEnv("XDG_RUNTIME_DIR", ""); return makeAdapter({ limits: { "node-a": 256 } }); },
      /XDG_RUNTIME_DIR is unset and \/run\/user\/\d+ does not exist: start the daemon with XDG_RUNTIME_DIR set, or as a systemd user service/],
    ["coreutils timeout is missing", () => makeAdapter({ limits: { "node-a": 256 }, missing: ["timeout"] }), /timeout is not in the daemon's PATH/],
    ["the seat runs in an environment guest", () => { const h = makeAdapter({ limits: { "node-a": 256 } }); h.adapter.seatInEnvironmentGuest = (id) => id === "node-a"; return h; },
      /environment guest; its processes are outside this host's scope/],
    // a placement its node has not claimed yet (before the first launch) is found by the seat's session name
    ["the seat's unclaimed placement names its session", () => { const h = makeAdapter({ limits: { "node-a": 256 } });
      h.adapter.seatInEnvironmentGuest = (_id, session) => session === "impl-a@demo"; return h; },
      /environment guest; its processes are outside this host's scope/],
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

  it("XDG_RUNTIME_DIR unset but /run/user/<uid> there: the user manager is asked there", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "");
    const h = makeAdapter({ limits: { "node-a": 256 }, runDir: true });
    expect((await h.adapter.createSession("impl-a@demo", "/work", A)).ok).toBe(true);
    const dir = `/run/user/${process.getuid!()}`;
    expect(h.shellCalls.find(c => c.includes("systemctl --user show"))).toContain(`XDG_RUNTIME_DIR=${dir}`);
    expect(h.newSessions()[0]).toContain("TasksMax=256");
  });

  it("an environment guest's seat: its recovery plan and its status say so", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.seatInEnvironmentGuest = (id) => id === "node-a";
    expect(await h.adapter.seatProcessLimitsRecoveryPlan("node-a"))
      .toMatchObject({ state: "not_applied", kind: "setup", reason: expect.stringMatching(/environment guest/) });
    // the pane holds only the local viewer: even a viewer in a seat scope says nothing of the agent's processes
    expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 }, "node-a"))
      .toMatchObject({ state: "not_applied", reason: expect.stringMatching(/environment guest/) });
    expect(systemdCalls(h.shellCalls)).toEqual([]);
    // another seat is not affected
    expect(await h.adapter.seatProcessLimitsRecoveryPlan("node-b")).toBeNull();
  });

  it("the inheritance setting is read once per launch: a change mid-launch can't start the seat without its limit", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    let reads = 0;
    h.adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: reads++ > 0, env: { PATH: "/bin" }, runtimeDir: RT });
    const result = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(result).toEqual({ ok: true });
    expect(reads).toBe(1);
    expect(h.newSessions()[0]).toContain("TasksMax=256");
  });

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
    ["the probe printed something that isn't a limit", { scope: "Running as unit: openrig-seat-probe-1.scope\n" }, /could not be understood/],
    ["an error not recognized", { scope: fail("Failed to start transient scope unit: Access denied") }, /Access denied/],
    ["the user bus refused the connection (a manager starting or restarting)", { bus: fail("Failed to connect to bus: Connection refused") }, /refused the connection/],
    ["an exit status of 127 that names no systemd tool", { scope: fail("", 127) }, /failed/],
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
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unverified" } });
    // the same failure on a fresh launch is a refusal, not an unlimited start
    const fresh = await h.adapter.createSession("impl-a@demo", "/work", A);
    expect(fresh).toMatchObject({ ok: false });
  });

  // The capped launch's start, seen from the pane and its marker: "pending" (alive, the command not yet in the scope),
  // "seat" (alive, the command started in the seat scope), "dead-before" (died with the marker pending), "dead-after"
  // (died after the command started in the scope), "unreadable" (alive, the marker can't be read), "ran" (alive, the
  // marker emptied, but the pane's process not seen in the seat scope).
  type Step = "pending" | "seat" | "dead-before" | "dead-after" | "unreadable" | "ran";
  function startSeen(h: ReturnType<typeof makeAdapter>, steps: Step[]) {
    let i = 0;
    const at = () => steps[Math.min(i, steps.length - 1)]!;
    const sleep = vi.fn(async () => { i++; });
    h.adapter.scopeStartSleep = sleep;
    const dead = vi.spyOn(h.adapter, "isPaneDead").mockImplementation(async () => at().startsWith("dead"));
    h.adapter.procRead = async (p: string) => {
      if (SYNTHETIC.test(p)) {
        if (at() === "unreadable") throw new Error(`EACCES: ${p}`);
        return at() === "seat" || at() === "dead-after" || at() === "ran" ? "" : "pending\n";
      }
      if (p !== "/proc/4321/cgroup") throw new Error(`ENOENT: ${p}`);
      return at() === "seat" ? SEAT_CG : SERVER_CG;
    };
    return Object.assign(dead, { sleep });
  }

  it("a capped recovery respawn whose pane dies before its command started (systemd-run refused the scope then) starts again without it", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["dead-before"]);
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
    startSeen(h, ["pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "dead-before"]);
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unverified" } });
    const respawns = h.tmuxCalls("respawn-pane");
    expect(respawns).toHaveLength(2);
    expect(respawns[1]).not.toContain("systemd-run");
  });

  it("a capped recovery whose command started in its scope and exited is not run again: one respawn, state unknown", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    startSeen(h, ["pending", "dead-after"]);
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "unknown", kind: "unverified", retryable: true,
      commandStarted: true, requested: { tasksMax: 256 }, reason: expect.stringMatching(/started in its scope and ended.*not run again/) } });
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
    expect(result.ok && result.warnings?.join(" ")).not.toMatch(/went on without/);
  });

  it("a capped recovery whose command started but was not seen in the seat scope in time is not run again", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    startSeen(h, ["pending", "ran"]);
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "unknown", kind: "unverified", commandStarted: true,
      reason: expect.stringMatching(/not seen in the seat's scope in time; it was not run again/) } });
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
  });

  it("a capped recovery respawn is kept once its command started in the seat scope", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["pending", "pending", "seat"]);
    expect(await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" })).toEqual({ ok: true });
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
    expect(dead).toHaveBeenCalledTimes(3);
  });

  it("a start neither seen nor failed in time is kept, says unknown, and runs nothing again", async () => {
    for (const step of ["pending", "unreadable"] as const) {
      const h = makeAdapter({ limits: { "node-a": 256 } });
      const dead = startSeen(h, [step]);
      const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
      expect(result).toMatchObject({ ok: true, processLimits: { state: "unknown", kind: "unverified", commandStarted: "unknown",
        reason: expect.stringMatching(/not confirmed in time/) }, warnings: [expect.stringMatching(/whether the seat runs under the limit is unknown/)] });
      expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
      expect(dead).toHaveBeenCalledTimes(120);
    }
  });

  it("a provider switch's staged successor (createSession in recovery) whose scope fails late starts again without it", async () => {
    for (const kept of [false, true]) {
      const h = makeAdapter({ limits: { "node-a": 256 } });
      startSeen(h, ["pending", "pending", "pending", "dead-before"]);
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

  it("a staged successor whose scope starts is kept", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["seat"]);
    expect(await h.adapter.createSession("impl-a@demo", "/work", A, { processLimitsMode: "recovery" })).toEqual({ ok: true });
    expect(h.newSessions()).toHaveLength(1);
    expect(dead).toHaveBeenCalledTimes(1);
  });

  it("a recovery whose scoped environment fails after the scope check: not_applied, and no start check", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    const dead = startSeen(h, ["seat"]);
    vi.spyOn(h.adapter, "getDefaultShell").mockResolvedValue(null);
    vi.spyOn(h.adapter, "startServer").mockResolvedValue({ ok: false, code: "x", message: "x" } as never);
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unverified",
      reason: expect.stringMatching(/scoped launch environment failed/) } });
    expect(result.ok && result.warnings?.join(" ")).not.toMatch(/not confirmed/);
    expect(dead).not.toHaveBeenCalled();
    expect(dead.sleep).not.toHaveBeenCalled();
  });

  it("the not-applied line is logged only once the launch went on without the limit", async () => {
    const lines = () => vi.mocked(console.warn).mock.calls.filter(c => /process_limits requested/.test(String(c[0])));
    const failing = makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("", 124) }, failTmux: (args) => args.includes("source-file") });
    expect(await failing.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" })).toMatchObject({ ok: false });
    expect(lines()).toEqual([]);
    const h = makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("", 124) } });
    expect(await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" })).toMatchObject({ ok: true });
    expect(lines()).toHaveLength(1);
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
  const SCOPE = "/user.slice/user-1000.slice/user@1000.service/openrigseats.slice/openrig-seat-impl-a_demo-1a2b3c4d.scope";
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
    // a readback that fails is unknown, never that the seat went on without the limit
    h.adapter.procRead = reader({});
    const unknown = await h.adapter.seatProcessLimitsNotApplied("node-a", "impl-a@demo");
    expect(unknown).toMatchObject({ state: "unknown", kind: "unverified", retryable: true, requested: { tasksMax: 256 },
      reason: expect.stringMatching(/whether it is under the limit can't be read back/) });
    expect(noticeLine(unknown!)).toMatch(/whether the seat runs under the limit is unknown/);
    expect(noticeLine(unknown!)).not.toMatch(/went on without/);
  });

  it("reads the seat's own pane when given its id (%N), not the session's active pane", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    h.adapter.procRead = reader(seatFiles("256"));
    expect(await h.adapter.readSeatProcessLimits("%7", { tasksMax: 256 })).toMatchObject({ state: "applied" });
    expect(h.argvCalls.find(a => a.includes("#{pane_pid}"))).toEqual(["tmux", "display-message", "-p", "-t", "%7", "#{pane_pid}"]);
  });

  it("a bare respawn's keep plan: kept only where the readback is applied and a new scope can be made", async () => {
    const h = makeAdapter({ limits: { "node-a": 256, "node-x": "invalid" } });
    h.adapter.procRead = reader(seatFiles("256"));
    expect(await h.adapter.seatProcessLimitsKeepPlan("node-a", "%1")).toEqual({ keep: true });
    expect(await h.adapter.seatProcessLimitsKeepPlan("node-b", "%1")).toBeNull();
    expect(await h.adapter.seatProcessLimitsKeepPlan("node-x", "%1")).toMatchObject({ keep: false, notice: { kind: "invalid" } });
    h.adapter.procRead = reader(OUTSIDE);
    expect(await h.adapter.seatProcessLimitsKeepPlan("node-a", "%1")).toMatchObject({ keep: false,
      notice: { state: "not_applied", kind: "setup", reason: expect.stringMatching(/keeps only a limit that reads back as applied; it is not under the limit/) } });
    h.adapter.procRead = reader({});
    expect(await h.adapter.seatProcessLimitsKeepPlan("node-a", "%1")).toMatchObject({ keep: false,
      notice: { state: "not_applied", kind: "unverified", retryable: true, reason: expect.stringMatching(/can't be read back/) } });
    const noBus = makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("", 124) } });
    noBus.adapter.procRead = reader(seatFiles("256"));
    expect(await noBus.adapter.seatProcessLimitsKeepPlan("node-a", "%1")).toMatchObject({ keep: false,
      notice: { kind: "unverified", reason: expect.stringMatching(/runs under its limit, but .*timed out/) } });
  });
});

describe("a bare respawn that keeps the seat's limit (a restart in place of a seat under it)", () => {
  it("runs the command as the default shell would, in a new scope, with the bus and runtime directory tmux would give it", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, sessionEnv: "DBUS_SESSION_BUS_ADDRESS=disabled:\n", globalEnv: `XDG_RUNTIME_DIR=${RT}\n` });
    const result = await h.adapter.respawnPane("%1", "codex resume 'T'", { cwd: "/work", keepLimitOf: "node-a" });
    expect(result).toEqual({ ok: true });
    const respawn = h.argvCalls.find(a => a.includes("respawn-pane"))!;
    expect(respawn).not.toContain("-e");
    const sep = respawn.indexOf("--");
    expect(respawn.slice(respawn.indexOf("/usr/bin/systemd-run"), sep)).toContain("TasksMax=256");
    expect(normalize(respawn.slice(sep + 1))).toEqual(["/bin/sh", "-c", ': > "$0" && exec "$@"', "/tmp/F",
      "/usr/bin/env", "DBUS_SESSION_BUS_ADDRESS=disabled:", `XDG_RUNTIME_DIR=${RT}`, "/bin/bash", "-c", "codex resume 'T'"]);
  });

  it("a session that removed a variable gets it removed, not the server's", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, sessionEnv: "-XDG_RUNTIME_DIR\n", globalEnv: `XDG_RUNTIME_DIR=${RT}\n` });
    await h.adapter.respawnPane("%1", "codex", { keepLimitOf: "node-a" });
    const respawn = h.argvCalls.find(a => a.includes("respawn-pane"))!.join(" ");
    expect(respawn).toContain("/usr/bin/env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR /bin/bash -c codex");
  });

  it("a scope that can't be made now: the respawn is today's, with the warning", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "max\n" } });
    const result = await h.adapter.respawnPane("%1", "codex", { keepLimitOf: "node-a" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", kind: "unsupported" } });
    expect(h.argvCalls.find(a => a.includes("respawn-pane"))).toEqual(["tmux", "respawn-pane", "-t", "%1", "codex"]);
  });

  it("a kept scope that fails before the command runs it again without the limit, once", async () => {
    const h = makeAdapter({ limits: { "node-a": 256 } });
    vi.spyOn(h.adapter, "isPaneDead").mockResolvedValue(true);
    h.adapter.procRead = async (p: string) => { if (SYNTHETIC.test(p)) return "pending\n"; throw new Error(`ENOENT: ${p}`); };
    const result = await h.adapter.respawnPane("%1", "codex", { keepLimitOf: "node-a" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", reason: expect.stringContaining("did not start") } });
    const respawns = h.argvCalls.filter(a => a.includes("respawn-pane"));
    expect(respawns).toHaveLength(2);
    expect(respawns[1]).toEqual(["tmux", "respawn-pane", "-t", "%1", "codex"]);
  });

  it("reads the cgroup v2 path only from the 0:: line", () => {
    expect(cgroupV2Path("0::/a/b.scope\n")).toBe("/a/b.scope");
    expect(cgroupV2Path("1:name=systemd:/x\n")).toBeNull();
  });
});

describe("a seat with memory_max (alone or beside tasks_max)", () => {
  const G = 1073741824;
  const props = (plan: Plan) => {
    const a = plan!;
    const scope = a.slice(5, a.indexOf("--"));
    return scope.flatMap((x, i, all) => (all[i - 1] === "-p" ? [x] : []));
  };

  it("only memory: MemoryMax in bytes is the seat scope's only limit, with no TasksMax", async () => {
    const h = makeAdapter({ limits: { "node-a": { memoryMax: G } } });
    expect(props(await h.plan(A))).toEqual(["OOMPolicy=continue", `MemoryMax=${G}`]);
  });

  it("both: one scope with TasksMax and MemoryMax, in that order", async () => {
    const h = makeAdapter({ limits: { "node-a": { tasksMax: 256, memoryMax: G } } });
    expect(props(await h.plan(A))).toEqual(["OOMPolicy=continue", "TasksMax=256", `MemoryMax=${G}`]);
  });

  it("proves once per pair of limits: a memory limit is never taken as proven by a scope that had only the task limit", async () => {
    const limits: Record<string, { tasksMax?: number; memoryMax?: number }> = { "node-a": { tasksMax: 256 } };
    const h = makeAdapter({ limits });
    const probes = () => h.shellCalls.filter(c => c.includes("openrig-seat-probe-"));
    await h.plan(A); await h.plan(A);
    expect(probes()).toHaveLength(1);
    limits["node-a"] = { tasksMax: 256, memoryMax: G };
    await h.plan(A); await h.plan(A);
    expect(probes()).toHaveLength(2);
    expect(probes()[1]).toContain(`-p TasksMax=256 -p MemoryMax=${G} --`);
    limits["node-a"] = { tasksMax: 256, memoryMax: 2 * G };
    await h.plan(A);
    expect(probes()).toHaveLength(3);
  });

  it("the memory probe reads memory.max (and pids.max only with tasks_max) with shell builtins only", async () => {
    const memory = makeAdapter({ limits: { "node-a": { memoryMax: G } } });
    await memory.plan(A);
    const probe = memory.shellCalls.find(c => c.includes("openrig-seat-probe-"))!;
    expect(probe).toContain("memory.max");
    expect(probe).not.toContain("pids.max");
    expect(probe).not.toMatch(/\$\(|\bsed\b|\bcat\b/);
    const both = makeAdapter({ limits: { "node-a": { tasksMax: 1, memoryMax: G } } });
    await both.plan(A);
    const bothProbe = both.shellCalls.find(c => c.includes("openrig-seat-probe-"))!;
    expect(bothProbe).toContain("memory.max");
    expect(bothProbe).toContain("pids.max");
    expect(bothProbe).not.toMatch(/\$\(|\bsed\b|\bcat\b/);
  });

  it("a seat with only memory_max doesn't judge the scope's pids.max", async () => {
    const h = makeAdapter({ limits: { "node-a": { memoryMax: G } }, probe: { scope: `memory ${G}\npids max\n` } });
    expect(await h.adapter.createSession("impl-a@demo", "/work", A)).toEqual({ ok: true });
  });

  it("a respawn with the seat's environment carries MemoryMax", async () => {
    const h = makeAdapter({ limits: { "node-a": { memoryMax: G } } });
    expect(await h.adapter.respawnPane("%1", "/bin/bash", { env: A })).toEqual({ ok: true });
    const respawn = h.tmuxCalls("respawn-pane")[0]!;
    expect(respawn).toContain(`MemoryMax=${G}`);
    expect(respawn).not.toContain("TasksMax=");
  });

  const unsupported: Array<[string, Probe, RegExp, "memory_max" | "tasks_max", { tasksMax?: number; memoryMax?: number }]> = [
    ["no memory.max (the memory controller is not delegated)", { scope: "memory nomemory\n" }, /memory controller is not delegated/, "memory_max", { memoryMax: G }],
    ["memory.max reads max", { scope: "memory max\n" }, new RegExp(`memory\\.max "max" for MemoryMax=${G}: the memory limit is not enforced`), "memory_max", { memoryMax: G }],
    ["systemd refuses MemoryMax=", { scope: fail(`Unknown assignment: MemoryMax=${G}`) }, /systemd refused MemoryMax=/, "memory_max", { memoryMax: G }],
    ["both asked, the memory limit not enforced", { scope: "memory max\npids 256\n" }, /memory limit is not enforced/, "memory_max", { tasksMax: 256, memoryMax: G }],
    ["both asked, the task limit not enforced", { scope: `memory ${G}\npids max\n` }, /pids limit is not enforced/, "tasks_max", { tasksMax: 256, memoryMax: G }],
  ];
  for (const [name, probe, reason, limit, requested] of unsupported) {
    it(`unsupported, naming the limit, and the whole seat refused: ${name}`, async () => {
      const r = await freshRefused(makeAdapter({ limits: { "node-a": requested }, probe }), "process_limits_unsupported");
      expect(r.message).toMatch(reason);
      expect(r).toMatchObject({ retryable: false, processLimits: { kind: "unsupported", limit, requested } });
    });
  }

  it("a memory.max the probe can't read, or can't understand, is unverified", async () => {
    for (const [scope, reason] of [["\n", /read no memory\.max/], ["memory lots\n", /memory\.max read could not be understood/]] as const) {
      const r = await freshRefused(makeAdapter({ limits: { "node-a": { memoryMax: G } }, probe: { scope } }), "process_limits_unverified");
      expect(r.message).toMatch(reason);
      expect(r).toMatchObject({ retryable: true, processLimits: { kind: "unverified", requested: { memoryMax: G } } });
    }
  });

  it("a probe ended by SIGKILL under memory_max (the limit's OOM kill or any other) says only what was seen, retryable", async () => {
    const M = 1048576;
    // Each wording names only what was reported: the signal alone (no exit code) or the exit status 137.
    const killed = [
      [Object.assign(new Error("Command failed"), { signal: "SIGKILL", code: null }), "was killed by SIGKILL \\(no exit code\\)"],
      [Object.assign(new Error("Command failed"), { code: 137 }), "exited with status 137 \\(128 \\+ SIGKILL\\)"],
    ] as const;
    for (const [scope, seen] of killed) {
      const h = makeAdapter({ limits: { "node-a": { memoryMax: M } }, probe: { scope } });
      const r = await freshRefused(h, "process_limits_unverified");
      expect(r.message).toMatch(new RegExp(`the probe command ${seen} under the requested ` +
        `MemoryMax=${M}; the process and the cause aren't confirmed; a larger memory_max may help`));
      if (scope.code === null) expect(r.message).not.toMatch(/137/);
      else expect(r.message).not.toMatch(/no exit code/);
      expect(r.processLimits?.reason ?? "").not.toMatch(/OOM|\/bin\/sh was killed|too small/);
      expect(r).toMatchObject({ retryable: true, processLimits: { kind: "unverified", limit: "memory_max", requested: { memoryMax: M } } });
    }
    // A tasks-only probe killed the same way says nothing of a memory value: unverified, with no limit named.
    const tasks = makeAdapter({ limits: { "node-a": 256 }, probe: { scope: killed[1][0] } });
    const t = await freshRefused(tasks, "process_limits_unverified");
    expect(t.processLimits).toMatchObject({ kind: "unverified" });
    expect(t.processLimits).not.toHaveProperty("limit");
  });

  it("a memory_max probe that dies another way (not SIGKILL) is the plain unverified failure, with no OOM claim", async () => {
    for (const scope of [Object.assign(new Error("Command failed"), { signal: "SIGTERM", code: null }),
      Object.assign(new Error("Command failed"), { code: 143 }), fail("sh: 1: something broke", 2)]) {
      const r = await freshRefused(makeAdapter({ limits: { "node-a": { memoryMax: G } }, probe: { scope } }), "process_limits_unverified");
      expect(r.message).toMatch(/a throwaway seat scope failed/);
      expect(r.message).not.toMatch(/OOM|SIGKILL|larger memory_max/);
      expect(r).toMatchObject({ retryable: true, processLimits: { kind: "unverified", requested: { memoryMax: G } } });
      expect(r.processLimits).not.toHaveProperty("limit");
    }
  });

  it("a recovery without the scope goes on, its warning naming memory_max", async () => {
    const h = makeAdapter({ limits: { "node-a": { memoryMax: G } }, probe: { scope: "memory nomemory\n" } });
    expect(await h.adapter.seatProcessLimitsRecoveryPlan("node-a")).toMatchObject({ state: "not_applied", kind: "unsupported",
      limit: "memory_max", requested: { memoryMax: G }, retryable: false });
    const result = await h.adapter.respawnPane("%1", "/bin/bash", { env: A, processLimitsMode: "recovery" });
    expect(result).toMatchObject({ ok: true, processLimits: { state: "not_applied", limit: "memory_max", requested: { memoryMax: G } } });
    expect(h.tmuxCalls("respawn-pane")[0]).not.toContain("systemd-run");
  });

  it("a stored memory_max of 0 is that seat's invalid; another seat launches", async () => {
    const h = makeAdapter();
    h.adapter.seatProcessLimits = (nodeId) =>
      parseStoredProcessLimits(nodeId === "node-a" ? '{"memory_max":0}' : null, `Seat ${nodeId} process_limits`);
    const r = await freshRefused(h, "process_limits_invalid");
    expect(r.message).toMatch(/process_limits\.memory_max/);
  });

  describe("readback", () => {
    const SCOPE = "/user.slice/user-1000.slice/user@1000.service/openrigseats.slice/openrig-seat-impl-a_demo-1a2b3c4d.scope";
    const reader = (files: Record<string, string>) => async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path]!;
    };
    const memoryFiles = (memoryMax: string, events = "low 0\nhigh 0\nmax 4\noom 1\noom_kill 1\noom_group_kill 0\n") => ({
      "/proc/4321/cgroup": `0::${SCOPE}\n`,
      [`/sys/fs/cgroup${SCOPE}/memory.max`]: `${memoryMax}\n`,
      [`/sys/fs/cgroup${SCOPE}/memory.current`]: "52428800\n",
      [`/sys/fs/cgroup${SCOPE}/memory.events`]: events,
    });
    const pidsFiles = (pidsMax: string) => ({
      [`/sys/fs/cgroup${SCOPE}/pids.max`]: `${pidsMax}\n`,
      [`/sys/fs/cgroup${SCOPE}/pids.current`]: "37\n",
      [`/sys/fs/cgroup${SCOPE}/pids.events`]: "max 2\n",
    });

    const OUTSIDE_M = { "/proc/4321/cgroup": "0::/user.slice/user@1000.service/openrig-tmux-1234abcd.scope\n" };

    it("a failed memory probe makes only a memory request's status unsupported, not a tasks-only seat's; a host-wide one, both", async () => {
      const h = makeAdapter({ limits: { "node-a": { memoryMax: G } }, probe: { scope: "memory nomemory\n" } });
      await h.adapter.createSession("impl-a@demo", "/work", A);
      h.adapter.procRead = reader(OUTSIDE_M);
      expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { memoryMax: G }))
        .toMatchObject({ state: "unsupported", reason: expect.stringMatching(/memory controller is not delegated.*observed \d+s ago/) });
      expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256 })).toMatchObject({ state: "not_applied" });
      const noPids = makeAdapter({ limits: { "node-a": 256 }, probe: { scope: "max\n" } });
      await noPids.adapter.createSession("impl-a@demo", "/work", A);
      noPids.adapter.procRead = reader(OUTSIDE_M);
      expect(await noPids.adapter.readSeatProcessLimits("impl-a@demo", { memoryMax: G })).toMatchObject({ state: "not_applied" });
      // a host-wide inability seen on a tasks-only launch (no user manager) is about every limit
      const noBus = makeAdapter({ limits: { "node-a": 256 }, probe: { bus: fail("Failed to connect to bus: No such file or directory") } });
      await noBus.adapter.createSession("impl-a@demo", "/work", A);
      noBus.adapter.procRead = reader(OUTSIDE_M);
      expect(await noBus.adapter.readSeatProcessLimits("impl-a@demo", { memoryMax: G }))
        .toMatchObject({ state: "unsupported", reason: expect.stringMatching(/no systemd user manager is running.*observed \d+s ago/) });
    });

    it("applied: memory.max is the limit; the limit hits and the OOM kills are counted apart, and pids aren't read", async () => {
      const h = makeAdapter({ limits: { "node-a": { memoryMax: G } } });
      h.adapter.procRead = reader(memoryFiles(String(G)));
      expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { memoryMax: G })).toEqual({
        state: "applied", requested: { memoryMax: G }, scope: "openrig-seat-impl-a_demo-1a2b3c4d.scope",
        memoryMax: String(G), memoryCurrent: 52428800, memoryLimitHits: 4, oomKills: 1,
      });
    });

    it("both: applied only when each reads its value; a memory.max of max is not applied, the reason naming it", async () => {
      const h = makeAdapter({ limits: { "node-a": { tasksMax: 256, memoryMax: G } } });
      h.adapter.procRead = reader({ ...memoryFiles(String(G)), ...pidsFiles("256") });
      expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256, memoryMax: G })).toEqual({
        state: "applied", requested: { tasksMax: 256, memoryMax: G }, scope: "openrig-seat-impl-a_demo-1a2b3c4d.scope",
        pidsMax: "256", pidsCurrent: 37, limitHits: 2, memoryMax: String(G), memoryCurrent: 52428800, memoryLimitHits: 4, oomKills: 1,
      });
      h.adapter.procRead = reader({ ...memoryFiles("max"), ...pidsFiles("256") });
      const report = await h.adapter.readSeatProcessLimits("impl-a@demo", { tasksMax: 256, memoryMax: G });
      expect(report).toMatchObject({ state: "not_applied", pidsMax: "256", memoryMax: "max" });
      expect(report.reason).toBe(`memory.max is max, not ${G}; the limit applies at its next fresh launch`);
    });

    it("unknown: an unreadable memory.events", async () => {
      const h = makeAdapter({ limits: { "node-a": { memoryMax: G } } });
      const { [`/sys/fs/cgroup${SCOPE}/memory.events`]: _events, ...files } = memoryFiles(String(G));
      h.adapter.procRead = reader(files);
      expect(await h.adapter.readSeatProcessLimits("impl-a@demo", { memoryMax: G })).toMatchObject({ state: "unknown" });
    });

    it("a bare respawn's keep plan keeps the scope only when both limits read back as applied", async () => {
      const h = makeAdapter({ limits: { "node-a": { tasksMax: 256, memoryMax: G } } });
      h.adapter.procRead = reader({ ...memoryFiles(String(G)), ...pidsFiles("256") });
      expect(await h.adapter.seatProcessLimitsKeepPlan("node-a", "%1")).toEqual({ keep: true });
      h.adapter.procRead = reader({ ...memoryFiles("max"), ...pidsFiles("256") });
      expect(await h.adapter.seatProcessLimitsKeepPlan("node-a", "%1")).toMatchObject({ keep: false,
        notice: { state: "not_applied", kind: "setup", requested: { tasksMax: 256, memoryMax: G },
          reason: expect.stringMatching(/memory\.max is max/) } });
    });
  });
});

describe("restoreEnvArgv (#3253)", () => {
  it("puts every unset before any assignment, since env reads the first word after an assignment as the command", () => {
    expect(restoreEnvArgv({ DBUS_SESSION_BUS_ADDRESS: "disabled:", XDG_RUNTIME_DIR: undefined }))
      .toEqual(["/usr/bin/env", "-u", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS=disabled:"]);
    expect(restoreEnvArgv({ DBUS_SESSION_BUS_ADDRESS: undefined, XDG_RUNTIME_DIR: "/run/user/1000" }))
      .toEqual(["/usr/bin/env", "-u", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR=/run/user/1000"]);
    expect(restoreEnvArgv({ DBUS_SESSION_BUS_ADDRESS: "disabled:", XDG_RUNTIME_DIR: "/run/user/1000" }))
      .toEqual(["/usr/bin/env", "DBUS_SESSION_BUS_ADDRESS=disabled:", "XDG_RUNTIME_DIR=/run/user/1000"]);
  });
});
