import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrAppHome, inHerdrApp, openTerminalInWindow, windowTarget } from "../src/terminals/open-window.js";
import { readTerminals, terminalLines } from "../src/terminals/terminal-model.js";
import type { DaemonClient } from "../src/daemon-client.js";
import type { FleetSnapshot, ViewState } from "../src/types.js";

// Every marker the target choice reads, cleared so the test host's own terminal can't decide.
const KEYS = ["TERM_PROGRAM", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_SESSION", "REX_SESSION", "REX_BLOCK", "REX_SERVER",
  "CMUX_SOCKET_PATH", "CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SESSION", "HC_SOCKET",
  "HERDR_APP_HOME", "XDG_CONFIG_HOME", "TMUX", "TMUX_PANE"];
const roots: string[] = [];
// Built before collection: the table below reads it.
const appHome = mkdtempSync(join(tmpdir(), "tui-herdr-app-"));
writeFileSync(join(appHome, "herdr-app.sock"), ""); // stands in for the window's socket file

function ownEnv(env: Record<string, string>) {
  for (const key of KEYS) { vi.stubEnv(key, ""); delete process.env[key]; }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}
const inApp = () => ({ HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/run/core.sock", HERDR_APP_HOME: appHome });

afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => rmSync(appHome, { recursive: true, force: true }));

describe("herdr-app as the TUI's terminal target", () => {
  it("resolves herdr-app's home as herdr-app does", () => {
    expect(herdrAppHome({ HERDR_APP_HOME: "/a" })).toBe("/a");
    expect(herdrAppHome({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/herdr-app");
    expect(herdrAppHome({ HOME: "/h" })).toBe("/h/.config/herdr-app");
  });

  it("needs the core terminal's markers AND that home's window socket: markers alone invent no endpoint", () => {
    expect(inHerdrApp(inApp())).toBe(true);
    expect(inHerdrApp({ HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/s", HERDR_APP_HOME: join(appHome, "absent") })).toBe(false);
    expect(inHerdrApp({ HERDR_APP_HOME: appHome })).toBe(false);
  });

  it.each([
    ["in a herdr-app terminal", inApp(), undefined, { provider: "herdr-app" }],
    ["a shared TUI viewed from a herdr-app terminal", { TERM_PROGRAM: "tmux" }, inApp(), { provider: "herdr-app" }],
    ["markers whose window socket is missing", { ...inApp(), HERDR_APP_HOME: join(appHome, "absent") }, undefined, { provider: "herdr" }],
    ["an old Herdr pane, whatever else is set", { ...inApp(), HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/h" }, undefined, { provider: "herdr" }],
    ["inside Rex", { ...inApp(), TERM_PROGRAM: "rex" }, undefined, { provider: "rex" }],
    ["any other configuration", { TERM_PROGRAM: "tmux" }, undefined, { provider: "herdr" }],
  ] as const)("%s", async (_name, env, viewed, expected) => {
    ownEnv(env);
    const target = await windowTarget(async () => viewed);
    expect(target).toMatchObject(expected);
    if (expected.provider === "herdr-app") expect(target).toMatchObject({ appHome });
  });

  it("previews with the same client it opens in, so the plan matches", async () => {
    ownEnv(inApp());
    const previewed: unknown[] = [];
    const client = { baseUrl: "http://localhost:7433", terminalViews: async () => ({ saved: [], rigs: [] }),
      previewTerminal: async (_view: string, target: unknown) => { previewed.push(target); return null; } } as unknown as DaemonClient;
    await readTerminals(client, "rig:demo");
    expect(previewed).toEqual([{ provider: "herdr-app", appHome }]);
  });

  it("a herdr-app preview says where the view opens when available, and refuses with no open action when not answering", () => {
    const pane = { seat: "dev.build@demo", label: "dev.build", readOnly: false, paneCommand: "tmux attach -t =dev.build@demo" };
    const preview = (provider: string, available = true) => ({
      catalog: [], catalogLoaded: true, daemonTarget: "http://127.0.0.1:7433",
      preview: { view: "rig:demo", provider, planId: "p1", status: { available, launch: { socketPath: `${appHome}/herdr-app.sock` } },
        composed: { id: "c", pages: [[pane]], opened: [{ seat: pane.seat }], absent: [], degraded: [] }, grids: [{ columns: 1, rows: 1, blanks: 0 }] },
    });
    const state = { terminalView: "rig:demo", terminalPage: 0, filter: "", expanded: [] } as unknown as ViewState;
    const linesFor = (provider: string, available = true) => terminalLines(state, { terminals: preview(provider, available) } as unknown as FleetSnapshot, 300);
    const text = (provider: string, available = true) => linesFor(provider, available).map((l) => l.text).join("\n");
    const inApp = text("herdr-app", true);
    expect(inApp).toContain("Opens here: a new Rig view in this herdr-app window");
    expect(linesFor("herdr-app", true).some((l) => l.action?.type === "act" && l.action.act === "open-terminal")).toBe(true);
    for (const absent of ["On a desktop", "Headless or remote", "env -u TMUX", "desktop window"]) expect(inApp).not.toContain(absent);
    expect(text("herdr")).toContain("Headless or remote"); // other targets keep their recipe

    const stale = text("herdr-app", false);
    expect(stale).toContain(`herdr-app is not answering at ${appHome}/herdr-app.sock (the socket file exists, but nothing replied). Nothing will open from here. Start herdr-app, or run \`rig terminal open rig:demo --window\` for a desktop window.`);
    expect(stale).not.toContain("Opens here");
    expect(linesFor("herdr-app", false).some((l) => l.action?.type === "act" && l.action.act === "open-terminal")).toBe(false);
  });

  it("opens in the TUI's own herdr-app window through the daemon: --provider herdr-app with that client, never --window", async () => {
    ownEnv(inApp());
    const root = mkdtempSync(join(tmpdir(), "tui-herdr-app-cli-")); roots.push(root);
    const entry = join(root, "cli.mjs"), calls = join(root, "calls.json");
    writeFileSync(entry, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),display:process.env.DISPLAY??null}));
console.log(JSON.stringify({provider:"herdr-app",ok:true,opened:["dev.build@demo"],absent:[],degraded:[],pages:1}));`);
    const result = await openTerminalInWindow("rig:demo", "http://localhost:7433", entry, "plan-1");
    expect(result.opened).toEqual(["dev.build@demo"]);
    const seen = JSON.parse(readFileSync(calls, "utf8")) as { args: string[] };
    expect(seen.args).toEqual(["terminal", "open", "--provider", "herdr-app", "--app-home", appHome, "--json", "--expected-plan", "plan-1", "--", "rig:demo"]);
    expect(seen.args).not.toContain("--window");
  });
});
