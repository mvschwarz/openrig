import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeAgentImages } from "../src/domain/bundle-agent-images-router.js";
import { routeContextPacks } from "../src/domain/bundle-context-packs-router.js";
import { routeWorkflowSpecs } from "../src/domain/bundle-workflow-specs-router.js";
import { routePlugins } from "../src/domain/bundle-plugins-router.js";
import { routeSkills } from "../src/domain/bundle-skills-router.js";

let root: string | undefined;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32").each(["image", "context", "workflow", "plugin", "skill"])("retains the first %s when native target names differ only by casing", kind => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-native-target-"));
  const bundleRoot = path.join(root, "bundle"), target = path.join(root, "target");
  const files = kind === "workflow" ? ["a/Owned.yaml", "b/owned.yaml"]
    : kind === "skill" ? ["skills/Owned/SKILL.md", "owned/SKILL.md"]
      : ["a/Owned/manifest.yaml", "b/owned/manifest.yaml"];
  for (const [index, file] of files.entries()) {
    const full = path.join(bundleRoot, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `owned fixture ${index}\n`);
  }
  const operations = {
    exists: fs.existsSync,
    isDirectory: (file: string) => fs.statSync(file).isDirectory(),
    mkdirp: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); },
    copyDir: (from: string, to: string) => fs.cpSync(from, to, { recursive: true }),
    copyFile: fs.copyFileSync,
    readFile: (file: string) => fs.readFileSync(file, "utf8"),
    listFiles: () => ["manifest.yaml"],
  };
  const result = kind === "image"
    ? routeAgentImages({ bundleRoot, declaredAgentImages: files.map(file => path.dirname(file)), targetAgentImagesDir: target }, operations)
    : kind === "context"
      ? routeContextPacks({ bundleRoot, declaredContextPacks: files, targetContextPacksDir: target }, operations)
      : kind === "workflow" ? routeWorkflowSpecs({ bundleRoot, declaredWorkflowSpecs: files, targetWorkflowSpecsDir: target }, operations)
        : kind === "plugin" ? routePlugins({ bundleRoot, declaredPlugins: files.map((file, index) => ({ id: index === 0 ? "Owned" : "owned", source: { kind: "local", path: path.dirname(file) } })), targetPluginsDir: target }, operations)
          : routeSkills({ bundleRoot, declaredSkills: files, targetSkillsDir: target }, operations);
  expect(result.records.map(record => record.status)).toEqual(["routed", "conflict"]);
  expect(result.routedCount).toBe(1);
  expect(fs.readFileSync(path.join(target, kind === "workflow" ? "Owned.yaml" : kind === "skill" ? "Owned/SKILL.md" : "Owned/manifest.yaml"), "utf8")).toBe("owned fixture 0\n");
});
