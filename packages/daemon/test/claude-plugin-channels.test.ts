// #2044 (the per-launch-path tests follow cerebral-work/openrig#54): a Claude seat's plugin channels, kept in its launch
// additions record, reach every Claude launch OpenRig makes: fresh launch, fork, resume and restore; ordinary, kernel,
// team-default and full-bypass seats; the pane-shell and the managed argv forms. Each gets one `--channels <entries...>`
// followed by OpenRig's identity options, and a seat without channels gets the command it got before. Through the real
// command builders, with an inert transport: nothing is executed.
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { claudeCommandSessionToken } from "../src/domain/native-process-lineage.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { SeatLaunchAdditions } from "../src/domain/seat-launch-additions.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const ENTRIES = ["plugin:example-channel@example", "plugin:second@example"];
const CHANNELS: SeatLaunchAdditions = { pluginDirs: [], pluginChannels: ENTRIES };
/** The option as the pane-shell form writes it: the flag, then each entry quoted. */
const SHELL = ` --channels${ENTRIES.map((entry) => ` ${shellQuote(entry)}`).join("")}`;

type Kind = "ordinary" | "kernel" | "team" | "full-bypass";
const KINDS: Kind[] = ["ordinary", "kernel", "team", "full-bypass"];
function binding(kind: Kind, launchAdditions?: SeatLaunchAdditions): NodeBinding {
  return {
    id: "binding", nodeId: "node", cwd: "/inert/seat", tmuxSession: "seat@rig", launchPosture: kind === "full-bypass" ? "full_bypass" : "floor",
    ...(kind === "kernel" ? { kernelAuthority: true } : {}), ...(kind === "team" ? { teamPermissionDefault: true } : {}),
    ...(kind === "full-bypass" ? { nonInterruptive: true } : {}),
    ...(launchAdditions ? { launchAdditions } : {}),
  } as NodeBinding;
}

function inert() {
  const send = vi.fn(async (_target: string, _text: string, ..._rest: unknown[]) => ({ ok: false as const, message: "inert transport: no native execution" }));
  const tmux = { sendShellCommand: send, sendText: send } as unknown as TmuxAdapter;
  const fsOps = { readFile: () => { throw new Error("missing"); }, exists: () => false,
    writeFile: vi.fn(() => { throw new Error("unexpected settings write"); }), mkdirp: vi.fn(), copyFile: vi.fn() };
  return { send, tmux, fsOps };
}

type Path = "fresh" | "fork" | "resume" | "restore";
const PATHS: Path[] = ["fresh", "fork", "resume", "restore"];
/** The conversation each path's command names: a fork's own new id, or the one resumed. */
const NAMED: Record<Path, string> = { fresh: "fixed-session-id", fork: "fixed-session-id", resume: "original", restore: "original" };

/** The command each path sends to the pane. */
async function command(path: Path, kind: Kind, launchAdditions?: SeatLaunchAdditions): Promise<string> {
  vi.stubEnv("OPENRIG_YOLO", kind === "full-bypass" ? "1" : "0");
  const t = inert();
  const b = binding(kind, launchAdditions);
  if (path === "restore") {
    await new ClaudeResumeAdapter(t.tmux).resume("seat@rig", "claude_id", "original", b.cwd, b.launchPosture as "floor" | "full_bypass",
      null, undefined, b.nodeId, null, b.nonInterruptive, b.kernelAuthority, b.teamPermissionDefault, null, launchAdditions);
  } else {
    await new ClaudeCodeAdapter({ ...t, sessionIdFactory: () => "fixed-session-id" }).launchHarness(b, { name: "seat",
      ...(path === "resume" ? { resumeToken: "original" } : {}),
      ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
  }
  expect(t.fsOps.writeFile).not.toHaveBeenCalled();
  return t.send.mock.calls[0]![1];
}

/** The argv the pane shell passes to Claude for a command. */
const argvOf = (cmd: string): string[] =>
  execFileSync("/bin/sh", ["-c", `claude() { printf '%s\\n' "$@"; }; ${cmd}`], { encoding: "utf8" }).split("\n").slice(0, -1);

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("a seat's plugin channels reach every Claude launch exactly once", () => {
  for (const path of PATHS) for (const kind of KINDS) {
    it(`${path}, ${kind} seat: one --channels with the entries; without them the command is as it was`, async () => {
      const off = await command(path, kind);
      const on = await command(path, kind, CHANNELS);

      expect(count(on, SHELL)).toBe(1);
      expect(count(on, "--channels")).toBe(1);
      expect(on.replace(SHELL, "")).toBe(off);
      expect(off).not.toContain("--channels");
      // Claude's option takes every following value up to the next option: an identity option ends the list.
      expect(on.slice(on.indexOf(SHELL) + SHELL.length)).toMatch(/^ --(?:session-id|resume) /);
    });
  }

  it.each(PATHS)("%s: the argv Claude gets keeps each entry one argument, and as ps shows it still names its conversation", async (path) => {
    for (const kind of KINDS) {
      const argv = argvOf(await command(path, kind, CHANNELS));
      const at = argv.indexOf("--channels");
      expect(argv.slice(at, at + ENTRIES.length + 1), kind).toEqual(["--channels", ...ENTRIES]);
      expect(claudeCommandSessionToken(["claude", ...argv].join(" ")), kind).toBe(NAMED[path]);
    }
  });

  it("the managed argv form: the same option and entries, followed by the identity options, on every path", async () => {
    for (const path of PATHS) {
      const seen: string[][] = [];
      const t = inert();
      const claudeManagedLaunch = { prepare: async () => ({ command: (args: readonly string[]) => { seen.push([...args]); return "claude"; },
        assertCurrent: () => {}, configDir: "/fixture" }) } as never;
      if (path === "restore") {
        await new ClaudeResumeAdapter(t.tmux, { claudeManagedLaunch }).resume("seat@rig", "claude_id", "original", "/inert/seat", "floor",
          null, "acceptEdits", "node", null, undefined, undefined, undefined, null, CHANNELS);
      } else {
        await new ClaudeCodeAdapter({ ...t, sleep: async () => {}, sessionIdFactory: () => "fixed-session-id", claudeManagedLaunch })
          .launchHarness({ ...binding("ordinary", CHANNELS), permissionMode: "acceptEdits" }, { name: "seat",
            ...(path === "resume" ? { resumeToken: "original" } : {}),
            ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
      }
      const args = seen[0];
      expect(args, path).toBeDefined();
      const at = args!.indexOf("--channels");
      expect(args!.filter((arg) => arg === "--channels"), path).toHaveLength(1);
      expect(args!.slice(at, at + ENTRIES.length + 2), path).toEqual(["--channels", ...ENTRIES, path === "fresh" ? "--session-id" : "--resume"]);
      expect(claudeCommandSessionToken(["claude", ...args!].join(" ")), path).toBe(NAMED[path]);
    }
  });

  it("a record with no channels adds nothing", async () => {
    for (const path of PATHS) expect(await command(path, "ordinary", { pluginDirs: [] })).toBe(await command(path, "ordinary"));
  });
});
