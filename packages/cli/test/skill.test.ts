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

  it("a skipped mirror drift check (installed package) is informational: prints SKIPPED and PASS, exits 0", async () => {
    const deps = makeDeps({
      status: 200,
      data: {
        ok: true,
        entries: [],
        totalFindings: 0,
        mirrorDriftSkipped: "Mirror drift check skipped: no scripts/mirror-skills.mjs under /pkg; it runs only in an OpenRig source checkout",
      },
    });

    const cmd = skillCommand(deps);
    await cmd.parseAsync(["node", "rig", "audit"]);

    expect(process.exitCode).toBeUndefined();
    expect(logs.some((l) => l.includes("MIRROR DRIFT CHECK SKIPPED"))).toBe(true);
    expect(logs.some((l) => l.includes("FAIL"))).toBe(false);
    expect(logs.some((l) => l.includes("PASS"))).toBe(true);
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

  it("the human output closes by saying the audit doesn't judge refresh safety and naming the read-only loadout check, on PASS and FAIL", async () => {
    for (const data of [{ ok: true, entries: [], totalFindings: 0 }, { ok: true, entries: [], totalFindings: 0, mirrorDriftError: "x" }]) {
      logs.length = 0;
      await skillCommand(makeDeps({ status: 200, data })).parseAsync(["node", "rig", "audit"]);
      expect(logs.at(-1)).toContain("doesn't say whether that's safe");
      expect(logs.at(-1)).toContain("rig skill loadout --runtime <claude-code|codex> --cwd <target> --project-root <project> --json");
    }
  });

  it("--help says what stale means, that the audit doesn't judge refresh safety, and which read-only check does", () => {
    const audit = skillCommand(makeDeps({ status: 200, data: {} })).commands.find((c) => c.name() === "audit")!;
    let help = "";
    audit.configureOutput({ writeOut: (s) => { help += s; } });
    audit.outputHelp();
    expect(help).toContain('"stale" is a date finding');
    expect(help).toContain("whether a copy is safe to refresh or overwrite");
    expect(help).toContain("rig skill loadout --runtime <claude-code|codex> --cwd <target> --project-root <project> --json");
    expect(help).toContain("which leaves any difference unknown");
    expect(help).toContain("its origin stays unknown");
  });
});
