import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skillsRoot = resolve(import.meta.dirname, "../assets/plugins/openrig-core/skills");
const skill = (name: string, relative = "SKILL.md") =>
  readFileSync(resolve(skillsRoot, name, relative), "utf8");

describe("S20 P6 principles-first role guidance", () => {
  it("gives the incumbent and successor their distinct apprentice-mode arcs with reasons", () => {
    const incumbent = skill("retiring-and-inheriting-a-seat");
    const successor = skill("orienting-to-an-inherited-seat");

    expect(incumbent).toContain("## Apprentice mode — incumbent");
    expect(incumbent).toMatch(/conversation, not a gauntlet/i);
    expect(incumbent).toMatch(/because recurring duties/i);
    expect(successor).toContain("## Apprentice arc — successor");
    expect(successor).toMatch(/authority-free until/i);
    expect(successor).toMatch(/because reading a deposit does not install it/i);
  });

  it("keeps mechanic detail in one portable SOP and routes the orchestrator to its own reference", () => {
    const continuity = skill("seat-continuity-and-handover");
    const sopPath = resolve(skillsRoot, "seat-continuity-and-handover/references/apprentice-successor-seat-cutover.md");
    const orchestratorPath = resolve(skillsRoot, "seat-continuity-and-handover/references/orchestrator-role.md");

    expect(existsSync(sopPath)).toBe(true);
    expect(existsSync(orchestratorPath)).toBe(true);
    expect(continuity).toContain("references/apprentice-successor-seat-cutover.md");
    expect(continuity).toContain("references/orchestrator-role.md");
    expect(readFileSync(orchestratorPath, "utf8")).toMatch(/word is the gate/i);
  });

  it("ships the experiment apparatus as an optional, stakes-matched toolkit", () => {
    const toolkitPath = resolve(skillsRoot, "seat-continuity-and-handover/references/apprentice-evidence-toolkit.md");
    expect(existsSync(toolkitPath)).toBe(true);
    const toolkit = readFileSync(toolkitPath, "utf8");
    expect(toolkit).toMatch(/optional evidence toolkit/i);
    expect(toolkit).toMatch(/match.*stakes/i);
    expect(toolkit).toMatch(/predict-sync/i);
    expect(toolkit).toMatch(/first-stated/i);
  });
});
