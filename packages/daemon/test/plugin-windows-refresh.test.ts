import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const assets = path.resolve(import.meta.dirname, "../assets/plugins");
const manifests = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
const dependencies = ["hooks/scripts/refocus.cjs", "hooks/scripts/refocus-health.cjs", "hooks/scripts/rig-command.cjs", "hooks/scripts/python-command.cjs", "hooks/scripts/refocus-state-lock.cjs"];
const bundledVersion = JSON.parse(fs.readFileSync(path.join(assets, "openrig-core", manifests[0]!), "utf8")).version as string;

function fixture(version: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin refresh Ω ")); roots.push(root);
  const userPluginsDir = path.join(root, "plugins"), target = path.join(userPluginsDir, "openrig-core");
  for (const manifest of manifests) {
    fs.mkdirSync(path.dirname(path.join(target, manifest)), { recursive: true });
    fs.writeFileSync(path.join(target, manifest), JSON.stringify({ name: "openrig-core", version }));
  }
  fs.mkdirSync(path.join(target, "hooks", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(target, "hooks", "scripts", "refocus.cjs"), "// previous installed refocus\n");
  fs.writeFileSync(path.join(target, "personal.txt"), "retain unrelated installed file");
  const listFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listFiles(path.join(dir, entry.name)).map(rel => path.join(entry.name, rel)) : [entry.name]);
  const service = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir,
    fs: { readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p, text) => fs.writeFileSync(p, text),
      copyFileExclusive: (a, b) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL), exists: fs.existsSync,
      mkdirp: p => { fs.mkdirSync(p, { recursive: true }); }, listFiles },
    httpClient: async () => { throw new Error("No network is needed for vendoring"); },
  });
  return { root, target, service, listFiles };
}

it("upgrades 0.1.21 with the complete refocus dependency tree and preserves replaced content", async () => {
  const f = fixture("0.1.21");
  await f.service.ensureVendored("openrig-core");
  for (const rel of [...manifests, ...dependencies]) {
    expect(fs.readFileSync(path.join(f.target, rel))).toEqual(fs.readFileSync(path.join(assets, "openrig-core", rel)));
  }
  expect(JSON.parse(fs.readFileSync(path.join(f.target, manifests[0]!), "utf8")).version).not.toBe("0.1.21");
  const backups = f.listFiles(path.join(f.root, "backups"));
  const oldRefocus = backups.find(rel => rel.endsWith(path.join("hooks", "scripts", "refocus.cjs")));
  expect(oldRefocus).toBeTruthy();
  expect(fs.readFileSync(path.join(f.root, "backups", oldRefocus!), "utf8")).toBe("// previous installed refocus\n");
  expect(fs.readFileSync(path.join(f.target, "personal.txt"), "utf8")).toBe("retain unrelated installed file");
  const require = createRequire(import.meta.url);
  expect(typeof require(path.join(f.target, "hooks", "scripts", "rig-command.cjs")).spawnRig).toBe("function");
  expect(typeof require(path.join(f.target, "hooks", "scripts", "python-command.cjs")).spawnPython).toBe("function");
  const before = f.listFiles(f.root).sort();
  await f.service.ensureVendored("openrig-core");
  expect(f.listFiles(f.root).sort()).toEqual(before);
});

it.each([bundledVersion, "9.0.0"])("retains equal/newer installed content at %s", async version => {
  const f = fixture(version);
  await f.service.ensureVendored("openrig-core");
  expect(fs.readFileSync(path.join(f.target, "hooks", "scripts", "refocus.cjs"), "utf8")).toBe("// previous installed refocus\n");
  expect(fs.existsSync(path.join(f.target, "hooks", "scripts", "rig-command.cjs"))).toBe(false);
  expect(fs.existsSync(path.join(f.root, "backups"))).toBe(false);
});
