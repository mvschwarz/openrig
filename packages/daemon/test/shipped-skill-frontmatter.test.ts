// OPR.0.6.1.6 — every SKILL.md the package ships must pass the daemon's own
// frontmatter contract (parseSkillFrontmatter: `---` block with name +
// description, non-empty body). scripts/build-package.sh copies
// packages/daemon/specs and packages/daemon/assets wholesale into the npm
// artifact, so those are the roots checked here. The generated
// context-packs projection is validated by its own manifest parser at build.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSkillFrontmatter } from "../src/domain/skill-discovery.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const SHIPPED_ROOTS = ["specs", "assets"].map((r) => join(PACKAGE_ROOT, r));

function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSkillFiles(full));
    else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

describe("shipped SKILL.md frontmatter", () => {
  const skillFiles = SHIPPED_ROOTS.filter((r) => existsSync(r)).flatMap(findSkillFiles);

  it("finds shipped skills under every shipped root", () => {
    for (const root of SHIPPED_ROOTS) {
      expect(skillFiles.some((f) => f.startsWith(root + "/")), `no SKILL.md under ${root}`).toBe(true);
    }
  });

  it("every shipped SKILL.md passes parseSkillFrontmatter", () => {
    const failures = skillFiles.flatMap((file) => {
      const result = parseSkillFrontmatter(readFileSync(file, "utf8"));
      return result.ok ? [] : [`${relative(PACKAGE_ROOT, file)}: ${result.reason}`];
    });
    expect(failures).toEqual([]);
  });

  it("rejects a shipped skill whose frontmatter is removed", () => {
    const vault = join(PACKAGE_ROOT, "specs/agents/apps/vault-specialist/skills/vault-user/SKILL.md");
    const stripped = readFileSync(vault, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
    const result = parseSkillFrontmatter(stripped);
    expect(result.ok).toBe(false);
  });
});
