import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import { openOrcaView, type OrcaDeps } from "../src/terminal-orca.js";

vi.mock("../src/daemon-lifecycle.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/daemon-lifecycle.js")>(),
  getDaemonStatus: async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 }),
  getDaemonUrl: () => "http://localhost:7433",
}));

const pane = (name: string, host?: string) => ({ seat: `${name}@demo`, paneCommand: `tmux -S '/tmp/rig socket' attach -r -t '=${name}@demo'`, host });
const command = (name: string) => `exec /usr/bin/env -u TMUX -u TMUX_PANE ${pane(name).paneCommand}`;
const workspaceId = "repo::/work/project";
const localView = [[pane("a"), pane("b"), pane("c"), pane("d")]];

interface Options {
  pages?: typeof localView; host?: string; baseUrl?: string; local?: boolean; env?: NodeJS.ProcessEnv;
  id?: string; cwdWorkspaceId?: string; noWorkspace?: boolean; noIdentity?: boolean; noDesktop?: boolean; splitTimeout?: boolean; switchRuntime?: boolean;
  disconnected?: boolean; remount?: boolean; platform?: OrcaDeps["platform"];
  noRuntimeIdentity?: boolean; missingCommand?: "create" | "show" | "split";
  localSelector?: "missing-from-help" | "status-rejects" | "workspace-rejects";
}

function fixture({ pages = localView, host = "local", baseUrl = "http://localhost:7433", local = true,
  env = { ORCA_WORKTREE_ID: workspaceId, ORCA_CLI_COMMAND: "/Applications/Orca Dev.app/bin/orca", ORCA_USER_DATA_PATH: "/profiles/dev" },
  id = workspaceId, cwdWorkspaceId = id, noWorkspace = false, noIdentity = false, noDesktop = false, splitTimeout = false, switchRuntime = false,
  disconnected = false, remount = false, platform = "darwin", noRuntimeIdentity = false, missingCommand, localSelector,
}: Options = {}) {
  const absent = [{ seat: "stopped@demo", host: null, reason: "stopped" }];
  const get = vi.fn(async () => ({ status: 200, data: {
    composed: { pages, absent, degraded: [{ seat: "http@demo", host: "http", reason: "requires SSH" }] },
  } }));
  const isLocalInstance = vi.fn(async () => local);
  const client = { baseUrl, get, isLocalInstance } as unknown as DaemonClient;
  let tab = 0;
  let count = 0;
  let showedFirstPane = false;
  const handles = new Map<string, string>();
  const exec = vi.fn(async (_file: string, args: string[]) => {
    function reply(result: unknown, runtimeId = "orca-dev-runtime") { return JSON.stringify({ ok: true, result, _meta: { runtimeId } }); }
    const [group, verb] = args;
    if (group === "status") {
      if (verb === "--help") return localSelector === "missing-from-help"
        ? "Usage: orca status [--json]"
        : "Usage: orca status [--json]\n  --environment <selector> Local or paired Orca runtime\n";
      if (localSelector === "status-rejects") {
        throw Object.assign(new Error("status rejected"), { stdout: JSON.stringify({ ok: false, error: { code: "invalid_argument" } }) });
      }
      const result = { app: { running: true, desktopWindowStatus: noDesktop ? "openable" : "available" }, runtime: { reachable: true } };
      return noRuntimeIdentity ? JSON.stringify({ ok: true, result }) : reply(result);
    }
    if (group === "terminal" && args[2] === "--help") {
      const usage = {
        create: "--worktree <selector> --title <name> --command <text>",
        split: "--terminal <handle> --direction <direction> --command <text>",
        show: "--terminal <handle>",
      }[verb as "create" | "split" | "show"];
      if (!usage) throw new Error(`unexpected help command: ${verb}`);
      return verb === missingCommand ? "Usage: orca terminal --help" : `Usage: orca terminal ${verb} ${usage} --json\n  --environment <selector> Local or paired Orca runtime\n`;
    }
    if (group === "worktree") {
      if (localSelector === "workspace-rejects") {
        throw Object.assign(new Error("workspace lookup rejected"), { stderr: "Unknown flag --environment for command: worktree show" });
      }
      if (noWorkspace) throw new Error("target not found");
      const targetId = args[3] === "current" || args[3] === "active" ? cwdWorkspaceId : id;
      return reply({ worktree: { id: targetId, hostId: host,
        ...(noIdentity || targetId.startsWith("folder:") ? {} : { identity: { key: "identity-key", executionHostId: host } }) } });
    }
    if (verb === "create" || verb === "split") {
      if (verb === "create") tab++;
      if (verb === "split" && splitTimeout) throw new Error("timed out after submission");
      const handle = `term_${++count}`;
      const tabId = `tab-${tab}`;
      handles.set(handle, tabId);
      return reply(verb === "create" ? { terminal: { handle, tabId, worktreeId: id, executionHostId: host, hostPlatform: platform } } : { split: { handle, tabId } },
        verb === "split" && switchRuntime ? "other-runtime" : undefined);
    }
    if (verb === "show") {
      const handle = args[3]!;
      const orphaned = disconnected || (remount && handle === "term_1" && !showedFirstPane);
      if (handle === "term_1") showedFirstPane = true;
      return reply({ terminal: { handle, tabId: handles.get(handle), worktreeId: id,
        connected: !disconnected, orphaned, executionHostId: host, preview: "never print terminal output" } });
    }
    throw new Error(`unexpected Orca method: ${group} ${verb}`);
  });
  const deps: OrcaDeps = { env, platform, exec };
  const commands = () => exec.mock.calls.map(([, argv]) => argv);
  const workspaceLookup = () => commands().find(([group, verb]) => group === "worktree" && verb === "show");
  const mutations = () => commands().filter(([, command, option]) => option !== "--help" && (command === "create" || command === "split"));
  return { client, get, isLocalInstance, deps, exec, commands, workspaceLookup, mutations, absent };
}

const originalExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode; });

describe("openOrcaView", () => {
  it("uses the caller's Orca runtime, splitting a new tab by row then column without changing the composed commands", async () => {
    const f = fixture();
    const result = await openOrcaView(f.client, "rig:demo", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, provider: "orca", workspaceId, opened: ["a@demo", "b@demo", "c@demo", "d@demo"], pages: 1, absent: f.absent });
    expect(JSON.stringify(result)).not.toContain("never print terminal output");
    expect(f.get).toHaveBeenCalledWith("/api/terminal/preview?view=rig%3Ademo&provider=herdr", expect.objectContaining({ headers: expect.any(Object) }));
    expect(f.exec.mock.calls.every(([file]) => file === f.deps.env.ORCA_CLI_COMMAND)).toBe(true);
    expect(f.commands().filter(argv => !argv.includes("--help")).every(argv => argv.slice(-3).join(" ") === "--environment local --json")).toBe(true);
    expect(f.workspaceLookup()?.slice(0, 4)).toEqual(["worktree", "show", "--worktree", `id:${workspaceId}`]);
    expect(f.mutations().map(argv => argv.slice(0, -3))).toEqual([
      ["terminal", "create", "--worktree", "identity:identity-key", "--title", "OpenRig: rig:demo", "--command", command("a")],
      ["terminal", "split", "--terminal", "term_1", "--direction", "vertical", "--command", command("c")],
      ["terminal", "split", "--terminal", "term_1", "--direction", "horizontal", "--command", command("b")],
      ["terminal", "split", "--terminal", "term_2", "--direction", "horizontal", "--command", command("d")],
    ]);
  });

  it("uses explicit folder workspace and preserves page and remote-seat boundaries", async () => {
    const f = fixture({ id: "folder:demo", env: {}, pages: [[pane("first"), pane("distant", "ssh-host")], [pane("second")]] });
    const result = await openOrcaView(f.client, "demo", "path:/work/folder", f.deps);
    expect(f.workspaceLookup()?.[3]).toBe("path:/work/folder");
    expect(f.mutations().map(args => args.slice(1, 6))).toEqual([
      ["create", "--worktree", "folder:demo", "--title", "OpenRig: demo (1/2)"],
      ["create", "--worktree", "folder:demo", "--title", "OpenRig: demo (2/2)"],
    ]);
    expect(result).toMatchObject({ ok: true, pages: 2, opened: ["first@demo", "second@demo"], degraded: [
      { seat: "http@demo", host: "http" }, { seat: "distant@demo", host: "ssh-host" },
    ] });
  });

  it.each([
    { id: workspaceId, env: { ORCA_WORKTREE_ID: workspaceId }, lookup: `id:${workspaceId}`, write: "identity:identity-key" },
    { id: "folder:caller", env: { ORCA_WORKSPACE_ID: "folder:caller", ORCA_WORKTREE_ID: workspaceId }, lookup: "folder:caller", write: "folder:caller" },
  ])("opens the caller's $lookup workspace even when the shell is in another workspace", async ({ id, env, lookup, write }) => {
    const f = fixture({ id, env, cwdWorkspaceId: "folder:elsewhere", pages: [[pane("only")]] });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: true, workspaceId: id });
    expect(f.workspaceLookup()?.[3]).toBe(lookup);
    expect(f.mutations()).toHaveLength(1);
    expect(f.mutations()[0]?.[3]).toBe(write);
  });

  it("honors an explicit workspace even when it is not the calling terminal's workspace", async () => {
    const f = fixture({ id: "folder:elsewhere", pages: [[pane("only")]] });
    await expect(openOrcaView(f.client, "demo", "path:/work/elsewhere", f.deps)).resolves.toMatchObject({ ok: true, workspaceId: "folder:elsewhere" });
    expect(f.workspaceLookup()?.[3]).toBe("path:/work/elsewhere");
  });

  it("pins a local non-Git project to its canonical id even without a Git identity", async () => {
    const f = fixture({ noIdentity: true, pages: [[pane("only")]] });
    await expect(openOrcaView(f.client, "demo", "path:/work/project", f.deps)).resolves.toMatchObject({ ok: true, opened: ["only@demo"] });
    expect(f.mutations()[0]?.[3]).toBe(`id:${workspaceId}`);
  });

  it.each([
    [{ env: {} }, "orca_workspace_required"],
    [{ baseUrl: "https://example.org:7433" }, "orca_local_daemon_required"],
    [{ local: false }, "orca_local_daemon_required"],
    [{ host: "ssh:other" }, "orca_workspace_not_local"],
    [{ id: "folder:remote", host: "ssh:other" }, "orca_workspace_not_local"],
    [{ noWorkspace: true }, "orca_workspace_unavailable"],
    [{ noDesktop: true }, "orca_unavailable"],
    [{ pages: [[pane("remote", "other")]] }, "orca_no_local_tiles"],
  ] as const)("opens nothing when the preflight refuses (%j)", async (options, code) => {
    const f = fixture({ ...options, ...("pages" in options ? { pages: options.pages.map(page => [...page]) } : {}) });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: false, code });
    expect(f.mutations()).toEqual([]);
  });

  it.each([{ splitTimeout: true }, { switchRuntime: true }])("does not retry or continue after an unconfirmed split (%j)", async options => {
    const f = fixture({ ...options, pages: [[pane("first"), pane("second")], [pane("third")]] });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({
      ok: true, opened: ["first@demo"], pages: 1, degraded: [
        { seat: "http@demo" }, { seat: "second@demo", code: "pane_unconfirmed" }, { seat: "third@demo", reason: expect.stringContaining("Not attempted") },
      ],
    });
    expect(f.mutations().map(([, op]) => op)).toEqual(["create", "split"]);
  });

  it("rechecks a pane remounted by splitting without creating another pane", async () => {
    const f = fixture({ remount: true, pages: [[pane("first"), pane("second")]] });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: true, opened: ["first@demo", "second@demo"] });
    expect(f.mutations()).toHaveLength(2);
    expect(f.commands().filter(([, op, , handle]) => op === "show" && handle === "term_1")).toHaveLength(2);
  });

  it("does not count an accepted but unconnected terminal as an opened tile", async () => {
    const f = fixture({ disconnected: true, pages: [[pane("only")]] });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({
      ok: false, opened: [], pages: 0, code: "orca_panes_unconfirmed",
      degraded: [{ seat: "http@demo" }, { seat: "only@demo", code: "pane_unconfirmed" }],
    });
  });
});

