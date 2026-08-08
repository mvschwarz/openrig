import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

// 0.5.2-07 A2-3 — the ENUMERATION GUARD (anti-increment fence).
//
// The bug this slice kills is reasoning from the increment: OPR.0.4.6.PI1 fixed the model-drop at ONE
// restore site, 51-07 A1 threaded -m/--model on the FRESH branches only, and both left the sibling
// launch branches (codex fork/resume) silently reverting a spec-pinned seat to the runtime default.
// This guard pins the CLASS: every seat-launch command template threads the SPEC model, and the one
// command builder that is NOT a seat launch (buildNativeResumeCommand — metadata/inventory display)
// is enumerated as such. A NEW launch branch that drops the model fails HERE, loudly.

const SRC = nodePath.resolve(fileURLToPath(import.meta.url), "../../src");
const read = (rel: string): string => readFileSync(nodePath.join(SRC, rel), "utf-8");

function allSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSrcFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("0.5.2-07 A2-3 — model-fidelity enumeration guard", () => {
  it("codex adapter: fresh + fork command templates thread modelArg", () => {
    const src = read("adapters/codex-runtime-adapter.ts");
    const templates = [...src.matchAll(/`codex\$\{[^`]*`/g)].map((m) => m[0]);
    const seatLaunches = templates.filter((t) => / fork| -C /.test(t));
    // fresh (-C) + fork are the two inline templates; resume goes via buildCodexResumeCore (below).
    expect(seatLaunches.length).toBeGreaterThanOrEqual(2);
    for (const t of seatLaunches) {
      expect(t, `codex seat-launch template must thread modelArg:\n${t}`).toContain("modelArg");
    }
  });

  it("codex adapter: the resume branch passes the model into buildCodexResumeCore", () => {
    const src = read("adapters/codex-runtime-adapter.ts");
    // The LAUNCH resume call threads binding.launchPosture, model, then the exact precomputed
    // posture segment. The latter prevents W3 observation from re-deciding policy.
    expect(src).toMatch(/buildCodexResumeCore\([^;]*binding\.launchPosture,\s*model,\s*postureArg\)/);
  });

  it("claude adapter: every claude seat-launch template threads modelArg", () => {
    const src = read("adapters/claude-code-adapter.ts");
    const templates = [...src.matchAll(/`claude \$\{[^`]*`/g)].map((m) => m[0]);
    const seatLaunches = templates.filter((t) => /--resume|--session-id|--fork-session/.test(t));
    // fresh (--session-id), resume (--resume … --name), fork (--resume … --fork-session).
    expect(seatLaunches.length).toBeGreaterThanOrEqual(3);
    for (const t of seatLaunches) {
      expect(t, `claude seat-launch template must thread modelArg:\n${t}`).toContain("modelArg");
    }
  });

  it("legacy resume builders (claude-resume + codex-resume) thread the model", () => {
    const claudeResume = read("adapters/claude-resume.ts");
    expect(claudeResume).toMatch(/const modelArg = model \?/);
    expect(claudeResume).toMatch(/\$\{modelArg\}.*--resume/);
    const codexResume = read("adapters/codex-resume.ts");
    // codex-resume threads `model` into buildCodexResumeCore's model param.
    expect(codexResume).toMatch(/buildCodexResumeCore\([\s\S]*?\n\s*model,\n/);
  });

  it("shared buildCodexResumeCore accepts a model param and emits -m before the resume subcommand", () => {
    const src = read("domain/native-resume-probe.ts");
    expect(src).toMatch(/model\?: string \| null,\n\s*\/\*\*[^]*?\*\/\n\s*precomputedPostureArg\?: string,\n\): string/);
    expect(src).toMatch(/const modelArg = model \? ` -m \$\{shellQuote\(model\)\}`/);
    expect(src).toContain("`codex${profileOrPosture}${modelArg} resume ");
  });

  it("buildNativeResumeCommand is classified NOT-A-SEAT-LAUNCH: every caller is metadata/inventory, none is a launch module", () => {
    const LAUNCH_MODULES = new Set([
      "codex-runtime-adapter.ts",
      "claude-code-adapter.ts",
      "pi-runner-protocol.ts",
      "successor-session-launcher.ts",
      "restore-orchestrator.ts",
      "startup-orchestrator.ts",
      "claude-resume.ts",
      "codex-resume.ts",
    ]);
    // Enumerate every file that references buildNativeResumeCommand, excluding its own definition file.
    const callers = allSrcFiles(SRC)
      .filter((f) => nodePath.basename(f) !== "native-resume-probe.ts")
      .filter((f) => readFileSync(f, "utf-8").includes("buildNativeResumeCommand"))
      .map((f) => nodePath.basename(f));
    // It is a display/metadata builder — no live-pane launch module may call it. If a launch module
    // starts calling it, this fence fails and buildNativeResumeCommand must then thread the model.
    const launchCallers = callers.filter((c) => LAUNCH_MODULES.has(c));
    expect(launchCallers, `buildNativeResumeCommand must not be called from a seat-launch module: ${launchCallers}`).toEqual([]);
    // And it IS still used by the metadata/inventory surface (classification is live, not dead).
    expect(callers.sort()).toEqual(["node-inventory.ts", "resume-metadata-refresher.ts"]);
  });
});
