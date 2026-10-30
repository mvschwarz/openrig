import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";

it.runIf(process.platform === "win32")("publishes and refreshes a skill loadout with a valid long ownership-manifest filename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manifest-name-"));
  try {
    const catalog = path.join(root, "catalog"), project = path.join(root, "project"), storage = path.join(root, "storage");
    fs.mkdirSync(path.join(catalog, "owned"), { recursive: true });
    fs.mkdirSync(project);
    const skill = path.join(catalog, "owned", "SKILL.md");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "-q"); git("config", "user.name", "Owned Fixture"); git("config", "user.email", "owned@example.invalid");
    const targetRoot = path.join(storage, "skills"), name = "m".repeat(243) + ".json", manifestPath = path.join(storage, name);
    for (const version of ["first", "updated"]) {
      const bytes = `---\nname: owned\ndescription: Owned fixture skill.\n---\n${version}\n`;
      fs.writeFileSync(skill, bytes);
      git("add", "catalog/owned/SKILL.md"); git("commit", "-qm", version);
      const selected = resolveSkillLoadout({ catalogRoot: catalog, systemSkills: ["owned"] });
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error("owned source did not resolve");
      const apply = () => reconcileSkillLoadout({ loadout: selected.loadout, runtime: "claude-code", cwd: project, apply: true,
        location: { targetRoot, manifestPath, qualifiedName: id => `openrig:${id}` } });
      if (version === "updated") {
        const priorManifest = fs.readFileSync(manifestPath, "utf8");
        const priorSkill = fs.readFileSync(path.join(targetRoot, "owned", "SKILL.md"), "utf8");
        fs.chmodSync(manifestPath, 0o444);
        try {
          expect(apply()).toMatchObject({ ok: false, applied: false });
          expect(fs.readFileSync(manifestPath, "utf8")).toBe(priorManifest);
          expect(fs.readFileSync(path.join(targetRoot, "owned", "SKILL.md"), "utf8")).toBe(priorSkill);
          expect(fs.readdirSync(storage).sort()).toEqual([name, "skills"].sort());
        } finally { fs.chmodSync(manifestPath, 0o666); }
      }
      const result = apply();
      expect(result).toMatchObject({ ok: true, applied: true });
      expect(fs.readFileSync(path.join(targetRoot, "owned", "SKILL.md"), "utf8")).toBe(bytes);
      expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).toMatchObject({ skills: [{ id: "owned", qualifiedName: "openrig:owned" }] });
      expect(fs.readdirSync(storage).sort()).toEqual([name, "skills"].sort());
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
