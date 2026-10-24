import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter, defaultTmuxFileOps } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

// Synthetic values only: the fixture never copies an operator's provider environment.
const credentials = { CLAUDE_CODE_OAUTH_TOKEN: "SYNTHETIC-OAUTH-ONLY", OPENAI_API_KEY: "SYNTHETIC-API-ONLY", OPENRIG_ACTIVITY_HOOK_TOKEN: "SYNTHETIC-HOOK-ONLY" };
const exec = promisify(execFile);
for (const transport of ["argv", "legacy"] as const) {
  for (const scoped of [false, true]) for (const operation of ["create", "respawn"] as const) {
    it(`${transport} ${operation}, scoped=${scoped}: credentials stay off client and reset command lines`, async () => {
      const calls: string[] = [], writes = new Map<string, string>(); let sequence = 0;
      const respond = async (args: string[]) => {
        calls.push(...args);
        if (args.some(arg => arg.includes("default-shell"))) return "/bin/bash";
        return args.includes("new-session") || args.includes("source-file") ? "%1" : "";
      };
      const files = { writeFile: vi.fn(async (p: string, content: string, _options?: { mode: number; flag: "wx" }) => { writes.set(p, content); }), unlink: async () => {}, tmpName: () => `/tmp/synthetic-env-${++sequence}`, bufferName: () => "unused" };
      const a = new TmuxAdapter(command => respond([command]), files, transport === "argv" ? respond : undefined);
      a.launchEnvironment = () => ({ inheritTmuxEnvironment: !scoped, env: { ...credentials, PATH: "/bin" } });
      const env = { ...credentials, OPENRIG_NODE_ID: "synthetic-node", OPENRIG_DB: "/private/selected.sqlite", TMUX_TMPDIR: "/private/tmux" };
      const result = operation === "create" ? await a.createSession("synthetic-seat", "/private", env) : await a.respawnPane("%1", "/bin/sh", { env });
      expect(result.ok).toBe(true);
      expect(calls.some(arg => Object.values(credentials).some(value => arg.includes(value)))).toBe(false);
      if (scoped) {
        // source-file hides the tmux client's inputs, but the nested shell argv must be safe too.
        const plan = await (a as unknown as { scopedLaunchCommand(env: Record<string, string>, command: string): Promise<string[] | null> }).scopedLaunchCommand(env, "/bin/sh");
        expect(plan?.some(arg => Object.values(credentials).some(value => arg.includes(value)))).toBe(false);
      }
      expect([...writes.values()].some(content => content.includes(credentials.OPENRIG_ACTIVITY_HOOK_TOKEN))).toBe(true);
      for (const call of files.writeFile.mock.calls) expect(call[2]).toEqual({ mode: 0o600, flag: "wx" });
    });
  }
  it(`${transport}: restoring a one-off credential does not put its value in set-environment argv`, async () => {
    const calls: string[] = [];
    const a = new TmuxAdapter(async command => { calls.push(command); return ""; }, {
      writeFile: async () => {}, unlink: async () => {}, tmpName: () => "/tmp/synthetic-cleanup", bufferName: () => "unused",
    }, transport === "argv" ? async args => { calls.push(...args); return ""; } : undefined);
    await a.setSessionEnv("synthetic-seat", "CLAUDE_CODE_OAUTH_TOKEN", credentials.CLAUDE_CODE_OAUTH_TOKEN);
    expect(calls.some(arg => arg.includes(credentials.CLAUDE_CODE_OAUTH_TOKEN))).toBe(false);
  });
}

it("a private-file write failure never falls back to credential-bearing argv", async () => {
  const calls: string[] = [];
  const a = new TmuxAdapter(async command => { calls.push(command); return ""; }, {
    writeFile: async () => { throw new Error("synthetic write failure"); }, unlink: async () => {}, tmpName: () => "/tmp/not-created", bufferName: () => "unused",
  });
  expect((await a.createSession("synthetic", undefined, credentials)).ok).toBe(false);
  expect((await a.respawnPane("%1", "/bin/sh", { env: credentials })).ok).toBe(false);
  await expect(a.setSessionEnv("synthetic", "OPENAI_API_KEY", credentials.OPENAI_API_KEY)).rejects.toThrow();
  expect(calls.some(arg => Object.values(credentials).some(value => arg.includes(value)))).toBe(false);
});

