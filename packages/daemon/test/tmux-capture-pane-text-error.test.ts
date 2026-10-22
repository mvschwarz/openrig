// A failed chained capture carries the earlier panes' text on stdout, and an agent controls that text. The capture
// classifies the failure on what tmux reported (stderr), so a pane showing "no server running" or "can't find
// session" can neither hide a dead session in its chunk nor turn another error into a halving cascade.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

const exec = promisify(execFile);
const shellUnused = async (): Promise<string> => { throw new Error("expected argv transport"); };
const PANE_TEXTS = [
  "no server running on /tmp/tmux-1000/default",
  "error connecting to /tmp/tmux-1000/default (No such file or directory)",
];

// A fake `tmux` on a private PATH: a chain prints each pane before the dead `=b:` target fails it on stderr.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tmux-panetext-"));
fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh
[ "$1" = list-sessions ] && { printf 'a\\nc\\n'; exit 0; }
run() {
  [ "$tgt" = "=b:" ] && { echo "can't find session: b" >&2; exit 1; }
  case "$cmd" in display-message) echo "$last" ;; capture-pane) echo "$tgt: $PANE_TEXT" ;; esac
  cmd=; tgt=; prev=
}
cmd=; tgt=; prev=
for a in "$@"; do
  if [ "$a" = ";" ]; then run; continue; fi
  [ -z "$cmd" ] && cmd=$a
  [ "$prev" = "-t" ] && tgt=$a
  prev=$a; last=$a
done
run
`, { mode: 0o755 });
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("chained capture error classification, fake tmux", { timeout: 60_000 }, () => {
  it.each(PANE_TEXTS)("pane text %j on stdout: the dead target is marked missing; the message still shows the text", async (text) => {
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    vi.stubEnv("PANE_TEXT", text);
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(shellUnused, undefined, async (argv) => { calls.push(argv); return execArgvCommand(argv); });
    const got = await adapter.capturePanesContent(["a", "b", "c"], 20);
    expect(got!.get("b")).toMatchObject({ text: null, missing: true });
    expect(got!.get("a")?.text).toBe(`=a:: ${text}\n`);
    expect(got!.get("c")?.text).toBe(`=c:: ${text}\n`);
    expect(calls.filter((c) => c.includes("capture-pane"))).toHaveLength(2);

    const err = await execArgvCommand(["tmux", "display-message", "-p", "-t", "=a:", "M0", ";", "capture-pane", "-p", "-t", "=a:",
      ";", "display-message", "-p", "-t", "=b:", "M1"]).catch((e: unknown) => e as Error & { execStderr?: string });
    expect(err.message).toContain(text);
    expect(err.message).toContain("can't find session: b");
    expect(err.execStderr).toBe("can't find session: b\n");
  });
});

describe("chained capture error classification, listing first", () => {
  it("a server gone after a listing that lacks a target still marks that target missing", async () => {
    const a = new TmuxAdapter(shellUnused, undefined, async (argv) => {
      if (argv[1] === "list-sessions") return "a\nc\n";
      throw Object.assign(new Error("Command failed: tmux\nno server running on /tmp/tmux-1000/default"), { execStderr: "no server running on /tmp/tmux-1000/default\n" });
    });
    const got = await a.capturePanesContent(["a", "b", "c"], 20);
    expect(got!.get("b")).toMatchObject({ text: null, missing: true });
    for (const n of ["a", "c"]) expect(got!.get(n), n).toEqual({ text: null, capturedAt: expect.any(Date) });
  });
});

describe.skipIf(!nativeAvailable)("chained capture error classification, real tmux", { timeout: 60_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-panetext-native-"));
  const sock = path.join(home, "sock");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMUX_TMPDIR: home };
  delete env.TMUX;
  const tmux = async (...args: string[]) => (await exec("tmux", ["-f", "/dev/null", "-S", sock, ...args], { env, timeout: 10_000 })).stdout;
  afterAll(async () => {
    await tmux("kill-server").catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });
  /** The production argv transport against this test's private server; `tail` extends every chain, never a single capture. */
  const adapter = (tail: string[] = []) => {
    const calls: string[][] = [];
    const a = new TmuxAdapter(shellUnused, undefined, async (argv) => {
      calls.push(argv);
      return execArgvCommand(["tmux", "-S", sock, ...argv.slice(1), ...(argv.includes("display-message") ? tail : [])]);
    });
    return { a, calls };
  };
  /** Four sessions; the first pane shows `text`. */
  const sessions = async (text: string) => {
    const names = ["a", "b", "c", "d"].map((n) => `${n}-${Math.random().toString(36).slice(2, 8)}`);
    for (const n of names) await tmux("new-session", "-d", "-s", n, "-x", "120", "-y", "20", `printf '%s\\n' ${JSON.stringify(n === names[0] ? text : `${n} ok`)}; exec cat`);
    await expect.poll(async () => (await tmux("capture-pane", "-p", "-t", `=${names[0]}:`)).includes(text), { timeout: 10_000 }).toBe(true);
    return names;
  };

  it.each(PANE_TEXTS)("pane showing %j: a killed chunk-mate is marked missing, the rest are read", async (text) => {
    const names = await sessions(text);
    await tmux("kill-session", "-t", `=${names[1]}`);
    const { a, calls } = adapter();
    const got = await a.capturePanesContent(names, 20);
    expect(got!.get(names[1]!)).toMatchObject({ text: null, missing: true });
    expect(got!.get(names[0]!)?.text).toContain(text);
    for (const n of names.slice(2)) expect(got!.get(n)?.text).toContain(`${n} ok`);
    expect(calls.filter((c) => c.includes("capture-pane"))).toHaveLength(2);
    for (const n of names) await tmux("kill-session", "-t", `=${n}`).catch(() => {});
  });

  it("pane showing \"can't find session\": an error only the chain hits leaves the chunk out, no halving", async () => {
    const names = await sessions("can't find session: elsewhere");
    // A runtime error tmux reports after every pane printed; a pane read on its own works.
    const { a, calls } = adapter([";", "set-option", "-g", "openrig-no-such-option", "1"]);
    const got = await a.capturePanesContent(names, 20);
    for (const n of names) expect(got!.has(n), n).toBe(false);
    expect(calls.filter((c) => c.includes("display-message"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("capture-pane"))).toHaveLength(1);
    for (const n of names) expect(await a.capturePaneContent(n, 20), n).toContain(n === names[0] ? "can't find session: elsewhere" : `${n} ok`);
    for (const n of names) await tmux("kill-session", "-t", `=${n}`).catch(() => {});
  });
});
