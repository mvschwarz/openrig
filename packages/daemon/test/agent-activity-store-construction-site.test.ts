import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// W2a-1 STRUCTURAL GUARD (A4 sixth-site shape).
//
// The generation gate is an OPTIONAL dependency: a construction site that omits
// `resolveOccupantGeneration` or node-scoped membership resolver silently falls to an incomplete
// generation detector — with nothing failing. "One production site, resolver injected" is true today
// (startup.ts) but unenforced tomorrow. This pins it: production `src/` must contain EXACTLY ONE
// `new AgentActivityStore(` and that site must inject the resolver. A second site, or a naked one,
// fails LOUD here rather than turning the detector off in the dark.
//
// (Direct constructions in `test/` intentionally omit the resolver to exercise the legacy path; they
// are excluded because they are prod-unreachable by construction — the whole reason this guard exists.)
describe("AgentActivityStore — single production construction site (W2a-1)", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));

  function walkTs(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkTs(full);
      return entry.isFile() && full.endsWith(".ts") ? [full] : [];
    });
  }

  it("has exactly one production construction site, and it injects both generation resolvers", () => {
    const sites: Array<{ file: string; injectsResolver: boolean; injectsMembership: boolean }> = [];
    for (const file of walkTs(srcDir)) {
      const text = fs.readFileSync(file, "utf8");
      const re = /new AgentActivityStore\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        // Inspect a bounded window of the constructor-arg object literal for the resolver key.
        const window = text.slice(match.index, match.index + 400);
        sites.push({
          file: path.relative(srcDir, file),
          injectsResolver: /resolveOccupantGeneration/.test(window),
          injectsMembership: /isRegisteredOccupantGeneration/.test(window),
        });
      }
    }

    expect(
      sites,
      `expected exactly ONE production construction site of AgentActivityStore; got ${JSON.stringify(sites)}`,
    ).toHaveLength(1);
    expect(
      sites[0]?.injectsResolver,
      `the sole construction site (${sites[0]?.file}) must inject resolveOccupantGeneration — a naked site ` +
        `silently disables the generation gate (legacy clock-only path)`,
    ).toBe(true);
    expect(
      sites[0]?.injectsMembership,
      `the sole construction site (${sites[0]?.file}) must inject isRegisteredOccupantGeneration — ` +
        `otherwise an uncommitted reservation can be misreported as a dead tenure`,
    ).toBe(true);
  });
});