describe.skipIf(process.platform === "win32")("owned tmux credential delivery (no provider)", () => {
  it.each(["inherited", "scoped", "fallback"] as const)("%s: fresh and respawned panes receive exact credentials and public env", async mode => {
    const home = mkdtempSync(path.join(tmpdir(), "tmux private env ")), socket = path.join(home, "owned.sock"), output = path.join(home, "observed");
    const env = { HOME: home, PATH: process.env.PATH!, SHELL: "/bin/bash" };
    const calls: string[][] = [], staged: string[] = [];
    const tmux = async (args: string[]) => (await exec("tmux", ["-S", socket, ...args], { env })).stdout.trim();
    const files = defaultTmuxFileOps(); let sequence = 0;
    files.tmpName = () => path.join(home, `private-${++sequence}`);
    const write = files.writeFile;
    files.writeFile = async (p, body, options) => { await write(p, body, options); staged.push(p); expect(statSync(p).mode & 0o777).toBe(0o600); };
    const a = new TmuxAdapter(async () => { throw new Error("argv fixture"); }, files, args => {
      calls.push(args);
      if (mode === "fallback" && args.includes("default-shell")) throw new Error("synthetic unavailable inspection");
      return tmux(args.slice(1));
    });
    const selected = { ...credentials, OPENRIG_NODE_ID: "synthetic-node", OPENRIG_DB: path.join(home, "selected db.sqlite"), TMUX_TMPDIR: path.join(home, "tmux directory"), BACKSLASH_LF: "one\\\ntwo", INDENTED: "one\n  two", HASH_LINE: "one\n#two\nthree", EMPTY: "", QUOTED: "quote ' and \\ and\nnewline" };
    a.launchEnvironment = () => ({ inheritTmuxEnvironment: mode === "inherited", env });
    const session = "seat' x", target = `=${session}:`;
    const receiver = path.join(home, "receive.cjs");
    writeFileSync(receiver, `const fs=require('fs'); const names=${JSON.stringify(Object.keys(selected))}; fs.writeFileSync(${JSON.stringify(output + ".part")},JSON.stringify(Object.fromEntries(names.map(k=>[k,process.env[k]])))); fs.renameSync(${JSON.stringify(output + ".part")},${JSON.stringify(output)});`);
    const command = `${shellQuote(process.execPath)} ${shellQuote(receiver)}`;
    const read = async () => {
      for (let i = 0; i < 100 && !existsSync(output); i++) await new Promise(r => setTimeout(r, 25));
      return JSON.parse(readFileSync(output, "utf8"));
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      if (mode === "inherited") {
        // Creation must still bootstrap an absent server; source-file alone does not.
        expect((await a.createSession("bootstrap", home, selected)).ok).toBe(true);
        expect(await a.getSessionEnv("bootstrap", "OPENRIG_DB")).toBe(selected.OPENRIG_DB);
        await tmux(["kill-server"]);
      }
      await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 60"]);
      await tmux(["set-option", "-g", "default-shell", "/bin/bash"]);
      await tmux(["set-option", "-g", "update-environment", ""]);
      await tmux(["set-option", "-g", "default-command", `${command}; exec /bin/sleep 60`]);
      expect((await a.createSession(session, home, selected)).ok).toBe(true);
      expect(await read()).toEqual(selected); rmSync(output);
      // Only this disposable fixture's pane is stopped, with scrollback/pane retained.
      await tmux(["set-window-option", "-t", target, "remain-on-exit", "on"]);
      await tmux(["respawn-pane", "-k", "-t", target, "/bin/sh", "-c", "exit"]);
      for (let i = 0; i < 100 && await tmux(["display-message", "-p", "-t", target, "#{pane_dead}"]) !== "1"; i++) await new Promise(r => setTimeout(r, 25));
      expect((await a.respawnPane(target, command, { env: selected, cwd: home })).ok).toBe(true);
      expect(await read()).toEqual(selected); rmSync(output);
      // Read restored values from a new process, not tmux display formatting.
      for (const [key, value] of Object.entries(selected)) await a.setSessionEnv(session, key, value);
      await tmux(["new-window", "-d", "-t", target, command]);
      expect(await read()).toEqual(selected);
      await a.setSessionEnv(session, "CLAUDE_CODE_OAUTH_TOKEN", credentials.CLAUDE_CODE_OAUTH_TOKEN);
      expect(await a.getSessionEnv(session, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(credentials.CLAUDE_CODE_OAUTH_TOKEN);
      expect(calls.flat().some(arg => Object.values(credentials).some(value => arg.includes(value)))).toBe(false);
      for (const file of staged) expect(existsSync(file)).toBe(false);
    } finally { warning.mockRestore(); await tmux(["kill-server"]).catch(() => {}); rmSync(home, { recursive: true, force: true }); }
  });
});
