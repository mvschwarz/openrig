import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each(["-fd", "-fdx"])("keeps the configured real relay working after project git clean %s", async (flag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-relay-clean-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const stateDir = path.join(root, "instance O'Brien");
  const settingsPath = path.join(cwd, ".claude/settings.local.json");
  fs.mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  git("init", "-q");
  const asset = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  const adapter = new ClaudeCodeAdapter({
    tmux: {} as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"], stateDir,
    activityRelayPath: asset,
    claudeHooksManifestPath: path.resolve(path.dirname(asset), "../claude.json"),
    fsOps: {
      exists: fs.existsSync, readFile: p => fs.readFileSync(p, "utf8"),
      writeFile: (p, text) => fs.writeFileSync(p, text),
      mkdirp: p => { fs.mkdirSync(p, { recursive: true }); },
      copyFile: fs.copyFileSync, statMode: p => fs.statSync(p).mode, chmod: fs.chmodSync,
    },
  });
  const projection = await adapter.project({
    runtime: "claude-code", cwd, entries: [{
      category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "activity",
      classification: "safe_projection", sourceSpec: "shared", sourcePath: asset,
      resourcePath: "activity", absolutePath: asset,
    }], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
  } as ProjectionPlan, { cwd } as NodeBinding);
  expect(projection.projected).toContain("activity");
  const settings = fs.readFileSync(settingsPath, "utf8");
  const command = JSON.parse(settings).hooks.Stop[0].hooks[0].command as string;
  // The contract is a still-configured hook. Explicitly protect settings, rather than
  // assuming Claude automatically ignores them or claiming to test its settings cache.
  if (flag === "-fd") {
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".claude/settings.local.json\n");
    git("add", ".gitignore");
  } else {
    git("add", ".claude/settings.local.json");
  }
  fs.writeFileSync(path.join(cwd, "cleanup-marker"), "remove me");

  const received: Array<{ url?: string; auth?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data) });
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const runHook = () => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    // Only this fixture receiver is reachable from the relay; no inherited daemon identity.
    const child = spawn("/bin/sh", ["-c", command], {
      cwd, env: {
        PATH: process.env.PATH, HOME: root, OPENRIG_HOME: stateDir,
        OPENRIG_URL: `http://127.0.0.1:${address.port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-token",
        OPENRIG_NODE_ID: "fixture-node", OPENRIG_SESSION_NAME: "fixture-seat",
        OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "fixture-generation",
      }, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop" }));
  });
  try {
    expect(await runHook()).toEqual({ code: 0, stderr: "" });
    expect(received).toHaveLength(1);
    git("clean", flag);
    expect(fs.existsSync(path.join(cwd, "cleanup-marker"))).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(settings);
    // No re-projection between cleanup and invocation of the original configured command.
    expect(await runHook()).toEqual({ code: 0, stderr: "" });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      url: "/api/activity/hooks", auth: "Bearer fixture-token",
      body: { nodeId: "fixture-node", sessionName: "fixture-seat", runtime: "claude-code", hookEvent: "Stop" },
    });
    const relay = path.join(stateDir, "state/claude-activity-hooks/activity-relay.cjs");
    expect(fs.readFileSync(relay)).toEqual(fs.readFileSync(asset));
    expect(fs.statSync(relay).mode & 0o777).toBe(0o755);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
