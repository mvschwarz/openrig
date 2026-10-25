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

/** The file node spawns for each child started while `fn` runs. */
async function spawnedFiles(fn: () => Promise<void>): Promise<string[]> {
  const children: ChildProcess[] = [];
  const onChild = (message: unknown) => { children.push((message as { process: ChildProcess }).process); };
  diagnostics.subscribe("child_process", onChild);
  try { await fn(); } finally { diagnostics.unsubscribe("child_process", onChild); }
  return children.map((child) => child.spawnfile);
}

async function scenario(mode: "shell" | "argv") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-exec-"));
  roots.push(root);
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
  let calls = 0;
  const counted = <A,>(fn: (arg: A) => Promise<string>) => (arg: A) => { calls++; return fn(arg); };
  const adapter = new TmuxAdapter(counted(execCommand), undefined, mode === "argv" ? counted(execArgvCommand) : undefined);
  try {
    let result: Record<string, unknown> = {};
    const files = await spawnedFiles(async () => {
      const created = await adapter.createSession("seat a", root);
      const duplicate = await adapter.createSession("seat a", root);
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
    return { result, files, calls, root: fs.realpathSync(root) };
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

  it("the shell transport starts /bin/sh for every call, the argv transport starts tmux by its path, or /bin/sh when PATH leaves it to the shell", () => {
    const tmux = resolveOnPath("tmux", process.env.PATH);
    if (tmux) expect(tmux).toMatch(/^\/.*\/tmux$/);
    expect(shell.calls).toBeGreaterThan(15);
    expect(shell.files).toEqual(Array(shell.calls).fill("/bin/sh"));
    expect(argv.files).toEqual(Array(argv.calls).fill(tmux ?? "/bin/sh"));
  });
});
