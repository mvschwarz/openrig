// Per-rig seat grouping (#80): a rig whose spec sets `seat_slice: rig` launches every seat in a scope beneath its own slice
// under openrigseats.slice (`openrigseats-<rig>.slice`), seats without process limits too, and OpenRig sets no property
// on that slice. Off, every launch is exactly as before. Where the grouped scope can't be made, the launch takes today's
// path (the ungrouped scope of a seat with a limit, the plain launch of one without) and reports "grouping not applied":
// grouping never refuses a launch, skips a limit check or drops a limit.
//
// Synthetic only: the string exec, the argv exec and the /proc readers are fakes that record what the adapter runs, so
// nothing here touches the host's systemd, cgroups or tmux. tmux-seat-slice.integration.test.ts runs a real user manager.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

type Answer = string | Error;
const RT = "/run/user/1000";
const fail = (stderr: string, code = 1) =>
  Object.assign(new Error(`Command failed\n${stderr}`), { execStderr: `${stderr}\n`, stderr: `${stderr}\n`, code });

const A = { OPENRIG_NODE_ID: "node-a", OPENRIG_SESSION_NAME: "impl-a@alpha" };
const B = { OPENRIG_NODE_ID: "node-b", OPENRIG_SESSION_NAME: "impl-b@lab-b" };
const SEAT_CG = "0::/user.slice/user@1000.service/openrigseats.slice/openrigseats-alpha.slice/openrig-seat-impl-a_alpha-1a2b3c4d.scope\n";
const SYNTHETIC = /^\/tmp\/synthetic-seat-env-\d+$/;
const MANAGER = "/user.slice/user@1000.service";

