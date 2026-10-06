import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const MENU = [
  "✨ Update available! 0.155.1 -> 0.156.1",
  "› 1. Update now (runs `npm install -g @openai/codex`)",
  "  2. Skip", "  3. Skip until next version", "Press enter to continue",
].join("\n");
const CURRENT_MENU = fs.readFileSync(new URL("./fixtures/codex-update-0.160.0.txt", import.meta.url), "utf8");
const READY = "OpenAI Codex (v0.155.1)\n› Ask Codex to do anything";
const binding = {
  id: "b", nodeId: "n", tmuxSession: "checker@test", tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/private-test",
} satisfies NodeBinding;

// Modeled receiver, NOT native execution. Pinned upstream be2951ea:
// update_prompt.rs:57-68 ignores Paste; :121-158 Key3 selects/submits
// DontRemind immediately; :74-85 persists dismissal or returns RunUpdate.
// Drive real TmuxAdapter serialization into this model, not a sequence of
// ready screenshots that would pass even if the wrong input were sent.
type ProcessRow = { pid: number; ppid: number; command: string; pgid?: number; tpgid?: number; executableName?: string; startedAt?: string };
const native = "/opt/codex/vendor/aarch64-apple-darwin/bin/codex";
// Synthetic shell -> Node -> native ancestry, including a background helper.
// Paths, PIDs and start times are invented; only the process relationships matter.
// The receiver below models the update menu; this is not native execution.
const ordinaryRows: ProcessRow[] = [
  { pid: 2001, ppid: 2000, pgid: 2001, tpgid: 2002, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000", command: "-zsh" },
  { pid: 2002, ppid: 2001, pgid: 2002, tpgid: 2002, executableName: "bash", startedAt: "Sat Jan  1 12:00:00 2000", command: "/bin/sh /tmp/test-launch/openrig-tmux-send.txt" },
  { pid: 2003, ppid: 2002, pgid: 2002, tpgid: 2002, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000", command: "node /opt/test-provider/bin/codex -s workspace-write -C /workspace/sample-project --add-dir /workspace/sample-project/.git --add-dir /tmp/test-instance/shared-docs/rigs/first-project/state/dev -m fixture-model" },
  { pid: 2004, ppid: 2003, pgid: 2002, tpgid: 2002, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "/opt/test-provider/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex -s workspace-write -C /workspace/sample-project --add-dir /workspace/sample-project/.git --add-dir /tmp/test-instance/shared-docs/rigs/first-project/state/dev -m fixture-model" },
  { pid: 2005, ppid: 2004, pgid: 2005, tpgid: 2002, executableName: "codex-code-mode-", startedAt: "Sat Jan  1 12:00:00 2000", command: "/opt/test-provider/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host" },
];
const processRows = (shape: "wrapper" | "exec-wrapper" | "native"): ProcessRow[] => {
  if (shape === "native") return [{ pid: 101, ppid: 1, command: native, pgid: 101, tpgid: 101, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" }];
  if (shape === "exec-wrapper") return [
    { pid: 101, ppid: 1, command: "node /opt/bin/codex", pgid: 101, tpgid: 101, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000" },
    { pid: 102, ppid: 101, command: native, pgid: 101, tpgid: 101, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
  ];
  return [
    { pid: 101, ppid: 1, command: "-zsh", pgid: 101, tpgid: 102, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
    { pid: 102, ppid: 101, command: "node /opt/bin/codex", pgid: 102, tpgid: 102, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000" },
    { pid: 103, ppid: 102, command: native, pgid: 102, tpgid: 102, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
  ];
};
function fixture(options: { menu?: string; delay?: number; beforeMenu?: number; failInput?: boolean; screen?: string; command?: string; panePid?: number; processes?: ProcessRow[]; shape?: "wrapper" | "exec-wrapper" | "native" } = {}) {
  let selected = false;
  let ticks = 0;
  let updates = 0;
  let dismissals = 0;
  let paste = "";
  const commands: string[] = [];
  const leaked: string[] = [];
  const ready = () => selected && ticks >= (options.delay ?? 0);
  const screen = () => options.screen ?? (ticks < (options.beforeMenu ?? 0) ? "Starting Codex..." : ready() ? READY : (options.menu ?? MENU));
  const tmux = new TmuxAdapter(async (cmd) => {
    commands.push(cmd);
    if (cmd.includes("paste-buffer")) {
      expect(cmd).toContain("-p");
      // Native update menu ignores bracketed Paste, including Paste("3").
      if (ready()) leaked.push(paste);
    }
    if (cmd.startsWith("tmux send-keys")) {
      if (options.failInput) throw new Error("input transport failed");
      if (selected) leaked.push(cmd);
      else if (cmd.endsWith(" '3'")) { selected = true; dismissals++; }
      else if (cmd.endsWith(" 'Enter'")) updates++;
    }
    return "";
  }, {
    writeFile: async (_path, content) => { paste = content; },
    unlink: async () => {}, tmpName: () => "/mock/input", bufferName: () => "input",
  });
  vi.spyOn(tmux, "sendShellCommand").mockResolvedValue({ ok: true });
  vi.spyOn(tmux, "getPaneCommand").mockImplementation(async () => options.command ?? "codex");
  vi.spyOn(tmux, "capturePaneScreen").mockImplementation(async () => screen());
  vi.spyOn(tmux, "capturePaneContent").mockResolvedValue(MENU); // stale scrollback
  vi.spyOn(tmux, "hasSession").mockResolvedValue(true);
  vi.spyOn(tmux, "getPanePid").mockResolvedValue(options.panePid ?? 101);
  const fsOps: CodexAdapterFsOps = {
    readFile: () => { throw new Error("absent"); }, writeFile: () => {},
    exists: () => false, mkdirp: () => {}, listFiles: () => [], homedir: "/mock/home",
  };
  const listProcesses = vi.fn(() => options.processes ?? processRows(options.shape ?? "wrapper"));
  const adapter = new CodexRuntimeAdapter({
    tmux, fsOps, sleep: async () => { ticks++; },
    listProcesses,
    readThreadIdByPid: () => ready() ? "new-thread" : undefined,
  });
  return { adapter, tmux, listProcesses, commands, leaked, ready, counts: () => ({ updates, dismissals }),
    reset: () => { selected = false; ticks = 0; } };
}

const paths = [
  { name: "fresh", opts: { name: "checker@test" } },
  { name: "resume", opts: { name: "checker@test", resumeToken: "original-thread" } },
  { name: "fork", opts: { name: "checker@test", forkSource: { kind: "native_id" as const, value: "parent-thread" } } },
];

it.each(paths)("current update header sends one key through real tmux serialization: $name", async ({ opts }) => {
  const f = fixture({ menu: CURRENT_MENU, delay: 4 });
  const result = await f.adapter.launchHarness(binding, opts);
  expect(f.commands).toEqual(["tmux send-keys -t 'checker@test' '3'"]);
  expect(f.counts()).toEqual({ updates: 0, dismissals: 1 });
  expect(f.leaked).toEqual([]);
  expect(result.ok).toBe(true);
});

describe.each(paths)("Codex update input: $name", ({ opts }) => {
  it.each([0, 4, 100])("sends one real key, no Enter or retry, with %i delayed ticks", async (delay) => {
    const f = fixture({ delay });
    const result = await f.adapter.launchHarness(binding, opts);
    expect(f.commands).toEqual(["tmux send-keys -t 'checker@test' '3'"]);
    expect(f.counts()).toEqual({ updates: 0, dismissals: 1 });
    expect(f.leaked).toEqual([]);
    expect((await f.adapter.checkReady(binding)).ready).toBe(f.ready());
    if (f.ready()) expect(result.ok).toBe(true);
    else if (opts.resumeToken) expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it.each([0, 9])("reports input failure without retry when the menu arrives after %i ticks", async (beforeMenu) => {
    const f = fixture({ failInput: true, beforeMenu });
    const result = await f.adapter.launchHarness(binding, opts);
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    if (!result.ok) expect(result.error).toContain("input transport failed");
    expect(f.commands).toEqual(["tmux send-keys -t 'checker@test' '3'"]);
    expect(f.counts()).toEqual({ updates: 0, dismissals: 0 });
    expect((await f.adapter.checkReady(binding)).ready).toBe(false);
  });

  it("handles a menu first appearing during later thread/resume polls", async () => {
    const f = fixture({ beforeMenu: 9 });
    const result = await f.adapter.launchHarness(binding, opts);
    expect(result.ok).toBe(true);
    expect(f.commands).toEqual(["tmux send-keys -t 'checker@test' '3'"]);
    expect(f.counts()).toEqual({ updates: 0, dismissals: 1 });
    expect(f.leaked).toEqual([]);
  });

  it("does not reopen update automation after seeing the conversation", async () => {
    const f = fixture();
    vi.mocked(f.tmux.capturePaneScreen).mockResolvedValueOnce(READY).mockResolvedValue(MENU);
    await f.adapter.launchHarness(binding, opts);
    expect(f.commands).toEqual([]);
  });

  it.each([
    { screen: READY },
    { screen: MENU.replace("3. Skip", "4. Skip") },
    { screen: "Update available! Updating Codex..." },
    { screen: MENU, command: "zsh", processes: [{ pid: 101, ppid: 1, command: "-zsh", pgid: 101, tpgid: 101, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" }] },
    { screen: "Unknown screen" },
  ])("leaves unknown/changed/exited or already-ready screens alone: %j", async (options) => {
    const f = fixture(options);
    await f.adapter.launchHarness(binding, opts);
    expect(f.commands).toEqual([]);
  });

  it.each(["wrapper", "exec-wrapper", "native"] as const)("recognizes the live foreground %s identity", async (shape) => {
    const f = fixture({ shape, command: shape === "native" ? "codex" : "node" });
    await f.adapter.launchHarness(binding, opts);
    expect(f.commands).toEqual(["tmux send-keys -t 'checker@test' '3'"]);
    expect(f.counts()).toEqual({ updates: 0, dismissals: 1 });
  });

  it("checks synthetic shell-owned ancestry before selecting one key", async () => {
    const f = fixture({ command: "bash", panePid: 2001, processes: ordinaryRows });
    await f.adapter.launchHarness(binding, opts);
    expect(f.commands).toEqual(["tmux send-keys -t 'checker@test' '3'"]);
    expect(f.listProcesses.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.counts()).toEqual({ updates: 0, dismissals: 1 });
    expect(f.leaked).toEqual([]);
  });

  it.each([
    { name: "background native", rows: ordinaryRows.map(r => r.pid === 2004 ? { ...r, pgid: 9999 } : r) },
    { name: "unrelated native", rows: ordinaryRows.map(r => r.pid === 2004 ? { ...r, ppid: 1 } : r) },
    { name: "exited native with stale menu", rows: ordinaryRows.filter(r => r.pid !== 2004) },
  ])("rejects synthetic shell ancestry with $name", async ({ rows }) => {
    const f = fixture({ command: "bash", panePid: 2001, processes: rows });
    await f.adapter.launchHarness(binding, opts);
    expect(f.commands).toEqual([]);
  });

  it.each([
    { name: "no process rows", rows: [] },
    { name: "native name with unrelated executable argument zero", rows: [{pid:101,ppid:1,command:"/bin/echo codex",pgid:101,tpgid:101,executableName:"codex", startedAt: "Sat Jan  1 12:00:00 2000"}] },
    { name: "argument named codex", rows: [{pid:101,ppid:1,command:"node other.js --label codex",pgid:101,tpgid:101,executableName:"node", startedAt: "Sat Jan  1 12:00:00 2000"}] },
    { name: "native name only in arguments", rows: [{pid:101,ppid:1,command:"/bin/echo codex",pgid:101,tpgid:101,executableName:"echo", startedAt: "Sat Jan  1 12:00:00 2000"}] },
    { name: "background Codex", rows: processRows("wrapper").map(r=>({...r,tpgid:500})) },
    { name: "missing group", rows: processRows("wrapper").map(({pgid,...r})=>r) },
    { name: "no terminal foreground", rows: processRows("wrapper").map(r=>({...r,tpgid:-1})) },
    { name: "conflicting terminal group", rows: processRows("wrapper").map(r=>r.pid===103?{...r,tpgid:500}:r) },
    { name: "another pane", rows: processRows("wrapper").map(r=>r.pid===103?{...r,ppid:999}:r) },
    { name: "kernel name contradicts argv", rows: processRows("wrapper").map(r=>r.pid===103?{...r,executableName:"node", startedAt: "Sat Jan  1 12:00:00 2000"}:r) },
    { name: "ambiguous native processes", rows: [...processRows("wrapper"),{pid:104,ppid:102,command:native,pgid:102,tpgid:102,executableName:"codex", startedAt: "Sat Jan  1 12:00:00 2000"}] },
  ])("does not choose Skip with $name", async ({rows}) => {
    for (const command of ["node", "codex", "bash"]) {
      const f=fixture({command,processes:rows});
      await f.adapter.launchHarness(binding,opts);
      expect(f.commands).toEqual([]);
    }
  });

  it.each(["missing pane", "missing pane command", "failed process read", "missing current screen"])("refuses %s", async (failure) => {
    const f = fixture({ command: "node" });
    if (failure === "missing pane") vi.mocked(f.tmux.getPanePid).mockResolvedValue(null);
    if (failure === "missing pane command") vi.mocked(f.tmux.getPaneCommand).mockResolvedValue(null);
    if (failure === "failed process read") f.listProcesses.mockImplementation(() => { throw Error("ps unavailable"); });
    if (failure === "missing current screen") vi.mocked(f.tmux.capturePaneScreen).mockResolvedValue(null);
    await (f.adapter as any).dismissSkippableCodexUpdatePrompt(binding.tmuxSession, {handled:false}, 1);
    expect(f.commands).toEqual([]);
  });

  it.each(["pane", "group", "process", "command", "menu"])("rechecks %s identity before choosing", async (changed) => {
    const f=fixture({command:"node"});
    // Directly bound one observation isolates the before-send recheck;
    // later launch polling is covered separately above.
    if(changed==="pane") vi.mocked(f.tmux.getPanePid).mockResolvedValueOnce(101).mockResolvedValue(200);
    if(changed==="group") f.listProcesses.mockReturnValueOnce(processRows("wrapper")).mockReturnValue(processRows("wrapper").map(r=>({...r,tpgid:500})));
    if(changed==="process") f.listProcesses.mockReturnValueOnce(processRows("wrapper")).mockReturnValue(processRows("wrapper").map(r=>r.pid===103?{...r,pid:104}:r));
    if(changed==="command") vi.mocked(f.tmux.getPaneCommand).mockResolvedValueOnce("node").mockResolvedValue("zsh");
    if(changed==="menu") vi.mocked(f.tmux.capturePaneScreen).mockResolvedValueOnce(MENU).mockResolvedValue(READY);
    const attempt = {handled:false};
    await (f.adapter as any).dismissSkippableCodexUpdatePrompt(binding.tmuxSession,attempt,1);
    expect(attempt.handled).toBe(true);
    vi.mocked(f.tmux.getPanePid).mockResolvedValue(101);
    vi.mocked(f.tmux.getPaneCommand).mockResolvedValue("node");
    vi.mocked(f.tmux.capturePaneScreen).mockResolvedValue(MENU);
    f.listProcesses.mockReturnValue(processRows("wrapper"));
    await (f.adapter as any).dismissSkippableCodexUpdatePrompt(binding.tmuxSession,attempt,1);
    expect(f.commands).toEqual([]);
  });

  it("allows one choice on a separately requested new launch", async () => {
    const f = fixture();
    await f.adapter.launchHarness(binding, opts);
    f.reset();
    await f.adapter.launchHarness(binding, opts);
    expect(f.commands).toEqual(Array(2).fill("tmux send-keys -t 'checker@test' '3'"));
    expect(f.counts()).toEqual({ updates: 0, dismissals: 2 });
    expect(f.leaked).toEqual([]);
  });
});

it("negative control: real bracketed Paste3 then Enter selects UpdateNow in the pinned model", async () => {
  const f = fixture();
  await f.tmux.sendText(binding.tmuxSession!, "3");
  await f.tmux.sendKeys(binding.tmuxSession!, ["Enter"]);
  expect(f.counts()).toEqual({ updates: 1, dismissals: 0 });
  expect(f.ready()).toBe(false);
});
