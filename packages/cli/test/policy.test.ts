// B7 — `rig policy`, the reintroduced permission-policy verb (ruling RULING-rig-mode-rig-policy-naming).
// The honesty pin must ride every teaching surface; apply reuses the setup recording flow verbatim.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { policyCommand } from "../src/commands/policy.js";

const PIN = "OpenRig bakes NO allow/ask/deny permission policy — the harness-native permissions are the control surface.";

function runCapture(argv: string[]): Promise<{ logs: string[]; errs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exitCode;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    process.exitCode = undefined;
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(policyCommand());
    try { await prog.parseAsync(["node", "rig", ...argv]); } catch { /* commander exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
    resolve({ logs, errs, exitCode });
  });
}

describe("rig policy — the permission-policy verb", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "rig-policy-verb-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it("the verb description carries the honesty pin VERBATIM and points at rig mode", () => {
    const desc = policyCommand().description();
    expect(desc).toContain(PIN);
    expect(desc).toContain("rig mode");
  });

  it("list --json names all five choices with their ref forms and the pin", async () => {
    const { logs } = await runCapture(["policy", "list", "--json"]);
    const out = JSON.parse(logs.join("")) as { policies: Array<{ name: string; ref: string }>; note: string };
    expect(out.policies.map((p) => p.name)).toEqual(["locked", "standard", "open", "yolo", "none"]);
    expect(out.policies.find((p) => p.name === "standard")?.ref).toBe("builtin:standard");
    expect(out.policies.find((p) => p.name === "none")?.ref).toBe("none");
    expect(out.note).toContain(PIN);
  });

  it("show rejects an unknown name loudly", async () => {
    const { errs, exitCode } = await runCapture(["policy", "show", "mystery"]);
    expect(errs.join(" ")).toContain("Unknown policy 'mystery'");
    expect(exitCode).toBe(1);
  });

  it("current classifies ABSENT as the floor (honest absence)", async () => {
    const spec = path.join(dir, "rig.yaml");
    fs.writeFileSync(spec, "name: r\npods: []\n");
    const { logs } = await runCapture(["policy", "current", "--spec", spec, "--json"]);
    const out = JSON.parse(logs.join("")) as { permission_policy: unknown; classification: string };
    expect(out.permission_policy).toBeNull();
    expect(out.classification).toContain("floor");
  });

  it("apply records builtin:standard into an existing spec and current reads it back classified", async () => {
    const spec = path.join(dir, "rig.yaml");
    fs.writeFileSync(spec, "# operator comment stays\nname: r\npods: []\n");
    const applied = await runCapture(["policy", "apply", "standard", "--spec", spec, "--json"]);
    const step = JSON.parse(applied.logs.join("")) as { status: string };
    expect(step.status).toBe("applied");
    // The write is the setup flow's comment-preserving edit.
    const raw = fs.readFileSync(spec, "utf-8");
    expect(raw).toContain("permission_policy: builtin:standard");
    expect(raw).toContain("# operator comment stays");

    const current = await runCapture(["policy", "current", "--spec", spec, "--json"]);
    const out = JSON.parse(current.logs.join("")) as { permission_policy: unknown; classification: string };
    expect(out.permission_policy).toBe("builtin:standard");
    expect(out.classification).toContain("built-in template 'standard'");
  });

  it("apply refuses when no spec exists (RULING-C: a new install writes nothing) and exits 1", async () => {
    const { logs, exitCode } = await runCapture(["policy", "apply", "standard", "--spec", path.join(dir, "nope"), "--json"]);
    const step = JSON.parse(logs.join("")) as { status: string };
    expect(step.status).toBe("fail");
    expect(exitCode).toBe(1);
  });

  it("apply 'none' records the deliberate choice and current names it as chosen absence", async () => {
    const spec = path.join(dir, "rig.yaml");
    fs.writeFileSync(spec, "name: r\n");
    await runCapture(["policy", "apply", "none", "--spec", spec, "--json"]);
    expect(fs.readFileSync(spec, "utf-8")).toContain("permission_policy: none");
    const current = await runCapture(["policy", "current", "--spec", spec, "--json"]);
    const out = JSON.parse(current.logs.join("")) as { classification: string };
    expect(out.classification).toContain("deliberate none");
  });
});
