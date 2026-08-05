// OPR.0.5.0 — `rig ps --nodes` HONEST SCOPE METADATA. The current-rig-only default is CORRECT and
// STAYS; the fix DECLARES the scope so a scoped list is never read as the whole host (the width-clip
// honesty rule applied to CLI output: output that silently looks complete is silent loss).
// Verified via a STUB client (the DaemonClient http harness is pre-existing-broken in this env —
// res.json() "position 4", the Atom-5/S-C CLI-harness flake class).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { psCommand } from "../src/commands/ps.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

const RIGS_MULTI = [
  { rigId: "rA", rigName: "alpha", name: "alpha" },
  { rigId: "rB", rigName: "beta", name: "beta" },
  { rigId: "rC", rigName: "gamma", name: "gamma" },
];
const RIGS_SINGLE = [{ rigId: "rA", rigName: "alpha", name: "alpha" }];
const NODE = { rigId: "rA", rigName: "alpha", logicalId: "dev.impl", canonicalSessionName: "dev-impl@alpha", lifecycleState: "running", sessionStatus: "running", agentActivity: null, hasAssignedWork: false, pendingWorkCount: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubClientFactory(rigs: any[]) {
  return () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (path: string) => {
      if (path.startsWith("/api/ps")) return { status: 200, data: rigs };
      if (path.includes("/nodes")) return { status: 200, data: [NODE] };
      return { status: 200, data: [] };
    },
  }) as never;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(rigs: any[]): any {
  return {
    lifecycleDeps: { spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true, readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port: 1, db: "x", startedAt: "x" }) : null), writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true },
    clientFactory: stubClientFactory(rigs),
  };
}
async function run(args: string[], rigs: unknown[]): Promise<{ out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const ol = console.log, oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { await psCommand(deps(rigs) as any).parseAsync(["node", "rig", ...args]); }
  finally { console.log = ol; console.error = oe; }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("rig ps --nodes honest scope metadata", () => {
  beforeEach(() => { process.env.OPENRIG_SESSION_NAME = "dev-impl@alpha"; }); // session rig = alpha
  afterEach(() => { delete process.env.OPENRIG_SESSION_NAME; });

  it("MULTI-RIG: --nodes --json gains a parseable scope object {rig, rigsOnHost, hint}", async () => {
    const { out } = await run(["--nodes", "--json"], RIGS_MULTI);
    const parsed = JSON.parse(out);
    expect(parsed.scope).toBeDefined();
    expect(parsed.scope.rig).toBe("alpha");
    expect(parsed.scope.rigsOnHost).toBe(3);
    expect(parsed.scope.hint).toContain("rig ps lists all");
    expect(parsed.scope.hint).toMatch(/-A|--rig/);
    expect(parsed.entries).toHaveLength(1); // still scoped to the session rig (behavior unchanged)
  });

  it("MULTI-RIG: --nodes (human) renders ONE matching stderr hint line", async () => {
    const { err } = await run(["--nodes"], RIGS_MULTI);
    expect(err).toContain("rigs shown");
    expect(err).toContain("alpha");
    expect(err).toMatch(/rig ps lists all|--rig NAME or -A/);
  });

  it("NO DEFAULT CHANGE: single-rig host → NO scope, bare array (byte-stable)", async () => {
    const { out, err } = await run(["--nodes", "--json"], RIGS_SINGLE);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true); // unchanged: bare array, no envelope, no scope
    expect(err).toBe(""); // no stderr hint when nothing is hidden
  });

  it("NO DEFAULT CHANGE: the scoped node set is unchanged (still the session rig only)", async () => {
    const { out } = await run(["--nodes", "--json"], RIGS_MULTI);
    const entries = JSON.parse(out).entries;
    expect(entries.every((n: { rigName: string }) => n.rigName === "alpha")).toBe(true);
  });
});
