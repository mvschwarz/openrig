import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHerdrViewerRun, HerdrViewer } from "../src/domain/terminal/herdr-viewer.js";
import { createHerdrProviders } from "../src/domain/terminal/herdr-sessions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

// Executes the real runner against a disposable CLI stand-in. This checks argv,
// environment and socket confirmation, not native Herdr selector support.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "herdr-run-")); roots.push(root);
  const bin = path.join(root, "bin"); mkdirSync(bin);
  const log = path.join(root, "calls.jsonl");
  writeFileSync(path.join(bin, "herdr"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const seen = { args, home: process.env.HOME, configHome: process.env.XDG_CONFIG_HOME,
  socket: process.env.HERDR_SOCKET_PATH, session: process.env.HERDR_SESSION ?? null };
fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(seen) + '\\n');
console.log(JSON.stringify({ ...seen, running: true, version: '0.9.5', protocol: 22,
  socket: process.env.PROBE_WRONG_SOCKET || seen.socket }));
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { PATH: bin, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
    HERDR_SESSION: "prod", HERDR_SOCKET_PATH: path.join(root, "old.sock"), PROBE_LOG: log };
  return { root, env, log, calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

describe.skipIf(process.platform === "win32")("selected Herdr CLI endpoint", () => {
  it("keeps the exact socket and captured environment for status and subsequent commands", async () => {
    const f = fixture();
    const endpoint = { socketPath: path.join(f.root, "private endpoint.sock"), session: "prod" };
    const selectedSocket = endpoint.socketPath, capturedHome = f.env.HOME, capturedConfig = f.env.XDG_CONFIG_HOME;
    const run = createHerdrViewerRun(endpoint, f.env);
    f.env.HOME = "/changed-home"; f.env.XDG_CONFIG_HOME = "/changed-config"; f.env.PATH = "/missing-bin";
    f.env.HERDR_SOCKET_PATH = "/changed-source.sock"; endpoint.socketPath = "/changed-endpoint.sock";
    vi.stubEnv("HERDR_SESSION", "wrong-live-session"); vi.stubEnv("HERDR_SOCKET_PATH", "/wrong-live.sock");
    for (const args of [["status", "server", "--json"], ["pane", "list"], ["tab", "focus", "t1"]]) {
      expect(JSON.parse(await run(args))).toMatchObject({ args, socket: selectedSocket, home: capturedHome, configHome: capturedConfig, session: null });
    }
    expect(f.calls()).toHaveLength(3);
  });

  it("keeps the equality guard before any viewer mutation if the CLI selects another socket", async () => {
    const f = fixture(), socketPath = path.join(f.root, "selected.sock");
    f.env.PROBE_WRONG_SOCKET = "/wrong/default.sock";
    const run = createHerdrViewerRun({ socketPath }, f.env);
    const inspect = vi.fn();
    const viewer = new HerdrViewer(socketPath, run, "linux", path.join(f.root, "journal"), inspect);
    expect(await viewer.ensure({ hostId: "self", nodeId: "a" }, { seat: "a", label: "a", paneCommand: "tmux attach", readOnly: false }))
      .toMatchObject({ ok: false, code: "viewer_unconfirmed" });
    expect(inspect).not.toHaveBeenCalled();
    expect(f.calls().map(call => call.args)).toEqual([["status", "server", "--json"]]);
  });

  it.skipIf(process.platform !== "linux")("provider wiring carries the startup snapshot into both viewer and follow runners", async () => {
    const f = fixture(), socketPath = path.join(f.root, "outside-config.sock");
    vi.stubEnv("OPENRIG_HOME", path.join(f.root, "oh"));
    f.env.HERDR_SOCKET_PATH = socketPath;
    f.env.XDG_CONFIG_HOME = "relative-config";
    const home = f.env.HOME, configHome = path.resolve(f.env.XDG_CONFIG_HOME);
    const providers = createHerdrProviders(f.env);
    f.env.PATH = "/missing-bin"; f.env.HOME = "/changed-home"; f.env.XDG_CONFIG_HOME = "/changed-config";
    f.env.HERDR_SESSION = "other"; f.env.HERDR_SOCKET_PATH = "/changed.sock";
    vi.stubEnv("HERDR_SOCKET_PATH", "/wrong-live.sock");
    const selected = providers.sessionProvider("prod");
    for (const provider of [providers.defaultProvider, selected]) {
      const result = await provider.lookupViewer({ hostId: "self", nodeId: "a" }, { seat: "a", label: "a", paneCommand: "tmux attach", readOnly: false });
      expect(result).toMatchObject({ ok: false, error: "Only verified local tmux bindings support ensure-viewer." });
    }
    const result = await selected.followView("qitem:example", { id: "example", opened: [], absent: [], degraded: [], pages: [],
      task: { kind: "qitem", id: "example", qitemId: "example", name: "Example", complete: true, issues: [], members: [] } }, { enabled: true }, async () => false);
    expect(result).toMatchObject({ ok: false, error: "Task membership changed before reconciliation; keeping the previous view." });
    expect(f.calls()).toEqual(Array.from({ length: 3 }, () => ({ args: ["status", "server", "--json"], home, configHome, socket: socketPath, session: null })));
  });
});
