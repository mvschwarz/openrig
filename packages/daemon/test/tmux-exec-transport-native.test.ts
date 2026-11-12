import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand, execCommand, resolveOnPath } from "../src/adapters/tmux-exec.js";

// The production exec functions against a real tmux. Neither takes a server flag: both must reach the server
// named by the inherited TMUX_TMPDIR, so the test points it at a private directory and unsets TMUX.

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

const runFile = promisify(execFile);
const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

/** The executable and argv node spawns for each child started while `fn` runs. */
async function spawnedCommands(fn: () => Promise<void>): Promise<{ file: string; args: string[] }[]> {
  const children: ChildProcess[] = [];
  const onChild = (message: unknown) => { children.push((message as { process: ChildProcess }).process); };
  diagnostics.subscribe("child_process", onChild);
  try { await fn(); } finally { diagnostics.unsubscribe("child_process", onChild); }
  return children.map((child) => ({ file: child.spawnfile, args: child.spawnargs.slice(1) }));
}

async function scenario(mode: "shell" | "argv") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-exec-"));
  roots.push(root);
  // Exercise input arriving while a login shell is still starting, without relying on host profile timing.
  fs.writeFileSync(path.join(root, ".profile"), "sleep 1\nPS1='openrig-ready> '\n");
  const serverDir = path.join(root, "server");
  const emptyDir = path.join(root, "empty");
  fs.mkdirSync(serverDir);
  fs.mkdirSync(emptyDir);
  const anchorEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: serverDir, HOME: root, SHELL: "/bin/sh" };
  delete anchorEnv.TMUX;
  delete anchorEnv.ENV;
  // The anchor starts the server without the user's config; later clients only connect to it.
  await runFile("tmux", ["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 600"], { env: anchorEnv });
  vi.stubEnv("TMUX", undefined);
  vi.stubEnv("TMUX_TMPDIR", serverDir);
  // Exercise the direct server-start path independently of an inherited systemd service environment.
  vi.stubEnv("MANAGERPID", undefined);
  let calls = 0;
  const counted = <A,>(fn: (arg: A) => Promise<string>) => (arg: A) => { calls++; return fn(arg); };
  const adapter = new TmuxAdapter(counted(execCommand), undefined, mode === "argv" ? counted(execArgvCommand) : undefined);
  try {
    let result: Record<string, unknown> = {};
    const commands = await spawnedCommands(async () => {
      const created = await adapter.createSession("seat a", root);
      const duplicate = await adapter.createSession("seat a", root);
      // Wait for the fixture's /bin/sh login prompt. Input typed during system profile startup can be echoed before
      // the prompt and put the command's output on the prompt line, even though the command succeeds.
      let shellReady = false;
      for (let i = 0; i < 200; i++) {
        const screen = await adapter.capturePaneContent("seat a", 50);
        if (screen && /(?:^|\n)openrig-ready>$/.test(screen.trimEnd())) { shellReady = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(shellReady, "fixture shell did not reach its prompt").toBe(true);
      const typed = await adapter.sendText("seat a", "echo 'openrig-'native", undefined, { bracketed: false });
      const entered = await adapter.sendKeys("seat a", ["Enter"]);
      // The quotes keep the typed line from matching: only the command's output contains the marker.
      let single: string | null = null;
      for (let i = 0; i < 100 && !single?.includes("openrig-native"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        single = await adapter.capturePaneContent("seat a", 50);
      }
      const batch = await adapter.capturePanesContent(["seat a", "missing"], 50);
      const activity = await adapter.readAllSessionWindowActivity();
      result = {
        created,
        duplicate: duplicate.ok ? duplicate : duplicate.code,
        typed,
        entered,
        captured: single!.split("\n").filter((line) => line === "openrig-native"),
        batchMatchesSingle: batch?.get("seat a")?.text === single,
        batchMissing: batch?.get("missing")?.text,
        sessions: (await adapter.listSessions()).map((s) => [s.name, s.windows, s.attached]).sort(),
        activitySessions: [...(activity?.keys() ?? [])].sort(),
        activityIsEpoch: [...(activity?.values() ?? [])].every((n) => n > 1_700_000_000),
        missingProbe: await adapter.probeSession("missing"),
        missingKill: await adapter.killSession("missing"),
        missingKeys: await adapter.sendKeys("missing", ["Enter"]),
        killed: await adapter.killSession("seat a"),
        afterKill: (await adapter.listSessions()).map((s) => s.name),
      };
      vi.stubEnv("TMUX_TMPDIR", emptyDir);
      const probe = await adapter.probeSession("seat a");
      result.noServerProbe = probe.state;
      result.noServerCause = probe.state === "transport_unavailable" ? probe.cause : null;
      result.noServerSessions = await adapter.listSessions();
    });
    return { result, files: commands.map((command) => command.file), commands, calls, root: fs.realpathSync(root) };
  } finally {
    vi.unstubAllEnvs();
    await runFile("tmux", ["kill-server"], { env: anchorEnv }).catch(() => {});
  }
}

describe.skipIf(!nativeAvailable)("tmux shell and argv transports against a real server", () => {
  let shell: Awaited<ReturnType<typeof scenario>>;
  let argv: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => {
    shell = await scenario("shell");
    argv = await scenario("argv");
  }, 300000);

  it("both transports observe and change the isolated server identically", () => {
    expect(shell.result).toMatchObject({
      created: { ok: true },
      duplicate: "duplicate_session",
      typed: { ok: true },
      entered: { ok: true },
      batchMatchesSingle: true,
      batchMissing: null,
      sessions: [["anchor", 1, false], ["seat a", 1, false]],
      activitySessions: ["anchor", "seat a"],
      activityIsEpoch: true,
      missingProbe: { state: "absent" },
      missingKill: { ok: false, code: "session_not_found" },
      killed: { ok: true },
      afterKill: ["anchor"],
      noServerProbe: "transport_unavailable",
      noServerSessions: [],
    });
    expect(shell.result.captured).toEqual(["openrig-native"]);
    for (const run of [shell, argv]) {
      expect(run.result.noServerCause).toMatch(/^(no server running on|error connecting to) /);
    }
    // Write errors retain a command-wrapper line; a probe cause is already tmux's own stderr.
    // Compare both transports after normalizing only each run's private directory.
    const stderr = ({ result: r, root }: typeof shell) => {
      const tail = (message: string) => message.split("\n").slice(1).join("\n").replaceAll(root, "<root>").trim();
      return {
        missingKill: tail((r.missingKill as { message: string }).message),
        missingKeys: `${(r.missingKeys as { code: string }).code}: ${tail((r.missingKeys as { message: string }).message)}`,
        noServerCause: (r.noServerCause as string).replaceAll(root, "<root>").trim(),
      };
    };
    expect(stderr(argv)).toEqual(stderr(shell));
    expect(stderr(shell).missingKill).toBe("can't find session: missing");
    expect(stderr(shell).noServerCause).toMatch(/^(no server running on|error connecting to) /);
    const comparable = (r: Record<string, unknown>) => {
      const { missingKill: _k, missingKeys: _s, noServerCause: _c, ...rest } = r;
      return rest;
    };
    expect(comparable(argv.result)).toEqual(comparable(shell.result));
  });

  it("the argv transport uses a limit-setting shell for creation and a direct tmux path for ordinary calls", () => {
    const tmux = resolveOnPath("tmux", process.env.PATH);
    if (tmux) expect(tmux).toMatch(/^\/.*\/tmux$/);
    expect(shell.calls).toBeGreaterThan(15);
    expect(shell.files).toEqual(Array(shell.calls).fill("/bin/sh"));
    expect(argv.commands).toHaveLength(argv.calls);
    // Both createSession attempts issue start-server ; source-file for their private config.
    // Only those clients' child shells raise their soft limit;
    // the executable and original arguments follow the fixed script as positional parameters.
    const creating = argv.commands.filter((command) => command.args.includes("start-server"));
    expect(creating).toHaveLength(2);
    for (const command of argv.commands) {
      if (creating.includes(command)) {
        expect(command.file).toBe("/bin/sh");
        expect(command.args[0]).toBe("-c");
        expect(command.args[1]).toContain('exec "$0" "$@"');
        expect(command.args.slice(2, 6)).toEqual(["tmux", "start-server", ";", "source-file"]);
      } else {
        expect(command.file).toBe(tmux ?? "/bin/sh");
      }
    }
  });
});