describe("Orca provider preflight", () => {
  it.each(["linux", "win32"] as const)("does not run Orca or contact the daemon on %s", async platform => {
    const f = fixture({ platform });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: false, code: "orca_unsupported_platform" });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("distinguishes a missing CLI from a closed Orca desktop", async () => {
    const f = fixture();
    f.exec.mockRejectedValueOnce(Object.assign(new Error("launcher not found"), { code: "ENOENT" }));
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: false, code: "orca_cli_unavailable" });
    expect(f.mutations()).toEqual([]);
  });

  it.each(["missing-from-help", "status-rejects", "workspace-rejects"] as const)("diagnoses an unsupported local selector without trying the ambient runtime (%s)", async localSelector => {
    const f = fixture({ localSelector });
    const result = await openOrcaView(f.client, "demo", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, code: "orca_capability_unavailable", error: expect.stringContaining("--environment local") });
    expect(result.error).not.toContain("Open Orca before retrying");
    expect(f.mutations()).toEqual([]);
    expect(f.commands().filter(args => !args.includes("--help")).every(args => args.slice(-3).join(" ") === "--environment local --json")).toBe(true);
    if (localSelector === "missing-from-help") expect(f.commands()).toEqual([["status", "--help"]]);
  });

  it("refuses to open without Orca runtime identity metadata", async () => {
    const f = fixture({ noRuntimeIdentity: true });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: false, code: "orca_capability_unavailable" });
    expect(f.mutations()).toEqual([]);
  });

  it.each(["create", "show", "split"] as const)("reports unavailable terminal %s support before creating any panes", async missingCommand => {
    const f = fixture({ missingCommand });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({
      ok: false, code: "orca_capability_unavailable", error: expect.stringContaining(`terminal ${missingCommand}`),
    });
    expect(f.mutations()).toEqual([]);
  });

  it("does not require split for a single-seat page", async () => {
    const f = fixture({ pages: [[pane("only")]], missingCommand: "split" });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: true, opened: ["only@demo"] });
    expect(f.commands()).not.toContainEqual(["terminal", "split", "--help"]);
  });
});

describe("rig terminal open --provider orca", () => {
  function cli(f: ReturnType<typeof fixture>) {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = { clientFactory: () => f.client, lifecycleDeps: {}, windowDeps: f.deps } as TerminalDeps;
    const run = async (...args: string[]) => {
      await terminalCommand(deps).parseAsync(["open", ...args, "--json"], { from: "user" });
      return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    };
    return run;
  }

  it("routes the explicit provider to Orca using the workspace supplied by the user", async () => {
    const f = fixture({ env: {} });
    await expect(cli(f)("demo", "--provider", "orca", "--orca-workspace", "path:/work/project")).resolves.toMatchObject({ provider: "orca", ok: true });
    expect(f.workspaceLookup()?.[3]).toBe("path:/work/project");
  });

  it.each([["demo", "--window"], ["demo", "--follow"], ["demo", "--expected-plan", "old"], ["--all"]])("rejects unsupported combinations before reading or changing Orca (%s)", async (...args) => {
    const f = fixture();
    await expect(cli(f)(...args, "--provider", "orca")).resolves.toMatchObject({ provider: "orca", ok: false });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });
});
