import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { buildOmpLaunchCommand, ompSeatPaths } from "../src/adapters/omp-seat-protocol.js";
const roots: string[] = [];
function writeOmpFixture(executable: string, script: string) {
  const entry = executable + ".cjs";
  const node = executable + " node";
  symlinkSync(process.execPath, node);
  writeFileSync(entry, script);
  writeFileSync(executable, ["#!/bin/sh", "exec " + shellQuote(node) + " " + shellQuote(entry) + ' "$@"', ""].join("\n"), { mode: 0o700 });
}
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
it.skipIf(process.platform === "win32")("executes the native command with literal paths and only the permitted environment", () => {
  const root = mkdtempSync(join(tmpdir(), "omp shell 'fixture-")); roots.push(root);
  const executable = join(root, "omp"), output = join(root, "observed.json");
  writeOmpFixture(executable, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2),env:process.env}));`);
  const paths = ompSeatPaths(root, "seat"); mkdirSync(paths.seatRoot, { recursive: true });
  const command = buildOmpLaunchCommand({ ompCommand: executable, paths, cwd: root, launchId: "attempt", seatExtensionPath: join(root, "extension.js"),
    model: "anthropic/fixture", approvalMode: "always-ask", thinking: "high", sessionFile: join(root, "old session.jsonl") });
  execFileSync("/bin/sh", ["-c", command], { stdio: "inherit", env: { PATH: process.env.PATH, HOME: "/unrelated", OPENRIG_SESSION_NAME: "seat", ANTHROPIC_API_KEY: "fixture-key", OPENAI_API_KEY: "other-key", OPENRIG_ACTIVITY_HOOK_TOKEN: "private-hook", OPENRIG_REFOCUS_ENABLED: "0", OPENRIG_REFOCUS_CONTENT_FILE: "/fixture/context with spaces.md", UNRELATED_SECRET: "private" } });
  const got = JSON.parse(readFileSync(output, "utf8"));
  expect(got.args).toEqual(["--cwd", root, "--session-dir", paths.sessionsDir, "--approval-mode", "always-ask", "--config", paths.launchConfigPath, "-e", join(root, "extension.js"), "--model", "anthropic/fixture", "--thinking", "high", "--session", join(root, "old session.jsonl")]);
  expect(got.env).toMatchObject({ HOME: paths.seatRoot, PI_CODING_AGENT_DIR: paths.agentDir, OPENRIG_SESSION_NAME: "seat", ANTHROPIC_API_KEY: "fixture-key", OPENRIG_OMP_LAUNCH_ID: "attempt", OPENRIG_REFOCUS_ENABLED: "0", OPENRIG_REFOCUS_CONTENT_FILE: "/fixture/context with spaces.md" });
  for (const key of ["OPENAI_API_KEY", "OPENRIG_ACTIVITY_HOOK_TOKEN", "UNRELATED_SECRET"]) expect(got.env).not.toHaveProperty(key);
});

it.skipIf(!existsSync("/bin/zsh"))("bypasses an interactive omp shell function with the resolved binary", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-function-")); roots.push(root);
  const executable = join(root, "omp"), output = join(root, "started");
  writeOmpFixture(executable, `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'native');`);
  const command = buildOmpLaunchCommand({ ompCommand: executable, paths: ompSeatPaths(root, "seat"),
    cwd: root, launchId: "attempt", seatExtensionPath: join(root, "extension.js"), approvalMode: "yolo" });
  execFileSync("/bin/zsh", ["-f", "-c", `omp() { print 'omp -> [w]rap / [n]ormal / [q]uit?'; return 93; }; ${command}`],
    { stdio: "inherit", env: { PATH: process.env.PATH, HOME: root } });
  expect(readFileSync(output, "utf8")).toBe("native");
});
