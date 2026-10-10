import { afterEach, beforeEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const hook = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "role-refocus-"));
  mkdirSync(join(root, "bin"));
  const rig = join(root, "bin/rig");
  writeFileSync(rig, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
if [ "$1 $2" = "queue whoami" ]; then printf '%s' "$ANSWER"; exit "\${ROLE_STATUS:-0}"; fi
if [ "$1 $2" = "context get" ]; then printf 'CUSTOM REF CONTENT'; exit 0; fi
exit 1
`);
  chmodSync(rig, 0o755);
  const python = join(root, "bin/python");
  writeFileSync(python, '#!/bin/sh\nprintf "TRACE OK"\nexit "${PYTHON_STATUS:-0}"\n'); chmodSync(python, 0o755);
  const role = { state: "present", recordedAt: "2026-01-01", note: "Binding record write, not verified startup or current bytes.", files: [
    { state: "present", path: "role.md", ownerRoot: "/seat/a", absolutePath: "/seat/a/role.md", resolvedPath: "/seat/a/role.md", resolvedOwnerRoot: "/seat/a" },
  ] };
  env = { PATH: join(root, "bin") + ":" + process.env.PATH, HOME: root, OPENRIG_HOME: join(root, "rig"), CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"), TMPDIR: root, OPENRIG_SESSION_NAME: "a@test", OPENRIG_REFOCUS_TREES: "both",
    OPENRIG_TOPOLOGY_ROOT: root, OPENRIG_WORKSPACE_ROOT: root, PYTHON: python, CALLS: join(root, "calls"),
    ANSWER: JSON.stringify({ currentWork: { workNodePath: "/work/a" }, role }) };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(runtime: string, event: string, overrides: NodeJS.ProcessEnv = {}, preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ["--require", preload] : []), hook, "--runtime", runtime], {
    input: JSON.stringify({ hook_event_name: event, session_id: "test-occupant" }), env: { ...env, ...overrides }, encoding: "utf8", timeout: 5000,
  });
}
const context = (r: ReturnType<typeof run>) => { expect(r.status, r.stderr || String(r.error)).toBe(0); return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string; };
const calls = () => existsSync(env.CALLS!) ? readFileSync(env.CALLS!, "utf8").trim().split("\n") : [];
it.each(["claude", "codex"])("%s carries only A's role after PostCompact and reuses the work response", (runtime) => {
  expect(run(runtime, "PostCompact").stdout).toBe("");
  const text = context(run(runtime, "UserPromptSubmit"));
  expect(text).toContain("Your seat's role file:"); expect(text).toContain("/seat/a/role.md");
  expect(text).toContain("Re-read it if your role is unclear"); expect(text).not.toContain("/seat/b");
  expect(calls().filter(x => x === "queue whoami --json")).toHaveLength(1);
  expect(run(runtime, "UserPromptSubmit").stdout).toBe("");
});
it.each(["claude", "codex"])("%s obtains role once with explicit work override even when Python fails", (runtime) => {
  const text = context(run(runtime, "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_WORK_NODE: "/explicit", PYTHON_STATUS: "1" }));
  expect(text).toContain("TRACE GAP"); expect(text).toContain("/seat/a/role.md");
  expect(calls()).toEqual(["queue whoami --json"]);
});
it("keeps role independent of configured content, including context refs", () => {
  const text = context(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_CONTENT_REF: "custom/ref" }));
  expect(text).toContain("CUSTOM REF CONTENT"); expect(text).toContain("/seat/a/role.md");
  expect(calls()).toEqual(["queue whoami --json", "context get custom/ref"]);
});
it.each([{ ROLE_STATUS: "1" }, { ANSWER: "broken" }, { ANSWER: "{}" }])("reports failed/unavailable role lookup honestly %j", (overrides) => {
  const text = context(run("codex", "UserPromptSubmit", { ...overrides, OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_WORK_NODE: "/explicit" }));
  expect(text).toContain("Role file: unknown"); expect(text).not.toContain("Role file: missing");
  expect(calls()).toEqual(["queue whoami --json"]);
});
it("skips role lookup when no bounded time remains and still emits an unknown", () => {
  const preload = join(root, "clock.cjs"); writeFileSync(preload, "process.uptime = () => 2.4;");
  const text = context(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_WORK_NODE: "/explicit" }, preload));
  expect(text).toContain("Role file: unknown (no budget left)");
  expect(calls()).toEqual([]);
});
it("honors work-only and disabled hooks without extra role lookups", () => {
  const text = context(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_WORK_NODE: "/explicit", OPENRIG_REFOCUS_TREES: "work" }));
  expect(text).not.toContain("Role file:"); expect(text).not.toContain("Your seat's role file:");
  expect(calls()).toEqual([]);
  expect(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_ENABLED: "false" }).stdout).toBe("");
  expect(calls()).toEqual([]);
});
it("shows multiple marked entries and distinguishes absence from malformed answers", () => {
  const answer = JSON.parse(env.ANSWER!);
  answer.role.files.push({ ...answer.role.files[0], state: "missing", resolvedPath: "/seat/a/second.md" }); answer.role.state = "missing";
  const text = context(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", ANSWER: JSON.stringify(answer) }));
  expect(text).toContain("/seat/a/role.md"); expect(text).toContain("/seat/a/second.md"); expect(text).toContain("missing");
});


it("includes role in topology-only mode without inventing a current work node", () => {
  const answer = JSON.parse(env.ANSWER!); answer.currentWork = null; answer.currentWorkBasis = "no typed work";
  const text = context(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_TREES: "topology", ANSWER: JSON.stringify(answer) }));
  expect(text).toContain("/seat/a/role.md"); expect(calls()).toEqual(["queue whoami --json"]);
});
it.each(["no-record", "not-declared"])("renders an explicit %s without guessing a filename", state => {
  const text = context(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", ANSWER: JSON.stringify({ role: { state, files: [] } }) }));
  expect(text).toContain(`Role file: ${state}`); expect(text).not.toContain("Re-read it");
});
it("keeps malformed role information unknown, rather than missing", () => {
  const text = context(run("codex", "UserPromptSubmit", { OPENRIG_REFOCUS_NOW: "1", ANSWER: JSON.stringify({ role: { state: "present", files: [null] } }) }));
  expect(text).toContain("Role file: unknown (malformed role information)");
});
