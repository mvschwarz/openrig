import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { stageCodexActivityRelay } from "../src/adapters/codex-activity-relay.js";
import { CodexRuntimeAdapter, computeCodexHookTrust } from "../src/adapters/codex-runtime-adapter.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const shipped = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stable-relay-"));
  roots.push(root);
  const source = (name: string) => {
    const dir = path.join(root, name, "assets/plugins/openrig-core/hooks/scripts");
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ["activity-relay.cjs", "permission-stop-descriptor.cjs"]) fs.copyFileSync(path.join(shipped, file), path.join(dir, file));
    return dir;
  };
  const first = source("node-v1");
  const second = source("node-v2");
  const stateDir = path.join(root, "openrig-state");
  const home = path.join(root, "codex-home");
  fs.mkdirSync(home);
  const writes: string[] = [];
  const adapter = (relay: string) => new CodexRuntimeAdapter({
    activityRelayPath: relay, codexHome: home, tmux: new TmuxAdapter(async () => ""),
    fsOps: {
      readFile: p => fs.readFileSync(p, "utf8"),
      writeFile: (p, content) => { writes.push(p); fs.writeFileSync(p, content); },
      exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); }, homedir: root,
    },
  });
  return { root, first, second, stateDir, home, writes, adapter };
}

describe("Codex activity relay across Node installation moves", () => {
  it.each(["inline", "json"])("keeps %s hooks, trust and choices byte-identical after the old install disappears", format => {
    const f = fixture();
    const config = path.join(f.home, "config.toml");
    const hooks = path.join(f.home, "hooks.json");
    fs.writeFileSync(config, 'model = "keep-my-model"\n');
    if (format === "json") fs.writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] } }));
    // Start from the previously shipped install-bound command and a native disable choice.
    f.adapter(path.join(f.first, "activity-relay.cjs")).ensureCodexActivityHooks();
    const { key } = computeCodexHookTrust("Stop", {
      keySource: format === "json" ? hooks : config, command: `node "${path.join(f.first, "activity-relay.cjs")}"`,
      timeoutSec: 5, groupIndex: format === "json" ? 1 : 0,
    });
    const header = `[hooks.state.${JSON.stringify(key)}]`;
    const original = fs.readFileSync(config, "utf8");
    expect(original).toContain(header);
    fs.writeFileSync(config, original.replace(header, `${header}\nenabled = false`));

    const firstRelay = stageCodexActivityRelay({ stateDir: f.stateDir, sourceDir: f.first });
    f.adapter(firstRelay).ensureCodexActivityHooks();
    const beforeConfig = fs.readFileSync(config, "utf8");
    const beforeHooks = format === "json" ? fs.readFileSync(hooks, "utf8") : undefined;
    const beforeAsset = fs.statSync(firstRelay);
    expect(beforeConfig).toContain('model = "keep-my-model"');
    expect(beforeConfig).toContain("enabled = false");
    f.writes.length = 0;
    fs.rmSync(path.join(f.root, "node-v1"), { recursive: true });

    const secondRelay = stageCodexActivityRelay({ stateDir: f.stateDir, sourceDir: f.second });
    f.adapter(secondRelay).ensureCodexActivityHooks();
    expect(secondRelay).toBe(firstRelay);
    expect(fs.readFileSync(config, "utf8")).toBe(beforeConfig);
    if (format === "json") expect(fs.readFileSync(hooks, "utf8")).toBe(beforeHooks);
    expect(f.writes).toEqual([]);
    expect(fs.statSync(secondRelay).mtimeMs).toBe(beforeAsset.mtimeMs);
    expect(fs.readFileSync(secondRelay)).toEqual(fs.readFileSync(path.join(f.second, "activity-relay.cjs")));
    f.adapter(secondRelay).removeCodexActivityHooks();
    expect(fs.readFileSync(config, "utf8")).toContain('model = "keep-my-model"');
    expect(fs.readFileSync(config, "utf8")).not.toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    if (format === "json") expect(fs.readFileSync(hooks, "utf8")).toContain("echo user-hook");
  });

  it("refreshes the selected daemon bytes while keeping the relay entry point", () => {
    const f = fixture();
    const first = stageCodexActivityRelay({ stateDir: f.stateDir, sourceDir: f.first });
    fs.appendFileSync(path.join(f.second, "activity-relay.cjs"), "\n// newer daemon relay\n");
    const next = stageCodexActivityRelay({ stateDir: f.stateDir, sourceDir: f.second });
    expect(next).toBe(first);
    expect(fs.readFileSync(next, "utf8")).toContain("// newer daemon relay");
  });

  it("leaves the prior entry point intact when a required shipped asset is missing", () => {
    const f = fixture();
    const first = stageCodexActivityRelay({ stateDir: f.stateDir, sourceDir: f.first });
    const before = fs.readFileSync(first);
    fs.unlinkSync(path.join(f.second, "permission-stop-descriptor.cjs"));
    expect(() => stageCodexActivityRelay({ stateDir: f.stateDir, sourceDir: f.second })).toThrow();
    expect(fs.readFileSync(first)).toEqual(before);
  });

  it("runs the staged real relay after removing the original installation", async () => {
    const f = fixture();
    const relay = stageCodexActivityRelay({ stateDir: f.stateDir, sourceDir: f.first });
    fs.rmSync(path.join(f.root, "node-v1"), { recursive: true });
    const received: string[] = [];
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push(body);
      res.writeHead(204).end();
    });
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("fixture receiver has no TCP port");
      const child = spawn(process.execPath, [relay], {
        env: { PATH: path.dirname(process.execPath), HOME: f.root, OPENRIG_HOME: f.stateDir,
          OPENRIG_URL: `http://127.0.0.1:${address.port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-token",
          OPENRIG_SESSION_NAME: "worker@fixture", OPENRIG_NODE_ID: "node-fixture", OPENRIG_RUNTIME: "codex" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.stdin.on("error", () => {}); // A missing relay can exit before it reads the payload.
        const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        child.stdin.end(JSON.stringify({ hook_event_name: "Stop" }));
        expect(await exited).toBe(0);
        expect(stderr).toBe("");
        expect(received).toHaveLength(1);
        expect(JSON.parse(received[0] ?? "null")).toMatchObject({ runtime: "codex", nodeId: "node-fixture", hookEvent: "Stop" });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close(err => err ? reject(err) : resolve()); });
    }
  });
});
