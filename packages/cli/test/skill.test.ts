import { describe, it, expect, vi, beforeEach } from "vitest";
import { skillCommand } from "../src/commands/skill.js";

function makeDeps(auditResponse: { status: number; data: unknown }) {
  const client = {
    get: vi.fn(async () => auditResponse),
    post: vi.fn(async () => ({ status: 200, data: {} })),
  };
  return {
    lifecycleDeps: {
      spawn: vi.fn(),
      fetch: vi.fn(async () => ({ ok: true })),
      kill: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "t.sqlite", startedAt: new Date().toISOString() })),
      writeFile: vi.fn(),
      removeFile: vi.fn(),
      exists: vi.fn(() => true),
      mkdirp: vi.fn(),
      openForAppend: vi.fn(() => 1),
      isProcessAlive: vi.fn(() => true),
    },
    clientFactory: () => client,
  };
}

describe("rig skill audit", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
    process.exitCode = undefined;
  });

  it("mirrorDriftError with totalFindings:0 exits nonzero and does NOT print PASS", async () => {
    const deps = makeDeps({
      status: 200,
      data: {
        ok: true,
        entries: [],
        totalFindings: 0,
        mirrorDriftError: "Mirror source not found: /nonexistent/path",
      },
    });

    const cmd = skillCommand(deps);
    await cmd.parseAsync(["node", "rig", "audit"]);

    expect(process.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("MIRROR DRIFT CHECK UNAVAILABLE"))).toBe(true);
    expect(logs.some((l) => l.includes("FAIL"))).toBe(true);
    expect(logs.some((l) => l.includes("PASS"))).toBe(false);
  });

  it("mirrorDriftError in JSON mode exits nonzero", async () => {
    const deps = makeDeps({
      status: 200,
      data: {
        ok: true,
        entries: [],
        totalFindings: 0,
        mirrorDriftError: "rsync not available",
      },
    });

    const cmd = skillCommand(deps);
    await cmd.parseAsync(["node", "rig", "audit", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("mirrorDriftError"))).toBe(true);
  });

  it("clean audit with no mirrorDriftError prints PASS and exits 0", async () => {
    const deps = makeDeps({
      status: 200,
      data: {
        ok: true,
        entries: [],
        totalFindings: 0,
      },
    });

    const cmd = skillCommand(deps);
    await cmd.parseAsync(["node", "rig", "audit"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((l) => l.includes("PASS"))).toBe(true);
  });
});
