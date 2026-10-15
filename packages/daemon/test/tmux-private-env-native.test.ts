import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter, defaultTmuxFileOps } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const run = promisify(exec);
const runFile = promisify(execFile);
const TOKEN = "fixture-activity-token";
const CREDENTIAL = "fixture-provider-credential ' \" \\ $HOME ${HOME} $(false) `false` ; # #{pane_id}\nnext\r\t中文";
const ENV = {
  OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN,
  PROVIDER_FIXTURE_CREDENTIAL: CREDENTIAL,
  OPENRIG_NODE_ID: "fixture-node",
  EMPTY: "",
  HERDR_PANE_ID: "explicit-seat-pane",
};
const REPORT_KEYS = [...Object.keys(ENV), "CLAUDECODE", "CLAUDE_EFFORT", "OPENRIG_TRANSCRIPTS_LINES", "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"];

async function readReport(file: string): Promise<{ cwd: string; env: Record<string, string> }> {
  let report;
  await expect.poll(() => {
    try { report = JSON.parse(fs.readFileSync(file, "utf8")); return true; }
    catch { return false; }
  }, { timeout: 10000 }).toBe(true);
  return report;
}

async function fixture(mode: "shell" | "argv", stagingDirectory?: string) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "private-env-")));
  const socket = path.join(home, "s");
  const env = {
    PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", TERM: "xterm-256color", MOTD_SHOWN: "test",
    CLAUDECODE: "1", CLAUDE_EFFORT: "max", HERDR_PANE_ID: "parent-pane",
    OPENRIG_TRANSCRIPTS_LINES: "777", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "44",
  };
  const tmux = async (args: string[]) => (await runFile("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env })).stdout;
  const commands: string[] = [];
  const staged: string[] = [];
  const modes: number[] = [];
  const files = defaultTmuxFileOps();
  const directory = stagingDirectory ? path.join(home, stagingDirectory) : undefined;
  if (directory) fs.mkdirSync(directory);
  const adapter = new TmuxAdapter(async command => {
    commands.push(command);
    return (await run(`tmux -S ${shellQuote(socket)} -f /dev/null ${command.slice(5)}`, { env })).stdout;
  }, {
    ...files,
    ...(directory ? { tmpName: () => path.join(directory, path.basename(files.tmpName())) } : {}),
    async writeFile(file, content, options) {
      await files.writeFile(file, content, options);
      staged.push(file);
      modes.push(fs.statSync(file).mode & 0o777);
    },
  }, mode === "argv" ? async argv => {
    commands.push(JSON.stringify(argv));
    return tmux(argv.slice(1));
  } : undefined);
  // The pane reports selected fixture values to a file, never to its transcript or argv.
  const script = path.join(home, "report.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), env: Object.fromEntries(${JSON.stringify(REPORT_KEYS)}.map(key => [key, process.env[key]])) }));`);
  const reportCommand = (file: string) => `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(file)}`;
  const report = async (target: string, file: string) => {
    await tmux(["send-keys", "-t", target, "-l", reportCommand(file)]);
    await tmux(["send-keys", "-t", target, "Enter"]);
    return readReport(file);
  };
  const privateCommands = () => {
    expect(commands.join("\n")).not.toContain(TOKEN);
    expect(commands.join("\n")).not.toContain("fixture-provider-credential");
    expect(staged.length).toBeGreaterThan(0);
    expect(modes.every(mode => mode === 0o600)).toBe(true);
    expect(staged.filter(file => fs.existsSync(file))).toEqual([]);
  };
  return { home, tmux, adapter, report, reportCommand, privateCommands,
    async close() {
      await tmux(["kill-server"]).catch(() => {});
      for (const file of staged) fs.rmSync(file, { force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")("private seat environment with native tmux", () => {
  for (const mode of ["shell", "argv"] as const) {
    it(`${mode}: starts a cold server, preserves literal values and removes the private file even on duplicate launch`, async () => {
      const f = await fixture(mode);
      try {
        const cwd = path.join(f.home, "a 'quoted' workspace");
        fs.mkdirSync(cwd);
        expect(await f.adapter.createSession("seat' one", cwd, ENV)).toEqual({ ok: true });
        const actual = await f.report("=seat' one:", path.join(f.home, "launch.json"));
        expect(actual).toEqual({ cwd, env: { ...ENV, OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "" } });
        const duplicate = await f.adapter.createSession("seat' one", cwd, ENV);
        expect(duplicate).toMatchObject({ ok: false, code: "duplicate_session" });
        if (!duplicate.ok) expect(duplicate.message).not.toContain(TOKEN);
        f.privateCommands();
      } finally { await f.close(); }
    });

    it(`${mode}: gives a successor its private environment in the same pane without clearing predecessor history`, async () => {
      const f = await fixture(mode);
      try {
        // Seed deep scrollback before exit; a respawn may redraw the visible screen.
        const predecessor = "i=0; while [ \"$i\" -lt 40 ]; do printf 'predecessor-history-%s\\n' \"$i\"; i=$((i + 1)); done; exec cat";
        const pane = (await f.tmux(["new-session", "-d", "-s", "seat", "-x", "110", "-y", "24", "-P", "-F", "#{pane_id}", predecessor])).trim();
        await f.tmux(["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
        await expect.poll(async () => {
          const history = await f.tmux(["capture-pane", "-p", "-J", "-t", pane, "-S", "-"]);
          return history.includes("predecessor-history-0") && history.includes("predecessor-history-39");
        }, { timeout: 10000 }).toBe(true);
        process.kill(Number((await f.tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"])).trim()), "SIGTERM");
        await expect.poll(async () => (await f.tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"])).trim(), { timeout: 10000 }).toBe("1");
        const output = path.join(f.home, "successor.json");
        expect(await f.adapter.respawnPane(pane, `${f.reportCommand(output)}; exec /bin/sh`, { cwd: f.home, env: ENV })).toEqual({ ok: true });
        expect(await readReport(output)).toEqual({ cwd: f.home, env: { ...ENV, OPENRIG_TRANSCRIPTS_LINES: "777", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "44" } });
        expect((await f.tmux(["list-panes", "-t", "=seat:", "-F", "#{pane_id}"])).trim()).toBe(pane);
        expect(await f.tmux(["capture-pane", "-p", "-J", "-t", pane, "-S", "-"])).toContain("predecessor-history-0");
        f.privateCommands();
      } finally { await f.close(); }
    });

    it(`${mode}: reads a literal private path containing glob metacharacters`, async () => {
      const f = await fixture(mode, "staged [literal]*?\\");
      try {
        expect(await f.adapter.createSession("literal", f.home, ENV)).toEqual({ ok: true });
        expect((await f.report("=literal:", path.join(f.home, "literal.json"))).env).toMatchObject(ENV);
        f.privateCommands();
      } finally { await f.close(); }
    });

    it(`${mode}: parallel seats keep distinct values and leave the server environment unchanged`, async () => {
      const f = await fixture(mode);
      try {
        expect(await Promise.all([
          f.adapter.createSession("first", f.home, { ...ENV, OPENRIG_ACTIVITY_HOOK_TOKEN: `${TOKEN}-first` }),
          f.adapter.createSession("second", f.home, { ...ENV, OPENRIG_ACTIVITY_HOOK_TOKEN: `${TOKEN}-second` }),
        ])).toEqual([{ ok: true }, { ok: true }]);
        const [first, second] = await Promise.all([
          f.report("=first:", path.join(f.home, "first.json")),
          f.report("=second:", path.join(f.home, "second.json")),
        ]);
        expect(first.env.OPENRIG_ACTIVITY_HOOK_TOKEN).toBe(`${TOKEN}-first`);
        expect(second.env.OPENRIG_ACTIVITY_HOOK_TOKEN).toBe(`${TOKEN}-second`);
        expect((await f.tmux(["show-environment", "-g", "HERDR_PANE_ID"])).trim()).toBe("HERDR_PANE_ID=parent-pane");
        await expect(f.tmux(["show-environment", "-g", "OPENRIG_ACTIVITY_HOOK_TOKEN"])).rejects.toThrow();
        f.privateCommands();
      } finally { await f.close(); }
    });
  }
});
