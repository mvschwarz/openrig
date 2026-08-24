import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// slice-07 R3 — RED-first pins for the thin router stub: the openrig-core router must carry the rig
// TOOL GRANT and teach loading an entry on demand via `rig context get` (R1's serving verb), so the
// harness has ONE skill that teaches the pull — the precondition for CE-08 thinning. The mass removal
// of the other skills and hidden-from-listing are CE-08, fenced out of R3.
const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(HERE, "..", "assets", "plugins", "openrig-core", "skills", "openrig-skills", "SKILL.md");

function frontmatterAndBody(md: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m) throw new Error("router stub has no YAML frontmatter");
  return { fm: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! };
}

describe("R3 — openrig-core router stub teaches the pull", () => {
  const { fm, body } = frontmatterAndBody(readFileSync(STUB, "utf-8"));

  it("carries the rig tool grant in allowed-tools", () => {
    expect(String(fm["allowed-tools"] ?? "")).toMatch(/\brig\b/);
  });

  it("teaches loading an entry on demand via `rig context get`", () => {
    expect(body).toMatch(/rig context get/);
  });

  it("stays mode-free in core (no mode-conditional trigger in the router)", () => {
    // CE slice-05 ruling: mode knowledge rides mode plugins, not core. A descriptive host-scale
    // mention is fine; a mode-CONDITIONAL trigger is not.
    expect(body).not.toMatch(/\b(if|when)\b[^.\n]{0,40}\b(factory|lab|hq)\s+mode\b/i);
  });
});
