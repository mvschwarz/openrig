import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTerminalInWindow, viewerTerminalEnv, windowTarget } from "../src/terminals/open-window.js";

const probe = vi.hoisted(() => ({ environment: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn((...args: any[]) => {
    if (args[0] !== "tmux") {
      const callback = args.pop();
      return (actual.execFile as any)(...args, (error: Error | null, stdout: string, stderr: string) => callback(error, { stdout, stderr }));
    }
    args[args.length - 1](null, { stdout: "100 123 0\n", stderr: "" });
  }) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn((...args: any[]) => args[0] === "/proc/123/environ"
    ? Promise.resolve(probe.environment) : (actual.readFile as any)(...args)) };
});
afterEach(() => vi.unstubAllEnvs());

it("carries a headless core client's markers from the Linux reader through the shared TUI's open", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-core-viewer-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const key of ["TERM_PROGRAM", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "REX_SESSION", "REX_BLOCK", "REX_SERVER", "CMUX_SOCKET_PATH", "CMUX_SURFACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]) vi.stubEnv(key, "");
    vi.stubEnv("TMUX", "/fixture/tmux,1,0");
    vi.stubEnv("TMUX_PANE", "%1");
    const markers = { HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/fixture/core.sock", HERDR_APP_HOME: root };
    probe.environment = Object.entries({ ...markers, SECRET_TOKEN: "not-forwarded" }).map(([key, value]) => `${key}=${value}`).join("\0");
    Object.defineProperty(process, "platform", { value: "linux" });
    const viewed = await viewerTerminalEnv();
    Object.defineProperty(process, "platform", platform);
    expect(viewed).toEqual(markers);
    const entry = join(root, "cli.mjs"), calls = join(root, "calls.json");
    writeFileSync(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({provider:'herdr-app',ok:true,opened:['seat'],absent:[],degraded:[],pages:1}));`);
    await openTerminalInWindow("rig:demo", "http://localhost:7433", entry, "plan", undefined, async () => viewed);
    expect(JSON.parse(readFileSync(calls, "utf8"))).toEqual(["terminal", "open", "--provider", "herdr-app", "--app-home", root, "--json", "--expected-plan", "plan", "--", "rig:demo"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(root, { recursive: true, force: true });
  }
});

it("targets the viewing client's own app home when only its HOME differs from the TUI's", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-core-home-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const key of ["TERM_PROGRAM", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "REX_SESSION", "REX_BLOCK", "REX_SERVER", "CMUX_SOCKET_PATH", "CMUX_SURFACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HERDR_APP_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(key, "");
    vi.stubEnv("TMUX", "/fixture/tmux,1,0");
    vi.stubEnv("TMUX_PANE", "%1");
    vi.stubEnv("HOME", join(root, "tui"));
    const clientHome = join(root, "client"), appHome = join(clientHome, ".config", "herdr-app");
    mkdirSync(appHome, { recursive: true });
    writeFileSync(join(appHome, "herdr-app.sock"), "");
    const markers = { HC_TERMINAL_ID: "t5", HC_TERMINAL_SOCKET: "/fixture/core.sock" };
    probe.environment = Object.entries({ ...markers, HOME: clientHome }).map(([key, value]) => `${key}=${value}`).join("\0");
    Object.defineProperty(process, "platform", { value: "linux" });
    const viewed = await viewerTerminalEnv();
    Object.defineProperty(process, "platform", platform);
    expect(viewed).toEqual({ ...markers, HERDR_APP_HOME: appHome });
    expect(await windowTarget(async () => viewed)).toEqual({ provider: "herdr-app", appHome });
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(root, { recursive: true, force: true });
  }
});
