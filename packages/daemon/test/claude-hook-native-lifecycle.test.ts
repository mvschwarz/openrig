import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("refreshes, relocates and disables native relay paths while preserving user hooks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native hook O'Brien Ω ")); roots.push(root);
  const cwd = path.join(root, "project"), home = path.join(root, "home");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true }); fs.mkdirSync(home);
  const settingsFile = path.join(cwd, ".claude", "settings.local.json");
  const userHook = { type: "command", command: "node user-hook.cjs", timeout: 11 };
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] }, custom: { keep: "Ω" } }));
  const relay = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  const manifest = path.resolve(path.dirname(relay), "../claude.json");
  const events = deriveRelayEvents({ exists: fs.existsSync, readFile: p => fs.readFileSync(p, "utf8") }, manifest);
  expect(events.length).toBeGreaterThan(0);
  const adapter = (stateDir: string) => new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, stateDir,
    activityRelayPath: relay, claudeHooksManifestPath: path.resolve(path.dirname(relay), "../claude.json"),
    fsOps: { readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p, text) => fs.writeFileSync(p, text),
      exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); }, copyFile: fs.copyFileSync, homedir: home },
  });
  const plan = (enabled: boolean) => ({ runtime: "claude-code", cwd,
    entries: enabled ? [{ category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "activity",
      classification: "safe_projection", sourceSpec: "shared", sourcePath: relay, resourcePath: "activity", absolutePath: relay }] : [],
    startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as ProjectionPlan);
  const read = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const commands = () => Object.values(read().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
    .flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command)));
  const first = adapter(path.join(root, "first state"));
  await first.project(plan(true), { cwd } as NodeBinding);
  const once = fs.readFileSync(settingsFile, "utf8");
  await first.project(plan(true), { cwd } as NodeBinding);
  expect(fs.readFileSync(settingsFile, "utf8")).toBe(once);
  const second = adapter(path.join(root, "second state"));
  await second.project(plan(true), { cwd } as NodeBinding);
  expect(commands().filter(command => command.includes("activity-relay.cjs"))).toHaveLength(events.length);
  expect(commands().some(command => command.includes("first state"))).toBe(false);
  await second.project(plan(false), { cwd } as NodeBinding);
  expect(read()).toEqual({ hooks: { Stop: [{ hooks: [userHook] }] }, custom: { keep: "Ω" } });
});
