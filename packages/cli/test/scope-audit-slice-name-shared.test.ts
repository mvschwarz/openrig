// The CLI twin of the daemon's slice_name_shared advisory: two missions with a slice folder of the same
// name leave one of them out of the slice list and the routes that find a slice by name. Advisory only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { scopeCommand } from "../src/commands/scope.js";

let workspace: string;
let missionsRoot: string;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-slice-name-audit-"));
  missionsRoot = path.join(workspace, "missions");
  for (const mission of ["alpha", "beta"]) {
    fs.mkdirSync(path.join(missionsRoot, mission, "slices", "01-login"), { recursive: true });
    fs.writeFileSync(path.join(missionsRoot, mission, "SPEC.md"), "# mission\n");
    fs.writeFileSync(path.join(missionsRoot, mission, "slices", "01-login", "SPEC.md"), "# login\n");
  }
});
afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

async function audit(mission: string): Promise<{ slices: Array<{ name: string; findings: Array<{ kind: string; severity: string; message: string }> }> }> {
  const buf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: unknown) => { buf.push(String(c)); return true; }) as typeof process.stdout.write;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", "audit", "--mission", mission, "--json", "--workspace", workspace]);
  } finally {
    process.stdout.write = origWrite;
  }
  return JSON.parse(buf.join(""));
}

describe("rig scope audit — a slice name another mission also uses", () => {
  it("names the other mission, as advice that blocks nothing", async () => {
    const shared = (await audit("alpha")).slices.find((s) => s.name === "01-login")!.findings.find((f) => f.kind === "slice_name_shared");
    expect(shared).toMatchObject({ severity: "low", message: expect.stringContaining("beta") });
  });
});
