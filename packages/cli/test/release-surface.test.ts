// OPR.0.3.3.13.1 - CLI surface-detection parser POC tests (AC-1..AC-5).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  extractSurfaceFromSources,
  normalizeFlag,
  FLAG_SEP,
  type Surface,
} from "../src/release-surface/extract-surface.js";
import {
  computeDiff,
  generateSurfaceDiff,
  diffToYaml,
  SurfaceParserError,
  type SurfaceDiff,
} from "../src/release-surface/surface-diff.js";

const here = fileURLToPath(new URL(".", import.meta.url));
function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readSource(rel: string): { name: string; text: string } {
  const abs = repoPath(rel);
  return { name: rel.replace(/^src\//, ""), text: fs.readFileSync(abs, "utf8") };
}

const FROM = "v0.3.1";
const TO = "v0.3.2";

describe("release-surface parser - extract (unit)", () => {
  it("AC-2 crux: emits the registration name `mode`, never the filename `rig-mode` (verb renamed from `policy`, B7)", () => {
    const surface = extractSurfaceFromSources([readSource("src/commands/rig-mode.ts")]);
    expect(surface.commands.has("mode")).toBe(true);
    expect([...surface.commands].some((c) => c.includes("rig-mode"))).toBe(false);
    // a few known subcommands of `mode`
    expect(surface.commands.has("mode set")).toBe(true);
    expect(surface.commands.has("mode defaults")).toBe(true);
  });

  it("AC-3: captures the option name-token despite a template-literal description", () => {
    const surface = extractSurfaceFromSources([readSource("src/commands/scope.ts")]);
    // `scope slice create --template` has a `\`Template: ${...}\`` description.
    expect(surface.commands.has("scope slice create")).toBe(true);
    expect(surface.flags.has(`scope slice create${FLAG_SEP}--template`)).toBe(true);
    // `--reason` on `scope slice close` is a requiredOption with a template desc.
    expect(surface.flags.has(`scope slice close${FLAG_SEP}--reason`)).toBe(true);
    // top-level `--workspace` option on the scope root.
    expect(surface.flags.has(`scope${FLAG_SEP}--workspace`)).toBe(true);
  });

  it("AC-3 helper: normalizeFlag reduces flags strings to the canonical long flag", () => {
    expect(normalizeFlag("--body-file <path>")).toBe("--body-file");
    expect(normalizeFlag("--no-mission-notes")).toBe("--no-mission-notes");
    expect(normalizeFlag("-l, --literal")).toBe("--literal");
    expect(normalizeFlag("-y")).toBe("-y");
    expect(normalizeFlag("not-a-flag")).toBeNull();
  });

  it("captures the new queue create flags", () => {
    const surface = extractSurfaceFromSources([readSource("src/commands/queue.ts")]);
    expect(surface.commands.has("queue create")).toBe(true);
    for (const f of ["--body-file", "--mission", "--slice"]) {
      expect(surface.flags.has(`queue create${FLAG_SEP}${f}`)).toBe(true);
    }
  });
});

describe("release-surface parser - diff (AC-1)", () => {
  it("AC-1: produces all five keys from a synthetic surface delta", () => {
    const from: Surface = {
      commands: new Set(["queue", "queue create", "old", "workspace"]),
      flags: new Set([`queue create${FLAG_SEP}--source`, `old${FLAG_SEP}--gone`]),
    };
    const to: Surface = {
      commands: new Set(["queue", "queue create", "scope", "scope mission", "workspace", "workspace doctor"]),
      flags: new Set([`queue create${FLAG_SEP}--source`, `queue create${FLAG_SEP}--body-file`]),
    };
    const diff = computeDiff(from, to, "refA", "refB");

    expect(diff.release_from).toBe("refA");
    expect(diff.release_to).toBe("refB");
    // brand-new top-level command `scope` with its added subpath.
    expect(diff.added_commands).toEqual([
      { name: "scope", subcommands: ["mission"] },
    ]);
    // existing `queue create` gained a flag; existing `workspace` gained a subcommand.
    const flagsByCmd = new Map(diff.added_flags.map((e) => [e.command, e]));
    expect(flagsByCmd.get("queue create")?.flags).toEqual(["--body-file"]);
    expect(flagsByCmd.get("workspace")?.subcommands).toEqual(["doctor"]);
    // removed command `old` + removed flag `old --gone`.
    expect(diff.removed_or_renamed).toEqual(["old", "old --gone"]);
  });
});

describe("release-surface parser - v0.3.1..v0.3.2 worked example (AC-2)", () => {
  const diff = generateSurfaceDiff({ from: FROM, to: TO, cwd: here });

  it("emits exactly `policy` and `scope` as new top-level commands (no false positives, no filename)", () => {
    const names = diff.added_commands.map((c) => c.name).sort();
    expect(names).toEqual(["policy", "scope"]);
    expect(names).not.toContain("rig-policy");
  });

  it("surfaces the new queue create flags", () => {
    const queueCreate = diff.added_flags.find((e) => e.command === "queue create");
    expect(queueCreate).toBeDefined();
    for (const f of ["--body-file", "--mission", "--slice"]) {
      expect(queueCreate!.flags ?? []).toContain(f);
    }
  });

  it("validates against the checked-in fixture with zero false negatives", () => {
    const fixture = parseYaml(
      fs.readFileSync(repoPath("src/release-surface/v0.3.2-surface.fixture.yaml"), "utf8"),
    ) as SurfaceDiff;

    const outCmdNames = new Set(diff.added_commands.map((c) => c.name));
    for (const fc of fixture.added_commands) {
      expect(outCmdNames.has(fc.name), `fixture added_command "${fc.name}" missing from parser output`).toBe(true);
    }

    const outByCmd = new Map(diff.added_flags.map((e) => [e.command, e]));
    for (const fe of fixture.added_flags) {
      const out = outByCmd.get(fe.command);
      expect(out, `fixture command "${fe.command}" missing from parser output`).toBeDefined();
      for (const f of fe.flags ?? []) {
        expect(out!.flags ?? [], `fixture flag ${fe.command} ${f} missing`).toContain(f);
      }
      for (const s of fe.subcommands ?? []) {
        expect(out!.subcommands ?? [], `fixture subcommand ${fe.command} ${s} missing`).toContain(s);
      }
    }

    // No silent over/under-report at command granularity: the parser's
    // added_flags command set must exactly equal the fixture's (the fixture was
    // independently derived from the release notes + tag diff, then reconciled).
    const outFlagCmds = diff.added_flags.map((e) => e.command).sort();
    const fixtureFlagCmds = fixture.added_flags.map((e) => e.command).sort();
    expect(outFlagCmds).toEqual(fixtureFlagCmds);

    // Nothing was removed or renamed v0.3.1..v0.3.2 (the release was additive).
    // A spurious entry here would signal inconsistent cross-ref extraction.
    expect(diff.removed_or_renamed).toEqual([]);
  });
});

describe("release-surface parser - determinism (AC-4)", () => {
  it("produces byte-identical YAML across two runs on the same refs", () => {
    const a = diffToYaml(generateSurfaceDiff({ from: FROM, to: TO, cwd: here }));
    const b = diffToYaml(generateSurfaceDiff({ from: FROM, to: TO, cwd: here }));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  }, 30000);
});

describe("release-surface parser - honest failure (AC-5)", () => {
  it("throws a 3-part error (not a silent empty diff) on a non-existent ref", () => {
    let caught: unknown;
    try {
      generateSurfaceDiff({ from: "v0.0.0-does-not-exist", to: TO, cwd: here });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SurfaceParserError);
    const e = caught as SurfaceParserError;
    expect(e.fact).toBeTruthy();
    expect(e.consequence).toBeTruthy();
    expect(e.action).toBeTruthy();
    // explicitly NOT a silent empty diff
    expect(e.consequence.toLowerCase()).toContain("diff");
  });
});