function makeAdapter(opts: {
  /** The rig each node's seats group under (rig spec `seat_slice: rig`); a node absent here is in a rig that doesn't. */
  sliceRigs?: Record<string, string>; sliceRigThrows?: boolean;
  limits?: Record<string, { tasksMax?: number; memoryMax?: number }>;
  /** What a probe beneath a rig slice prints or throws (default: its own cgroup path beneath that slice). */
  groupedProbe?: Answer;
  /** tmux's session and global environment listings. */
  sessionEnv?: string; globalEnv?: string } = {}) {
  const shellCalls: string[] = [];
  const argvCalls: string[][] = [];
  const writes: string[] = [];
  const answer = (value: Answer) => { if (value instanceof Error) throw value; return value; };
  const exec = async (command: string) => {
    shellCalls.push(command);
    if (command.includes("openrig-seat-probe-")) {
      const slice = /--slice '?([^' ]+)'?/.exec(command)?.[1] ?? "";
      const unit = /--unit '?(openrig-seat-probe-[0-9a-f]+)'?/.exec(command)?.[1] ?? "";
      const memory = /MemoryMax=(\d+)/.exec(command)?.[1];
      const tasks = /TasksMax=(\d+)/.exec(command)?.[1];
      if (slice !== "openrigseats.slice" && opts.groupedProbe !== undefined) return answer(opts.groupedProbe);
      if (memory !== undefined) return `memory ${memory}\n${tasks !== undefined ? `pids ${tasks}\n` : ""}`;
      if (tasks !== undefined) return `${tasks}\n`;
      // A probe with no limit prints its own cgroup path: systemd nests a dashed slice under openrigseats.slice.
      return `${MANAGER}/openrigseats.slice/${slice}/${unit}.scope\n`;
    }
    if (command.includes("systemctl --user show")) return "255\n";
    return "";
  };
  const argvExec = async (args: string[]) => {
    argvCalls.push(args);
    if (args.includes("show-environment")) return (args.includes("-g") ? opts.globalEnv : opts.sessionEnv) ?? "";
    if (args.some(arg => arg.includes("default-shell"))) return "/bin/bash";
    if (args.includes("#{pane_pid}")) return "4321";
    const capped = args.includes("source-file") ? writes.at(-1)?.includes("#{session_id} #{pid} #{start_time}") : args.some(arg => arg.includes("#{session_id} #{pid}"));
    if (capped) return "%1 $3 4242 1700000000";
    return args.includes("new-session") || args.includes("source-file") ? "%1" : "";
  };
  let n = 0;
  const files = { writeFile: async (_p: string, content: string) => { writes.push(content); }, unlink: async () => {},
    tmpName: () => `/tmp/synthetic-seat-env-${++n}`, bufferName: () => "unused" };
  const adapter = new TmuxAdapter(exec, files, argvExec);
  adapter.resolveExecutable = (name) => `/usr/bin/${name}`;
  adapter.dirExists = () => false;
  adapter.scopeStartSleep = async () => {};
  adapter.procRead = async (path: string) => {
    if (SYNTHETIC.test(path)) return "";
    if (path === "/proc/4321/cgroup") return SEAT_CG;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
  adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { PATH: "/bin" }, runtimeDir: RT });
  if (opts.limits) {
    const limits = opts.limits;
    adapter.seatProcessLimits = (nodeId) => limits[nodeId];
  }
  if (opts.sliceRigs || opts.sliceRigThrows) {
    const rigs = opts.sliceRigs ?? {};
    adapter.seatSliceRig = (nodeId) => {
      if (opts.sliceRigThrows) throw new Error("no such column: seat_slice");
      return rigs[nodeId];
    };
  }
  const plan = async (env: Record<string, string>, command = "/bin/sh") => {
    const warnings: string[] = [];
    const argv = await (adapter as unknown as { scopedLaunchCommand(e: Record<string, string>, c: string, w: string[]): Promise<string[] | null> })
      .scopedLaunchCommand(env, command, warnings);
    return { argv, warnings, text: argv?.join(" ") ?? "" };
  };
  const tmuxCalls = (verb: string) => [...argvCalls.map(a => a.join(" ")), ...shellCalls, ...writes].filter(c => c.includes(verb));
  // Each launch's pane command (new-session or respawn-pane, direct or through a sourced file) that enters a seat scope.
  const seatScopes = () => [...argvCalls.map(a => a.join(" ")), ...writes]
    .filter(c => (c.includes("new-session") || c.includes("respawn-pane")) && c.includes("systemd-run"));
  return { adapter, plan, shellCalls, argvCalls, writes, tmuxCalls, seatScopes };
}

/** The `--slice` a launch's systemd-run names, or null when it has no seat scope. */
const sliceOf = (text: string) => /--slice'? '?([^'\s]+)/.exec(text)?.[1] ?? null;
const normalize = (argv: string[] | null) => argv?.map(x => x.replace(/synthetic-seat-env-\d+/, "F")) ?? null;

let platform: PropertyDescriptor | undefined;
beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.stubEnv("XDG_RUNTIME_DIR", RT);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a rig with seat_slice: rig puts every seat it launches beneath its own slice", () => {
  it("a seat without a limit gets a scope with no limit, beneath openrigseats-<rig>.slice", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" } });
    const { argv, warnings, text } = await h.plan(A);
    expect(sliceOf(text)).toBe("openrigseats-alpha.slice");
    expect(argv).toContain("--scope");
    expect(text).not.toMatch(/TasksMax|MemoryMax/);
    // OpenRig sets no property but OOMPolicy on the scope, and none on any slice: weights stay with the user manager.
    expect(h.shellCalls.join("\n")).not.toMatch(/CPUWeight|CPUQuota|set-property/);
    expect(warnings).toEqual([]);
  });

  it("a seat with limits keeps every one of them, beneath its rig's slice", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" }, limits: { "node-a": { tasksMax: 256, memoryMax: 1073741824 } } });
    const { text, warnings } = await h.plan(A);
    expect(sliceOf(text)).toBe("openrigseats-alpha.slice");
    expect(text).toContain("TasksMax=256");
    expect(text).toContain("MemoryMax=1073741824");
    expect(warnings).toEqual([]);
  });

  it("two rigs: each seat goes beneath its own rig's slice, the rig name escaped as systemd escapes it", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha", "node-b": "lab-b" }, limits: { "node-b": { tasksMax: 64 } } });
    expect(sliceOf((await h.plan(A)).text)).toBe("openrigseats-alpha.slice");
    // a dash is nesting in a slice name: lab-b is one level, beneath openrigseats.slice
    expect(sliceOf((await h.plan(B)).text)).toBe("openrigseats-lab\\x2db.slice");
  });

  it("a probe beneath the rig's slice proves where its scope ran", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" } });
    await h.plan(A);
    const probe = h.shellCalls.find(c => c.includes("openrig-seat-probe-"))!;
    expect(sliceOf(probe)).toBe("openrigseats-alpha.slice");
    expect(probe).toContain("/proc/self/cgroup");
  });
});

