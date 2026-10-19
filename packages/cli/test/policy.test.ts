// B7 — `rig policy`, the reintroduced permission-policy verb (ruling RULING-rig-mode-rig-policy-naming).
// The honesty pin must ride every teaching surface; apply reuses the setup recording flow verbatim.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { policyCommand } from "../src/commands/policy.js";
import type { StatusDeps } from "../src/commands/status.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

const PIN = "The team and kernel launch defaults pass allow/ask lists per launch and save none; a selected Claude settings fragment can merge native settings, rules included; the harness-native permissions are the control surface.";

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

  it("list --json names all six choices with their ref forms and the pin", async () => {
    const { logs } = await runCapture(["policy", "list", "--json"]);
    const out = JSON.parse(logs.join("")) as { policies: Array<{ name: string; ref: string }>; note: string };
    expect(out.policies.map((p) => p.name)).toEqual(["locked", "standard", "open", "yolo", "auto", "none"]);
    expect(out.policies.find((p) => p.name === "standard")?.ref).toBe("builtin:standard");
    expect(out.policies.find((p) => p.name === "auto")?.ref).toBe("builtin:auto");
    expect(out.policies.find((p) => p.name === "none")?.ref).toBe("none");
    expect(out.note).toContain(PIN);
  });

  it("show auto displays auto with its real posture", async () => {
    const { logs } = await runCapture(["policy", "show", "auto", "--json"]);
    const out = JSON.parse(logs.join("")) as { name: string; ref: string; launchPosture: string };
    expect(out.name).toBe("auto");
    expect(out.ref).toBe("builtin:auto");
    expect(out.launchPosture).toBe("auto");
  });

  it("show on an unknown bare name treats it as a custom ref and refuses loudly when it does not resolve", async () => {
    const { errs, exitCode } = await runCapture(["policy", "show", "mystery"]);
    expect(errs.join(" ")).toContain("Custom policy 'mystery' does not resolve");
    expect(exitCode).toBe(1);
  });

  it("show rejects a bare BUILT-IN name used as a custom ref with the anti-shadowing teaching", async () => {
    const { errs, exitCode } = await runCapture(["policy", "show", "builtin:mystery"]);
    expect(errs.join(" ")).toContain("unknown built-in policy 'mystery'");
    expect(exitCode).toBe(1);
  });

  it("current classifies ABSENT as the team launch default (nothing recorded)", async () => {
    const spec = path.join(dir, "rig.yaml");
    fs.writeFileSync(spec, "name: r\npods: []\n");
    const { logs } = await runCapture(["policy", "current", "--spec", spec, "--json"]);
    const out = JSON.parse(logs.join("")) as { sites: Array<{ effective: unknown; applies?: string }> };
    expect(out.sites[0]!.effective).toBeNull();
    expect(String(out.sites[0]!.applies)).toContain("team launch default");
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
    const out = JSON.parse(current.logs.join("")) as { sites: Array<{ effective: unknown; applies?: string }> };
    expect(out.sites[0]!.effective).toBe("builtin:standard");
    expect(String(out.sites[0]!.applies)).toContain("origin=builtin");
  });

  it("apply refuses when no spec exists (RULING-C: a new install writes nothing) and exits 1", async () => {
    const { logs, exitCode } = await runCapture(["policy", "apply", "standard", "--spec", path.join(dir, "nope"), "--json"]);
    const step = JSON.parse(logs.join("")) as { status: string };
    expect(step.status).toBe("fail");
    expect(exitCode).toBe(1);
  });

  const VALID_FLAG_POLICY = `---
policy_schema_version: 1
name: door-bypass
source: custom
description: full-bypass door fixture
surface: flag
launch_posture: full_bypass
---
body
`;

  it("r2 HIGH-1: list --spec discovers CUSTOM policies referenced by the spec set, resolved + posture-visible", async () => {
    fs.mkdirSync(path.join(dir, "policies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "policies", "custom.policy.md"), VALID_FLAG_POLICY);
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: policies/custom.policy.md\npods:\n  - id: dev\n    members:\n      - id: qa\n        permission_policy: builtin:locked\n");
    const { logs, exitCode } = await runCapture(["policy", "list", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    const out = JSON.parse(logs.join("")) as { custom: Array<Record<string, unknown>> };
    expect(exitCode).toBeUndefined();
    expect(out.custom).toHaveLength(1); // builtin member ref is not a custom policy
    expect(out.custom[0]).toMatchObject({
      site: "rig",
      ref: "policies/custom.policy.md",
      surface: "flag",
      launchPosture: "full_bypass",
      contentResolved: true,
    });
  });

  it("r2 HIGH-1: show opens + validates a CUSTOM policy ref anchored at --spec", async () => {
    fs.mkdirSync(path.join(dir, "policies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "policies", "custom.policy.md"), VALID_FLAG_POLICY);
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\n");
    const { logs, exitCode } = await runCapture(["policy", "show", "policies/custom.policy.md", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    expect(exitCode).toBeUndefined();
    const out = JSON.parse(logs.join("")) as Record<string, unknown>;
    expect(out).toMatchObject({ origin: "custom", surface: "flag", launchPosture: "full_bypass", contentResolved: true, contractValid: true });
  });

  it("r2 HIGH-1: show on a MISSING custom ref refuses loudly naming the resolved path and the advisory floor", async () => {
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\n");
    const { errs, exitCode } = await runCapture(["policy", "show", "policies/nope.policy.md", "--spec", path.join(dir, "rig.yaml")]);
    expect(exitCode).toBe(1);
    expect(errs.join(" ")).toContain("does not resolve");
    expect(errs.join(" ")).toContain("FLOOR");
  });

  it("r2 HIGH-2: current REFUSES a traversal ref with the AUTHORITATIVE error (exit 1, never blessed as custom)", async () => {
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: ../escape.policy.md\n");
    const { logs, exitCode } = await runCapture(["policy", "current", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    expect(exitCode).toBe(1);
    const out = JSON.parse(logs.join("")) as { sites: Array<Record<string, unknown>> };
    expect(String(out.sites[0]!.invalid)).toContain("path traversal (..) is not allowed");
  });

  it("r2 HIGH-2: current on a VALID full-bypass custom shows WHAT WOULD APPLY (target, surface, posture, content-resolution)", async () => {
    fs.mkdirSync(path.join(dir, "policies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "policies", "custom.policy.md"), VALID_FLAG_POLICY);
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: policies/custom.policy.md\n");
    const { logs, exitCode } = await runCapture(["policy", "current", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    expect(exitCode).toBeUndefined();
    const out = JSON.parse(logs.join("")) as { sites: Array<{ attachment?: Record<string, unknown>; applies?: string }> };
    const rig = out.sites[0]!;
    expect(rig.attachment).toMatchObject({ origin: "custom", surface: "flag", launchPosture: "full_bypass", contentResolved: true });
    expect(String(rig.attachment!.resolvedTarget)).toContain("custom.policy.md");
  });

  it("r2 HIGH-2: current on a MISSING custom file SURFACES the advisory-floor result (visible, exit 0 — unresolved is not a defect)", async () => {
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: policies/ghost.policy.md\n");
    const { logs, exitCode } = await runCapture(["policy", "current", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    expect(exitCode).toBeUndefined();
    const out = JSON.parse(logs.join("")) as { sites: Array<{ applies?: string; attachment?: Record<string, unknown> }> };
    expect(out.sites[0]!.attachment).toMatchObject({ contentResolved: false, launchPosture: "floor" });
    expect(String(out.sites[0]!.applies)).toContain("advisory FLOOR");
  });

  it("r2 round 3: a PRESENT non-string rig value is INVALID (exit 1), never reported as absent/floor", async () => {
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: 42\n");
    const { logs, exitCode } = await runCapture(["policy", "current", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    expect(exitCode).toBe(1);
    const out = JSON.parse(logs.join("")) as { sites: Array<Record<string, unknown>> };
    expect(String(out.sites[0]!.invalid)).toContain("must be a non-empty string ref");
  });

  it("r2 round 3: a PRESENT non-string member value surfaces as ITS OWN site defect, never silently omitted", async () => {
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: builtin:standard\npods:\n  - id: dev\n    members:\n      - id: qa\n        permission_policy: { nested: true }\n");
    const { logs, exitCode } = await runCapture(["policy", "current", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    expect(exitCode).toBe(1);
    const out = JSON.parse(logs.join("")) as { sites: Array<Record<string, unknown>> };
    expect(out.sites).toHaveLength(2);
    expect(String(out.sites[1]!.site)).toContain("dev.qa");
    expect(String(out.sites[1]!.invalid)).toContain("must be a non-empty string ref");
  });

  it("r2 round 3: list --spec surfaces a present non-string as INVALID in the custom set", async () => {
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: 42\n");
    const { logs } = await runCapture(["policy", "list", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    const out = JSON.parse(logs.join("")) as { custom: Array<Record<string, unknown>> };
    expect(out.custom).toHaveLength(1);
    expect(String(out.custom[0]!.invalid)).toContain("must be a non-empty string ref");
  });

  it("current reports member-level overrides per site (member > rig)", async () => {
    fs.writeFileSync(path.join(dir, "rig.yaml"), "name: r\npermission_policy: builtin:standard\npods:\n  - id: dev\n    members:\n      - id: qa\n        permission_policy: builtin:yolo\n");
    const { logs } = await runCapture(["policy", "current", "--spec", path.join(dir, "rig.yaml"), "--json"]);
    const out = JSON.parse(logs.join("")) as { sites: Array<Record<string, unknown>> };
    expect(out.sites).toHaveLength(2);
    expect(String(out.sites[1]!.site)).toContain("dev.qa");
    expect((out.sites[1]!.attachment as Record<string, unknown>).launchPosture).toBe("full_bypass");
  });

  it("apply 'none' records the deliberate choice and current names it as chosen absence", async () => {
    const spec = path.join(dir, "rig.yaml");
    fs.writeFileSync(spec, "name: r\n");
    await runCapture(["policy", "apply", "none", "--spec", spec, "--json"]);
    expect(fs.readFileSync(spec, "utf-8")).toContain("permission_policy: none");
    const current = await runCapture(["policy", "current", "--spec", spec, "--json"]);
    const out = JSON.parse(current.logs.join("")) as { sites: Array<{ applies?: string }> };
    expect(String(out.sites[0]!.applies)).toContain("origin=deliberate_none");
  });
});

describe("rig policy apply --seat — an existing seat's stored policy", () => {
  function seatDeps(response: { status: number; data: Record<string, unknown> }) {
    const posts: unknown[][] = [];
    const deps = {
      lifecycleDeps: {
        readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "inert.sqlite", startedAt: "2026-10-14T00:00:00Z" }) : null,
        exists: (p: string) => p === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
      },
      clientFactory: () => ({ post: async (...a: unknown[]) => { posts.push(a); return response; } }),
    };
    // Stub daemon state and client: only post() is exercised, so the full DaemonClient shape is not built.
    return { deps: deps as unknown as StatusDeps, posts };
  }

  async function run(deps: StatusDeps, argv: string[]) {
    const logs: string[] = []; const errs: string[] = []; const saved = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    const err = vi.spyOn(console, "error").mockImplementation((...a) => { errs.push(a.join(" ")); });
    process.exitCode = undefined;
    try {
      await new Command().exitOverride().addCommand(policyCommand(deps)).parseAsync(["node", "rig", ...argv]);
      return { logs, errs, exitCode: process.exitCode };
    } finally { log.mockRestore(); err.mockRestore(); process.exitCode = saved; }
  }

  it("posts the builtin ref to the seat and reports the daemon's effect", async () => {
    const effect = "Restore, resume and launches that read this seat's stored state use this policy, unless an explicit native selection (rig seat set-permissions) takes precedence.";
    const { deps, posts } = seatDeps({ status: 200, data: {
      ok: true, changed: true, from: null, to: "builtin:yolo", launchPosture: "full_bypass", effect,
    } });
    const out = await run(deps, ["policy", "apply", "yolo", "--seat", "dev-builder@spark", "--reason", "unattended", "--operator", "me@laptop"]);
    expect(posts).toEqual([["/api/seat/set-policy/dev-builder%40spark", { ref: "builtin:yolo", reason: "unattended", operator: "me@laptop" }]]);
    expect(out.logs).toEqual([
      "Recorded permission_policy: builtin:yolo on seat dev-builder@spark (launch_posture=full_bypass).",
      effect,
    ]);
    expect(out.exitCode).toBeUndefined();
  });

  it("reports none as an explicit floor for the seat, not inherited, through the nested verb too", async () => {
    const { deps, posts } = seatDeps({ status: 200, data: { ok: true, changed: false, to: "none", launchPosture: "floor", effect: "e" } });
    const out = await run(deps, ["policy", "permissions", "apply", "none", "--seat", "dev-builder@spark", "--reason", "r"]);
    expect(posts[0]![1]).toEqual({ ref: "none", reason: "r" });
    expect(out.logs[0]).toBe("Recorded permission_policy: none on seat dev-builder@spark: an explicit floor for this seat, not \"no policy\"; it does not inherit the rig's policy (launch_posture=floor) (unchanged).");
  });

  it("passes a daemon refusal through with its exit code", async () => {
    const refusal = { ok: false, code: "missing_reason", message: "An audit reason is required (--reason)." };
    const { deps } = seatDeps({ status: 400, data: refusal });
    const json = await run(deps, ["policy", "apply", "yolo", "--seat", "dev-builder@spark", "--json"]);
    expect(JSON.parse(json.logs.join(""))).toEqual(refusal);
    expect(json.exitCode).toBe(1);
    const human = await run(deps, ["policy", "apply", "yolo", "--seat", "dev-builder@spark"]);
    expect(human.errs).toEqual(["An audit reason is required (--reason)."]);
    expect(human.exitCode).toBe(1);
  });

  it("refuses an unknown choice, or anything but exactly one of --spec/--seat, without contacting the daemon", async () => {
    const { deps, posts } = seatDeps({ status: 200, data: {} });
    const unknown = await run(deps, ["policy", "apply", "builtin:yolo", "--seat", "s", "--reason", "r"]);
    expect(unknown.errs.join(" ")).toContain("Unknown policy choice 'builtin:yolo'");
    expect(unknown.exitCode).toBe(1);
    for (const argv of [["policy", "apply", "yolo"], ["policy", "apply", "yolo", "--spec", "rig.yaml", "--seat", "s"]]) {
      const out = await run(deps, argv);
      expect(out.errs.join(" ")).toContain("exactly one of --spec");
      expect(out.exitCode).toBe(1);
    }
    expect(posts).toEqual([]);
  });
});
