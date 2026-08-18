// The CLI twin of the daemon's shadowed_node_file advisory.
//
// The daemon cannot import packages/cli, so scope audit exists twice. A finding that lands on only
// one twin means an operator sees a different truth depending on which surface they asked — which
// is the same class of defect as the two-naming-systems problem this whole slice is about.
//
// Advisory by construction: low severity, and it must never flip the audit's exit code.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { scopeCommand } from "../src/commands/scope.js";

let workspace: string;
let missionsRoot: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-shadow-audit-"));
  missionsRoot = path.join(workspace, "missions");
  fs.mkdirSync(missionsRoot, { recursive: true });
});
afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

async function audit(mission: string): Promise<{ stdout: string; exitCode: number }> {
  const buf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((c: unknown) => { buf.push(String(c)); return true; }) as typeof process.stdout.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", "audit", "--mission", mission, "--json", "--workspace", workspace]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.startsWith("__EXIT__")) buf.push(msg);
  } finally {
    process.stdout.write = origWrite;
    process.exit = origExit;
  }
  return { stdout: buf.join(""), exitCode };
}

function node(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c, "utf8");
}

describe("rig scope audit — shadowed node file advisory (CLI twin)", () => {
  it("advises on a mission and a slice that each carry both SPEC.md and README.md", async () => {
    const missionDir = path.join(missionsRoot, "both-mission");
    node(missionDir, {
      "SPEC.md": "---\nid: OPR.99.0.2\n---\n# live\n",
      "README.md": "---\nid: OPR.99.0.2\n---\n# stale\n",
      "PROGRESS.md": "# Progress\n",
    });
    node(path.join(missionDir, "slices", "01-both"), {
      "SPEC.md": "---\nid: OPR.99.0.2.1\n---\n# live\n",
      "README.md": "---\nid: OPR.99.0.2.1\n---\n# stale\n",
      "PROGRESS.md": "# Progress\n",
    });

    const { stdout } = await audit("both-mission");
    const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
      ok: boolean;
      mission: { findings: Array<{ kind: string; severity: string; message: string }> };
      slices: Array<{ name: string; findings: Array<{ kind: string; severity: string; message: string }> }>;
    };

    const m = report.mission.findings.find((f) => f.kind === "shadowed_node_file");
    const sl = report.slices.find((x) => x.name === "01-both")!.findings.find((f) => f.kind === "shadowed_node_file");
    expect(m, "mission advisory").toBeDefined();
    expect(sl, "slice advisory").toBeDefined();
    for (const f of [m!, sl!]) {
      expect(f.severity).toBe("low");
      // It must say which file wins, or the operator cannot act on it.
      expect(f.message).toContain("SPEC.md");
    }
    // ADVISORY MEANS ADVISORY: low severity never flips ok, so it can never gate a build.
    expect(report.ok).toBe(true);
  });

  it("says nothing when a node has only one authored file", async () => {
    node(path.join(missionsRoot, "single-mission"), {
      "SPEC.md": "---\nid: OPR.99.0.3\n---\n# only\n",
      "PROGRESS.md": "# Progress\n",
    });
    const { stdout } = await audit("single-mission");
    expect(stdout).not.toContain("shadowed_node_file");
  });
});