describe("a rig without seat_slice launches exactly as before", () => {
  it("a seat without a limit gets no scope and no systemd call; one with a limit gets the ungrouped openrigseats.slice", async () => {
    const off = makeAdapter({ limits: { "node-b": { tasksMax: 64 } } });
    const plain = await off.plan(A);
    expect(plain.text).not.toContain("systemd-run");
    expect(off.shellCalls.filter(c => c.includes("systemd-run") || c.includes("systemctl"))).toEqual([]);
    expect(sliceOf((await off.plan(B)).text)).toBe("openrigseats.slice");
    // a daemon with the setting wired but the rig not grouping is the same
    const wired = makeAdapter({ sliceRigs: {}, limits: { "node-b": { tasksMax: 64 } } });
    expect(normalize((await wired.plan(A)).argv)).toEqual(normalize(plain.argv));
    expect(sliceOf((await wired.plan(B)).text)).toBe("openrigseats.slice");
  });
});

describe("grouping that can't be applied: today's path, reported, never a refusal or a dropped limit", () => {
  const notApplied = expect.arrayContaining([expect.stringContaining("grouping not applied")]);

  it("a limited seat whose grouped scope can't be made keeps its limit in the ungrouped scope", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" }, limits: { "node-a": { tasksMax: 256 } },
      groupedProbe: fail("Failed to start transient scope unit: Unit openrigseats-alpha.slice failed to load properly") });
    const { text, warnings } = await h.plan(A);
    expect(sliceOf(text)).toBe("openrigseats.slice");
    expect(text).toContain("TasksMax=256");
    expect(warnings).toEqual(notApplied);
    expect(warnings.join("\n")).toContain("failed to load properly");
  });

  it("a seat without a limit whose grouped scope can't be made launches plainly, as without grouping", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" }, groupedProbe: fail("Failed to start transient scope unit: Access denied") });
    const { argv, warnings } = await h.plan(A);
    const plain = await makeAdapter().plan(A);
    expect(normalize(argv)).toEqual(normalize(plain.argv));
    expect(warnings).toEqual(notApplied);
  });

  it("a scope that ran elsewhere than beneath the rig's slice is not grouping", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" }, groupedProbe: `${MANAGER}/app.slice/openrig-seat-probe-0000.scope\n` });
    const { text, warnings } = await h.plan(A);
    expect(text).not.toContain("systemd-run");
    expect(warnings.join("\n")).toMatch(/grouping not applied: .*not beneath openrigseats-alpha\.slice/);
  });

  it("a rig name too long for a unit name, or a setting that can't be read, takes today's path with the reason", async () => {
    const long = makeAdapter({ sliceRigs: { "node-a": "x".repeat(300) }, limits: { "node-a": { tasksMax: 256 } } });
    const one = await long.plan(A);
    expect(sliceOf(one.text)).toBe("openrigseats.slice");
    expect(one.warnings.join("\n")).toMatch(/grouping not applied: .*255/);
    const unreadable = makeAdapter({ sliceRigThrows: true });
    const two = await unreadable.plan(A);
    expect(two.text).not.toContain("systemd-run");
    expect(two.warnings.join("\n")).toContain("seat_slice could not be read");
  });
});

