import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
import { CONTROL_OPTION, controlSessionName, markOwnRows, supportsControlMode, tmuxControlExec, withoutOwnRows } from "../src/adapters/tmux-control.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TmuxDiscoveryScanner } from "../src/domain/tmux-discovery-scanner.js";

const version = (() => {
  try { return execFileSync("tmux", ["-V"], { encoding: "utf8" }); } catch { return ""; }
})();

/** What a spawned tmux gives for argv: its stdout, or its error's message and stderr. */
async function outcome(exec: (argv: string[]) => Promise<string>, argv: string[]): Promise<unknown> {
  try {
    return { stdout: await exec(argv) };
  } catch (err) {
    const e = err as Error & { execStderr?: string };
    return { message: e.message.replace(/^Command failed: \S*tmux /, "Command failed: tmux "), execStderr: e.execStderr };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!supportsControlMode(version))("tmux control mode against a real server", () => {
  let dir: string;
  let control: ReturnType<typeof tmuxControlExec>;
  /** What the control exec handed to a spawned client. */
  let spawned: string[][];
  const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" });
  const sessions = () => tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean).sort();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openrig-control-"));
    vi.stubEnv("TMUX_TMPDIR", dir);
    vi.stubEnv("TMUX", "");
    // A pane that prints what an agent could: UTF-8, a tab, a line that reads like the end of a control block.
    writeFileSync(join(dir, "screen.txt"), "héllo wörld 日本\nа\tb\n%end 1792181738 374 1\n%error 1 2 3\nlast line\n");
    tmux("new-session", "-d", "-s", "seat@rig", "-x", "120", "-y", "30", `cat ${join(dir, "screen.txt")}; exec cat`);
    spawned = [];
    control = tmuxControlExec((argv) => { spawned.push(argv); return execArgvCommand(argv); });
  });

  afterEach(async () => {
    await control.close();
    try { tmux("kill-server"); } catch { /* already gone */ }
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const reads: string[][] = [
    ["tmux", "has-session", "-t", "=seat@rig"],
    ["tmux", "has-session", "-t", "=nope@rig"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "#{pane_in_mode}|#{pane_current_command}|#{pane_width}"],
    ["tmux", "capture-pane", "-p", "-t", "=seat@rig:", "-S", "-20"],
    ["tmux", "capture-pane", "-p", "-e", "-J", "-t", "=seat@rig:", "-S", "-20"],
    ["tmux", "capture-pane", "-p", "-t", "=nope@rig:"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "__marker_1__", ";", "capture-pane", "-p", "-t", "=seat@rig:", "-S", "-2"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "__marker_1__", ";", "capture-pane", "-p", "-t", "=nope@rig:", ";", "capture-pane", "-p", "-t", "=seat@rig:"],
    ["tmux", "list-sessions", "-F", "#{session_name}|#{session_attached}"],
    ["tmux", "list-windows", "-a", "-F", "#{session_name}|#{window_index}|#{window_activity_flag}"],
    ["tmux", "list-panes", "-a", "-F", "#{session_name}|#{pane_id}|#{pane_current_command}"],
    ["tmux", "list-panes", "-t", "=seat@rig:", "-F", "#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_active}"],
    ["tmux", "show-environment", "-t", "=seat@rig"],
    // An argument ending in ; ends its command; one ending in \; keeps a literal ;; empty commands are skipped.
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "abc;", "display-message", "-p", "-t", "=seat@rig:", "second"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "abc\\;"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "abc\\\\;"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "\\;", ";", ";", "display-message", "-p", "-t", "=seat@rig:", "a;b;"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "x", ";"],
  ];

  it("gives every read the spawned client's stdout, error text and execStderr, its own rows left out", async () => {
    await sleep(300);
    await control(["tmux", "has-session", "-t", "=seat@rig"]); // connects: the control session exists from here on
    const connecting = spawned.length;
    for (const argv of reads) {
      // The spawned client lists the control session too; the control exec leaves its rows out, and only those.
      const marked = ["tmux", ...markOwnRows(argv.slice(1), control.owner, "own-row:")];
      const expected = await outcome(execArgvCommand, marked) as { stdout?: string };
      if (expected.stdout !== undefined) expected.stdout = withoutOwnRows(expected.stdout, "own-row:");
      expect(await outcome(control, argv), argv.join(" ")).toEqual(expected);
    }
    // Every one of them went through the control client.
    expect(spawned.slice(connecting)).toEqual([]);
  });

  it("keeps two control clients and namesake seats on their selected servers", async () => {
    const socket = join(dir, "isolated.sock");
    const serverArgs = ["-S", socket];
    tmux(...serverArgs, "new-session", "-d", "-s", "seat@rig", "-x", "120", "-y", "30", "printf 'isolated seat\\n'; exec cat");
    const isolatedSpawned: string[][] = [];
    const isolated = tmuxControlExec((argv) => { isolatedSpawned.push(argv); return execArgvCommand(argv); }, { serverArgs });
    try {
      const defaultSocket = tmux("display-message", "-p", "-t", "=seat@rig:", "#{socket_path}").trim();
      expect(await control(["tmux", "display-message", "-p", "-t", "=seat@rig:", "#{socket_path}"])).toBe(`${defaultSocket}\n`);
      expect(await isolated(["tmux", ...serverArgs, "display-message", "-p", "-t", "=seat@rig:", "#{socket_path}"])).toBe(`${socket}\n`);
      expect(sessions()).toEqual([controlSessionName(control.owner), "seat@rig"].sort());
      expect(tmux(...serverArgs, "list-sessions", "-F", "#{session_name}").trim().split("\n").sort())
        .toEqual([controlSessionName(isolated.owner), "seat@rig"].sort());

      const connected = isolatedSpawned.length;
      const adapter = new TmuxAdapter(async () => "", undefined, isolated, serverArgs);
      expect((await adapter.listSessions()).map((session) => session.name)).toEqual(["seat@rig"]);
      await vi.waitFor(async () => {
        expect(await isolated(["tmux", ...serverArgs, "capture-pane", "-p", "-t", "=seat@rig:", "-S", "-20"])).toContain("isolated seat");
      });
      expect(isolatedSpawned.slice(connected)).toEqual([]);

      // An explicit request for the other server never uses the already-connected isolated client.
      const other = ["tmux", "-S", defaultSocket, "display-message", "-p", "-t", "=seat@rig:", "#{socket_path}"];
      expect(await isolated(other)).toBe(`${defaultSocket}\n`);
      expect(isolatedSpawned.slice(connected)).toEqual([other]);
      await isolated.close();
      await vi.waitFor(() => expect(tmux(...serverArgs, "list-sessions", "-F", "#{session_name}")).toBe("seat@rig\n"));
      expect(sessions()).toEqual([controlSessionName(control.owner), "seat@rig"].sort());
    } finally {
      await isolated.close();
      try { tmux(...serverArgs, "kill-server"); } catch { /* already gone */ }
    }
  });

  it("answers each command with its own output while a user's after-hook prints blocks between them", async () => {
    tmux("set-hook", "-g", "after-list-panes", "list-sessions -F hook-output");
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    const pane = tmux("display-message", "-p", "-t", "=seat@rig:", "#{pane_id}");
    const replies = await Promise.all([
      control(["tmux", "list-panes", "-t", "=seat@rig:", "-F", "#{pane_id}"]),
      control(["tmux", "display-message", "-p", "-t", "=seat@rig:", "b1"]),
      control(["tmux", "display-message", "-p", "-t", "=seat@rig:", "b2"]),
    ]);
    // A spawned client prints the hook's output after its command's; the control client keeps it out of every reply.
    expect(tmux("list-panes", "-t", "=seat@rig:", "-F", "#{pane_id}")).toBe(`${pane}hook-output\nhook-output\n`);
    expect(replies).toEqual([pane, "b1\n", "b2\n"]);
    expect(await control(["tmux", "display-message", "-p", "-t", "=seat@rig:", "c1"])).toBe("c1\n");
  });

  it("leaves its own session and client out of every listing, renamed or not; a spawned client lists them, as main does", async () => {
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    const own = controlSessionName(control.owner);
    expect(sessions()).toEqual([own, "seat@rig"]);
    expect(tmux("show-options", "-v", "-t", `=${own}:`, CONTROL_OPTION).trim()).toBe(control.owner);
    tmux("rename-session", "-t", `=${own}`, "renamed");
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("seat@rig\n");
    expect(await control(["tmux", "list-windows", "-a", "-F", "#{session_name}"])).toBe("seat@rig\n");
    expect(await control(["tmux", "list-panes", "-a", "-F", "#{session_name}"])).toBe("seat@rig\n");
    const on = new TmuxAdapter(async () => "", undefined, control);
    expect((await on.listSessions()).map((s) => s.name)).toEqual(["seat@rig"]);
    expect(await on.listClients()).toEqual([]);
    expect((await new TmuxDiscoveryScanner({ tmuxAdapter: on }).scan()).panes.map((p) => p.tmuxSession)).toEqual(["seat@rig"]);
    const off = new TmuxAdapter(async () => "", undefined, execArgvCommand);
    expect((await off.listSessions()).map((s) => s.name).sort()).toEqual(["renamed", "seat@rig"]);
    expect((await off.listClients()).map((c) => c.session)).toEqual(["renamed"]);
    // The daemon's stop ends its client, and tmux destroys its session with it, whatever its name.
    await control.close();
    await vi.waitFor(() => expect(sessions()).toEqual(["seat@rig"]), { timeout: 5000, interval: 50 });
  });

  it("leaves its own session and client out of the very listing that starts its client", async () => {
    const listings = [
      ["tmux", "list-sessions", "-F", "#{session_name}"],
      ["tmux", "list-windows", "-a", "-F", "#{session_name}"],
      ["tmux", "list-panes", "-a", "-F", "#{session_name}"],
      ["tmux", "list-clients", "-F", "#{client_session}"],
    ];
    for (const argv of listings) {
      const first = tmuxControlExec(execArgvCommand);
      try {
        const expected = argv[1] === "list-clients" ? "" : "seat@rig\n";
        expect(await first(argv), argv.join(" ")).toBe(expected);
        expect(sessions()).toContain(controlSessionName(first.owner));
      } finally {
        await first.close();
      }
      await vi.waitFor(() => expect(sessions()).toEqual(["seat@rig"]), { timeout: 5000, interval: 50 });
    }
  });

  it("keeps every row and output that only reads like its own: a format or a later command printing its session's name", async () => {
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    const own = `${controlSessionName(control.owner)}:`;
    expect(await control(["tmux", "list-sessions", "-F", `${own}#{session_name}`])).toBe(`${own}seat@rig\n`);
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}", ";", "display-message", "-p", "-t", "=seat@rig:", `${own}x`]))
      .toBe(`seat@rig\n${own}x\n`);
    // A chain the spawned client runs (load-buffer is never routed) keeps them too.
    writeFileSync(join(dir, "buffer.txt"), "b");
    expect(await control(["tmux", "load-buffer", "-b", "own", join(dir, "buffer.txt"), ";", "list-sessions", "-F", `${own}#{session_name}`]))
      .toBe(`${own}seat@rig\n`);
  });

  it("never takes over a session it did not make: one with its name, another daemon's, or one named openrig-control", async () => {
    const own = controlSessionName(control.owner);
    tmux("new-session", "-d", "-s", own, "-x", "80", "-y", "24");
    tmux("new-session", "-d", "-s", "openrig-control", "-x", "80", "-y", "24");
    tmux("new-session", "-d", "-s", "other-daemon", "-x", "80", "-y", "24");
    tmux("set-option", "-t", "=other-daemon:", CONTROL_OPTION, "ffff0000");
    // Its own name is taken: no client attaches, nothing is marked, and every command is spawned.
    expect(await control(["tmux", "has-session", "-t", "=seat@rig"])).toBe("");
    expect(spawned.map((argv) => argv[1])).toEqual(["list-sessions", "has-session"]);
    expect(tmux("show-options", "-qv", "-t", `=${own}:`, CONTROL_OPTION).trim()).toBe("");
    const all = ["openrig-control", own, "other-daemon", "seat@rig"];
    expect((await new TmuxAdapter(async () => "", undefined, control).listSessions()).map((s) => s.name).sort()).toEqual(all);
    await control.close();
    expect(sessions()).toEqual(all);
  });

  it("lists another daemon's control session and client, and leaves them on its stop", async () => {
    const other = tmuxControlExec(execArgvCommand, { owner: "ffff0000" });
    try {
      await other(["tmux", "has-session", "-t", "=seat@rig"]);
      await control(["tmux", "has-session", "-t", "=seat@rig"]);
      expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("openrig-control-ffff0000\nseat@rig\n");
      expect((await new TmuxAdapter(async () => "", undefined, control).listClients()).map((c) => c.session))
        .toEqual(["openrig-control-ffff0000"]);
      await control.close();
      await vi.waitFor(() => expect(sessions()).toEqual(["openrig-control-ffff0000", "seat@rig"]), { timeout: 5000, interval: 50 });
    } finally {
      await other.close();
    }
  });

  it("lets the server exit with its last other session, as with spawned clients only, and starts none again", async () => {
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    expect(sessions()).toEqual([controlSessionName(control.owner), "seat@rig"]);
    tmux("kill-session", "-t", "=seat@rig");
    await vi.waitFor(() => expect(() => tmux("list-sessions")).toThrow(/no server running|error connecting/), { timeout: 5000, interval: 50 });
    await expect(control(["tmux", "has-session", "-t", "=seat@rig"])).rejects.toThrow(/no server running|error connecting/);
    expect(() => tmux("list-sessions")).toThrow(/no server running|error connecting/);
  });

  it("lets the server exit when only control sessions are left, two daemons' among them", async () => {
    const other = tmuxControlExec(execArgvCommand, { owner: "ffff0000" });
    try {
      await other(["tmux", "has-session", "-t", "=seat@rig"]);
      await control(["tmux", "has-session", "-t", "=seat@rig"]);
      expect(sessions()).toEqual([controlSessionName(control.owner), "openrig-control-ffff0000", "seat@rig"].sort());
      tmux("kill-session", "-t", "=seat@rig");
      await vi.waitFor(() => expect(() => tmux("list-sessions")).toThrow(/no server running|error connecting/), { timeout: 5000, interval: 50 });
    } finally {
      await other.close();
    }
  });

  it("stays while a session of no daemon's is left", async () => {
    tmux("new-session", "-d", "-s", "user", "-x", "80", "-y", "24");
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    tmux("kill-session", "-t", "=seat@rig");
    await sleep(300);
    expect(sessions()).toEqual([controlSessionName(control.owner), "user"]);
    const connecting = spawned.length;
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("user\n");
    expect(spawned.slice(connecting)).toEqual([]);
  });

  it("leaves no session behind when it is closed while attaching, or when its client dies with the daemon", async () => {
    const call = control(["tmux", "has-session", "-t", "=seat@rig"]);
    await control.close();
    expect(await call).toBe("");
    await vi.waitFor(() => expect(sessions()).toEqual(["seat@rig"]), { timeout: 5000, interval: 50 });
    const next = tmuxControlExec(execArgvCommand);
    await next(["tmux", "has-session", "-t", "=seat@rig"]);
    expect(sessions()).toEqual([controlSessionName(next.owner), "seat@rig"]);
    // A daemon killed outright: its client goes with it, and tmux destroys the session the client was in.
    process.kill(Number(tmux("list-clients", "-F", "#{client_pid}").trim()), "SIGKILL");
    await vi.waitFor(() => expect(sessions()).toEqual(["seat@rig"]), { timeout: 5000, interval: 50 });
    await next.close();
  });

  it("fails a chain past its output bound as a spawned client does, so a batched capture splits it and reads every pane", async () => {
    tmux("new-session", "-d", "-s", "two@rig", "-x", "120", "-y", "30", `cat ${join(dir, "screen.txt")}; exec cat`);
    await sleep(300);
    const mark = `__openrig_capture_${"0".repeat(32)}_0__`;
    const one = await execArgvCommand(["tmux", "display-message", "-p", "-t", "=seat@rig:", mark, ";", "capture-pane", "-p", "-t", "=seat@rig:", "-S", "-20"]);
    // One pane's chunk fits; two do not.
    const bounded = tmuxControlExec(execArgvCommand, { maxBuffer: Math.floor(Buffer.byteLength(one) * 1.5) });
    try {
      await bounded(["tmux", "has-session", "-t", "=seat@rig"]);
      const pair = ["tmux", "display-message", "-p", "-t", "=seat@rig:", mark, ";", "capture-pane", "-p", "-t", "=seat@rig:", "-S", "-20",
        ";", "display-message", "-p", "-t", "=two@rig:", mark, ";", "capture-pane", "-p", "-t", "=two@rig:", "-S", "-20"];
      await expect(bounded(pair)).rejects.toThrow(/^stdout maxBuffer length exceeded/);
      const captured = await new TmuxAdapter(async () => "", undefined, bounded).capturePanesContent(["seat@rig", "two@rig"], 20);
      const expected = await new TmuxAdapter(async () => "", undefined, execArgvCommand).capturePanesContent(["seat@rig", "two@rig"], 20);
      const texts = (m: typeof captured) => [...(m ?? new Map()).entries()].map(([t, c]) => [t, c.text]).sort();
      expect(texts(captured)).toEqual(texts(expected));
      expect(texts(captured)).toHaveLength(2);
      expect(texts(captured).every(([, text]) => typeof text === "string" && text.includes("last line"))).toBe(true);
    } finally {
      await bounded.close();
    }
  });

  it("runs its keep-alive without a shell of the user's: what default-shell names is never started", async () => {
    const shell = join(dir, "shell.sh");
    writeFileSync(shell, `#!/bin/sh\ntouch ${join(dir, "shell-ran")}\nexec sh "$@"\n`, { mode: 0o755 });
    tmux("set-option", "-g", "default-shell", shell);
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    const pane = (format: string) => tmux("display-message", "-p", "-t", `=${controlSessionName(control.owner)}:`, format).trim();
    // The pane reads as the server (tmux) until its fork has exec'd what it runs: past that, a default-shell started
    // would have left its file.
    await vi.waitFor(() => expect(pane("#{pane_current_command}")).not.toMatch(/^(tmux.*)?$/), { timeout: 5000, interval: 50 });
    expect(existsSync(join(dir, "shell-ran"))).toBe(false);
    // The platform's sh: macOS's /bin/sh runs as bash.
    expect(pane("#{pane_current_command}")).toMatch(/^(sh|bash|dash)$/);
    expect(pane("#{pane_start_command}")).toContain("sleep 86400");
  });

  it("writes into the pane what a spawned client writes, whatever the text holds", async () => {
    tmux("new-session", "-d", "-s", "typed@rig", "-x", "200", "-y", "10", "exec cat");
    await vi.waitFor(() => expect(tmux("display-message", "-p", "-t", "=typed@rig:", "#{pane_current_command}").trim()).toBe("cat"),
      { timeout: 5000, interval: 50 });
    const text = "it's $HOME ; #{session_name} ~root \\ é {braces} -t --";
    const file = join(dir, "paste.txt");
    writeFileSync(file, text);
    await control(["tmux", "load-buffer", "-b", "b1", file]);
    await control(["tmux", "paste-buffer", "-t", "=typed@rig:", "-b", "b1", "-d", "-r"]);
    await control(["tmux", "send-keys", "-t", "=typed@rig:", "Enter"]);
    // cat echoes each line it reads: the typed line, then cat's copy. Its copy is awaited before the next line is typed,
    // else the two can interleave on the screen.
    const lines = (count: number) => vi.waitFor(() => {
      const pane = tmux("capture-pane", "-p", "-t", "=typed@rig:");
      expect(pane.split("\n").filter((l) => l.includes("braces")), pane).toEqual(Array<string>(count).fill(text));
    }, { timeout: 5000, interval: 100 });
    await lines(2);
    await control(["tmux", "send-keys", "-t", "=typed@rig:", "-l", text]);
    await control(["tmux", "send-keys", "-t", "=typed@rig:", "Enter"]);
    await lines(4);
  });

  it("keeps working when its session is killed, and comes back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    tmux("kill-session", "-t", `=${controlSessionName(control.owner)}`);
    await vi.waitFor(async () => expect(await control(["tmux", "has-session", "-t", "=seat@rig"])).toBe(""));
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("seat@rig\n");
    vi.setSystemTime(Date.now() + 60_000);
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    expect(sessions()).toContain(controlSessionName(control.owner));
    vi.useRealTimers();
  });

  it("follows a kill-server and a new server: it fails over to spawned clients, then attaches to the new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    tmux("kill-server");
    await expect(control(["tmux", "has-session", "-t", "=seat@rig"])).rejects.toThrow(/no server running|error connecting/);
    tmux("new-session", "-d", "-s", "next@rig", "-x", "80", "-y", "24", "exec cat");
    vi.setSystemTime(Date.now() + 60_000);
    expect(await control(["tmux", "has-session", "-t", "=next@rig"])).toBe("");
    const connecting = spawned.length;
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("next@rig\n");
    expect(spawned.slice(connecting)).toEqual([]);
    expect(tmux("show-options", "-v", "-t", `=${controlSessionName(control.owner)}:`, CONTROL_OPTION).trim()).toBe(control.owner);
    vi.useRealTimers();
  });

  it("gives a write to a session that is gone the spawned client's error, and the adapter the same code", async () => {
    // Another session keeps the server, and the control client, up once the seat is gone.
    tmux("new-session", "-d", "-s", "user", "-x", "80", "-y", "24");
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    tmux("kill-session", "-t", "=seat@rig");
    const argv = ["tmux", "send-keys", "-t", "=seat@rig:", "Enter"];
    const connecting = spawned.length;
    expect(await outcome(control, argv)).toEqual(await outcome(execArgvCommand, argv));
    expect(spawned.slice(connecting)).toEqual([]);
    for (const exec of [control, execArgvCommand]) {
      expect(await new TmuxAdapter(async () => "", undefined, exec).sendKeys("=seat@rig:", ["Enter"])).toMatchObject({ ok: false, code: "session_not_found" });
    }
  });

  it("starts no server of its own and spawns what it does not route", async () => {
    tmux("kill-server");
    const spawned: string[][] = [];
    const exec = tmuxControlExec(async (argv) => { spawned.push(argv); return execArgvCommand(argv); });
    await expect(exec(["tmux", "has-session", "-t", "=seat@rig"])).rejects.toThrow(/no server running|error connecting/);
    expect(() => tmux("list-sessions")).toThrow();
    expect(spawned.map((a) => a[1])).toEqual(["list-sessions", "has-session"]);
    await exec.close();
  });
});
