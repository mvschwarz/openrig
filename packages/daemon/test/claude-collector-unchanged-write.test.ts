// The context collector's status line is provisioned on every context poll. When the seat's
// .claude/settings.local.json already holds it, nothing is written: the file keeps its bytes, mtime and inode. Through
// the same real filesystem operations the daemon uses, in a temporary seat directory.
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { replaceFile } from "../src/adapters/replace-file.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function seat() {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "collector-unchanged-"));
  roots.push(root);
  const cwd = nodePath.join(root, "seat"), state = nodePath.join(root, "openrig");
  fs.mkdirSync(nodePath.join(cwd, ".claude"), { recursive: true });
  const asset = nodePath.join(root, "collector.cjs");
  fs.writeFileSync(asset, "// collector\n");
  const writes: string[] = [];
  const fsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => { writes.push(p); fs.writeFileSync(p, c, "utf-8"); },
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    copyFile: replaceFile,
    homedir: os.homedir(),
  };
  const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps, stateDir: state, collectorAssetPath: asset });
  const settings = nodePath.join(cwd, ".claude", "settings.local.json");
  const command = `${shellQuote(process.execPath)} ${shellQuote(nodePath.join(cwd, ".openrig", "context-collector.cjs"))} `
    + `${shellQuote(nodePath.join(state, "state", "context-usage"))} ${shellQuote(nodePath.join(state, "state", "provider-usage"))}`;
  const poll = () => adapter.ensureContextCollector({ cwd, tmuxSession: "seat@rig" });
  return { cwd, settings, command, writes, poll };
}

const PAST = new Date("2026-01-01T00:00:00.000Z");

describe("the context collector writes the seat's settings only when its status line needs it", () => {
  it("with the status line already present (another writer's key order and spacing), repeated polls write nothing", () => {
    const s = seat();
    const text = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, statusLine: { command: s.command, type: "command" } });
    fs.writeFileSync(s.settings, text);
    fs.utimesSync(s.settings, PAST, PAST);
    const before = fs.statSync(s.settings);
    s.poll();
    s.poll();
    const after = fs.statSync(s.settings);
    expect(s.writes).toEqual([]);
    expect(fs.readFileSync(s.settings, "utf-8")).toBe(text);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it("after installing the status line itself, the next poll writes nothing", () => {
    const s = seat();
    s.poll();
    expect(s.writes).toHaveLength(1);
    const text = fs.readFileSync(s.settings, "utf-8");
    s.poll();
    expect(s.writes).toHaveLength(1);
    expect(fs.readFileSync(s.settings, "utf-8")).toBe(text);
  });

  // Each of these behaves as before the skip.
  const user = { statusLine: { type: "command", command: "~/bin/my-status.sh", padding: 1 }, permissions: { allow: ["Bash(ls:*)"] } };
  it.each<[string, (command: string) => string | null, "written" | "untouched", (statusLine: Record<string, unknown> | undefined, file: Record<string, unknown>, command: string) => void]>([
    ["a missing file", () => null, "written", (sl, _f, c) => expect(sl).toEqual({ type: "command", command: c })],
    ["an empty file", () => "  \n", "written", (sl, _f, c) => expect(sl).toEqual({ type: "command", command: c })],
    ["a file without a status line (unrelated keys kept)", () => JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, env: { A: "1" } }), "written",
      (sl, f, c) => { expect(sl).toEqual({ type: "command", command: c }); expect(f).toMatchObject({ permissions: { allow: ["Bash(ls:*)"] }, env: { A: "1" } }); }],
    ["a status line without a command (its other keys kept)", () => JSON.stringify({ statusLine: { padding: 3 } }), "written",
      (sl, _f, c) => expect(sl).toEqual({ padding: 3, type: "command", command: c })],
    ["the collector's own command with another type", (c) => JSON.stringify({ statusLine: { type: "static", command: c } }), "written",
      (sl, _f, c) => expect(sl).toEqual({ type: "command", command: c })],
    ["the collector's older three-token command", () => JSON.stringify({ statusLine: { type: "command", command: "node /seat/.openrig/context-collector.cjs /old/state/context", padding: 2 } }), "written",
      (sl, _f, c) => expect(sl).toEqual({ type: "command", command: c, padding: 2 })],
    ["a stale collector command from another state directory", () => JSON.stringify({ statusLine: { type: "command", command: "node /old/.openrig/context-collector.cjs /old/ctx /old/prov" } }), "written",
      (sl, _f, c) => expect(sl).toEqual({ type: "command", command: c })],
    ["a JSON value that isn't an object", () => "[]", "untouched", () => {}],
    ["a user's own status line", () => JSON.stringify(user, null, 2), "untouched", () => {}],
    ["a file that can't be parsed", () => '{ "permissions": { "allow": ["Bash(ls:*)"] }, ', "untouched", () => {}],
  ])("control: %s", (_label, initial, outcome, check) => {
    const s = seat();
    const text = initial(s.command);
    if (text !== null) fs.writeFileSync(s.settings, text);
    s.poll();
    if (outcome === "untouched") {
      expect(s.writes).toEqual([]);
      expect(fs.readFileSync(s.settings, "utf-8")).toBe(text);
      return;
    }
    expect(s.writes).toEqual([s.settings]);
    const file = JSON.parse(fs.readFileSync(s.settings, "utf-8")) as Record<string, unknown>;
    check(file["statusLine"] as Record<string, unknown> | undefined, file, s.command);
  });
});