describe("a grouped scope that fails after its check passed starts again on today's path", () => {
  /** The first start's pane dies with its marker pending (systemd-run could not make the scope); later starts run. */
  function failFirstStart(h: ReturnType<typeof makeAdapter>) {
    let checks = 0;
    vi.spyOn(h.adapter, "isPaneDead").mockImplementation(async () => ++checks === 1);
    h.adapter.procRead = async (p: string) => {
      if (SYNTHETIC.test(p)) return checks === 1 ? "pending\n" : "";
      if (p === "/proc/4321/cgroup") return SEAT_CG;
      throw new Error(`ENOENT: ${p}`);
    };
  }

  it("a fresh launch of a limited seat is not refused: it starts again in the ungrouped scope with its limit", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" }, limits: { "node-a": { tasksMax: 256 } } });
    failFirstStart(h);
    const result = await h.adapter.createSession("impl-a@alpha", "/work", A);
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("grouping not applied")] });
    const scopes = h.seatScopes();
    expect(scopes.map(sliceOf)).toEqual(["openrigseats-alpha.slice", "openrigseats.slice"]);
    expect(scopes.every(c => c.includes("TasksMax=256"))).toBe(true);
  });

  it("a seat without a limit starts again plainly", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" } });
    failFirstStart(h);
    const result = await h.adapter.createSession("impl-a@alpha", "/work", A);
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("grouping not applied")] });
    expect(h.seatScopes().map(sliceOf)).toEqual(["openrigseats-alpha.slice"]);
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
  });

  it("removes the session a grouped fresh launch kept when its ungrouped limited retry is refused", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" }, limits: { "node-a": { tasksMax: 256 } } });
    vi.spyOn(h.adapter, "isPaneDead").mockResolvedValue(true);
    h.adapter.procRead = async () => "pending\n";
    const result = await h.adapter.createSession("impl-a@alpha", "/work", A);
    expect(result).toMatchObject({ ok: false, code: "process_limits_unverified" });
    expect(h.tmuxCalls("respawn-pane")).toHaveLength(1);
    expect(h.tmuxCalls("kill-session").join("\n")).toContain("kill-session -t '$3'");
  });

  it("a grouped start that can't be confirmed goes on with a warning and runs nothing again", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" } });
    vi.spyOn(h.adapter, "isPaneDead").mockResolvedValue(false);
    h.adapter.procRead = async (p: string) => {
      if (SYNTHETIC.test(p)) return "pending\n";
      throw new Error(`ENOENT: ${p}`);
    };
    const result = await h.adapter.createSession("impl-a@alpha", "/work", A);
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("beneath the rig's slice is unknown")] });
    expect(h.tmuxCalls("new-session")).toHaveLength(1);
    expect(h.tmuxCalls("kill-session")).toEqual([]);
  });
});

describe("a restart in place's bare respawn joins the rig's slice too", () => {
  it("a seat without a limit is respawned beneath its rig's slice; outside a grouping rig, as before", async () => {
    const h = makeAdapter({ sliceRigs: { "node-a": "alpha" } });
    expect(await h.adapter.respawnPane("%1", "codex resume x", { cwd: "/work", groupSeatOf: "node-a" })).toEqual({ ok: true });
    expect(sliceOf(h.tmuxCalls("respawn-pane")[0]!)).toBe("openrigseats-alpha.slice");
    const off = makeAdapter({ sliceRigs: {} });
    expect(await off.adapter.respawnPane("%1", "codex resume x", { cwd: "/work", groupSeatOf: "node-a" })).toEqual({ ok: true });
    expect(off.tmuxCalls("respawn-pane")[0]).not.toContain("systemd-run");
  });
});
