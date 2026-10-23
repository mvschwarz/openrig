// OPR skills-vendoring exec-mode QA blocker — SECOND hop (review50-r1 NOT-CLEAR on ac34ed75).
// PluginVendorService.ensureVendored stages assets (repo -> ~/.openrig/plugins) via text
// readFile->writeFile, which drops executable mode — an UPSTREAM hop the adapter preserveMode
// fix could not reach (the adapters faithfully preserve the already-644 staged copy). These are
// REAL-fs pins over the same fsOps shape production wires in startup.ts, covering the fresh-write
// path AND the content-identical hash-skip path (a previously-staged 644 must repair on re-vendor).

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { PluginVendorService, type PluginVendorFs } from "../src/domain/plugin-vendor-service.js";

function realVendorFs(): PluginVendorFs {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    listFiles: (dir) => {
      const r: string[] = [];
      const w = (d: string, pre: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name));
          else r.push(pre ? nodePath.join(pre, e.name) : e.name);
        }
      };
      w(dir, "");
      return r;
    },
    copyFileExclusive: (src: string, dest: string) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL),
    statMode: (p) => fs.statSync(p).mode,
    chmod: (p, m) => fs.chmodSync(p, m),
  };
}

const httpClient = async () => ({ ok: false, status: 404 });
const perm = (p: string) => fs.statSync(p).mode & 0o777;
const sha256 = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");

function materializePreviousRelease(target: string) {
  const fixtureRoot = nodePath.join(
    import.meta.dirname,
    "fixtures",
    "plugin-vendor",
    "openrig-core-835b700fc",
  );
  const paths = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "hooks/scripts/refocus.cjs",
  ];
  for (const rel of paths) {
    const encoded = fs.readFileSync(
      nodePath.join(fixtureRoot, rel + ".base64"),
      "utf-8",
    );
    const dest = nodePath.join(target, rel);
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(encoded.trim(), "base64"));
  }
}

function seedAssets(root: string) {
  const claudeManifest = nodePath.join(root, "openrig-core", ".claude-plugin", "plugin.json");
  const codexManifest = nodePath.join(root, "openrig-core", ".codex-plugin", "plugin.json");
  const skillDir = nodePath.join(root, "openrig-core", "skills", "compaction-restore", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(nodePath.dirname(claudeManifest), { recursive: true });
  fs.mkdirSync(nodePath.dirname(codexManifest), { recursive: true });
  const hook = nodePath.join(skillDir, "precompact-hook.mjs");
  const skillMd = nodePath.join(root, "openrig-core", "skills", "compaction-restore", "SKILL.md");
  fs.writeFileSync(claudeManifest, '{"name":"openrig-core","version":"0.1.0"}\n');
  fs.writeFileSync(codexManifest, '{"name":"openrig-core","version":"0.1.0"}\n');
  fs.writeFileSync(hook, "#!/usr/bin/env node\nconsole.log('hook');\n");
  fs.writeFileSync(skillMd, "# compaction-restore\n");
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(skillMd, 0o644);
  return { hookRel: "skills/compaction-restore/scripts/precompact-hook.mjs", skillRel: "skills/compaction-restore/SKILL.md" };
}

describe("PluginVendorService preserves executable mode during vendor staging (QA NOT-CLEAR, 2nd hop)", () => {
  it("ensureVendored stages the exec helper as 0755, non-exec neighbor as 0644", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-execmode-"));
    const assets = nodePath.join(base, "assets", "plugins");
    const rel = seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const svc = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: userPlugins, fs: realVendorFs(), httpClient });

    await svc.ensureVendored("openrig-core");

    const outHook = nodePath.join(userPlugins, "openrig-core", rel.hookRel);
    const outSkill = nodePath.join(userPlugins, "openrig-core", rel.skillRel);
    expect(fs.existsSync(outHook)).toBe(true);
    expect(perm(outHook)).toBe(0o755);
    expect(perm(outSkill)).toBe(0o644);
  });

  it("re-vendor repairs a previously-staged 0644 exec helper even when content is byte-identical (hash-skip path)", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-execmode-idem-"));
    const assets = nodePath.join(base, "assets", "plugins");
    const rel = seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const svc = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: userPlugins, fs: realVendorFs(), httpClient });

    await svc.ensureVendored("openrig-core");

    // Leave the equal-version installed bytes intact but reproduce the exact
    // QA state: a byte-identical executable helper carrying the WRONG mode.
    const outHook = nodePath.join(userPlugins, "openrig-core", rel.hookRel);
    fs.chmodSync(outHook, 0o644);
    expect(perm(outHook)).toBe(0o644);

    await svc.ensureVendored("openrig-core");

    // Content unchanged (write skipped) but mode reconciled to the source 0755.
    expect(perm(outHook)).toBe(0o755);
  });

  it("leaves a symlinked unversioned global canon byte-for-byte unchanged", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-global-authority-"));
    const assets = nodePath.join(base, "assets", "plugins");
    seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const logs: string[] = [];
    const svc = new PluginVendorService({
      vendoredAssetsDir: assets,
      userPluginsDir: userPlugins,
      fs: realVendorFs(),
      httpClient,
      logger: (...args) => logs.push(args.map(String).join(" ")),
    });
    await svc.ensureVendored("openrig-core");

    const canonDir = nodePath.join(base, "shared-canon", "compaction-restore");
    const canonSkill = nodePath.join(canonDir, "SKILL.md");
    const globalRoot = nodePath.join(base, "home", ".agents", "skills");
    fs.mkdirSync(canonDir, { recursive: true });
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.writeFileSync(canonSkill, "# newer shared canon\n");
    fs.symlinkSync(canonDir, nodePath.join(globalRoot, "compaction-restore"));

    svc.ensureSkillGlobally("openrig-core", "compaction-restore", [globalRoot]);

    expect(fs.readFileSync(canonSkill, "utf-8")).toBe("# newer shared canon\n");
    expect(fs.existsSync(nodePath.join(canonDir, ".openrig-vendor-version"))).toBe(false);
    expect(logs.join("\n")).toMatch(/unversioned\/external authority.*unchanged/i);
  });

  it("updates a real marked global projection only when its source version is newer", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-global-upgrade-"));
    const assets = nodePath.join(base, "assets", "plugins");
    seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const globalRoot = nodePath.join(base, "home", ".agents", "skills");
    const targetDir = nodePath.join(globalRoot, "compaction-restore");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(nodePath.join(targetDir, "SKILL.md"), "# projected 0.0.1\n");
    fs.writeFileSync(nodePath.join(targetDir, ".openrig-vendor-version"), "0.0.1\n");
    const svc = new PluginVendorService({
      vendoredAssetsDir: assets,
      userPluginsDir: userPlugins,
      fs: realVendorFs(),
      httpClient,
    });
    await svc.ensureVendored("openrig-core");

    svc.ensureSkillGlobally("openrig-core", "compaction-restore", [globalRoot]);

    expect(fs.readFileSync(nodePath.join(targetDir, "SKILL.md"), "utf-8")).toBe("# compaction-restore\n");
    expect(fs.readFileSync(nodePath.join(targetDir, ".openrig-vendor-version"), "utf-8")).toBe("0.1.0\n");
  });
});

describe("PluginVendorService release-version authority", () => {
  it("replaces the actual 835b700fc refocus hook when the bundled release is newer", async () => {
    const base = fs.mkdtempSync(
      nodePath.join(os.tmpdir(), "vendor-release-upgrade-"),
    );
    const assets = nodePath.resolve(import.meta.dirname, "../assets/plugins");
    const userPlugins = nodePath.join(base, "home", "plugins");
    const installedPlugin = nodePath.join(userPlugins, "openrig-core");
    const hookRel = "hooks/scripts/refocus.cjs";
    materializePreviousRelease(installedPlugin);

    const installedHook = nodePath.join(installedPlugin, hookRel);
    const bundledHook = nodePath.join(assets, "openrig-core", hookRel);
    expect(sha256(fs.readFileSync(installedHook))).toBe(
      "09601be0c704da9bf49eb2c8b174f9caa2983fd11fc5df9333b49ab28d4d3bfc",
    );
    expect(sha256(fs.readFileSync(bundledHook))).not.toBe(
      sha256(fs.readFileSync(installedHook)),
    );

    const svc = new PluginVendorService({
      vendoredAssetsDir: assets,
      userPluginsDir: userPlugins,
      fs: realVendorFs(),
      httpClient,
    });
    await svc.ensureVendored("openrig-core");

    expect(sha256(fs.readFileSync(installedHook))).toBe(
      sha256(fs.readFileSync(bundledHook)),
    );
    for (const manifestDir of [".claude-plugin", ".codex-plugin"]) {
      const installed = JSON.parse(
        fs.readFileSync(
          nodePath.join(installedPlugin, manifestDir, "plugin.json"),
          "utf-8",
        ),
      ) as { version: string };
      const bundled = JSON.parse(
        fs.readFileSync(
          nodePath.join(assets, "openrig-core", manifestDir, "plugin.json"),
          "utf-8",
        ),
      ) as { version: string };
      expect(installed.version).toBe(bundled.version);
    }
  });
});


describe("managed refresh preserves recoverable edits", () => {
  function upgrade(kind: "plugin" | "plugin skill" | "packaged skill", failBackup = false) {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-preserve-"));
    const assets = nodePath.join(base, "assets"); seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const globalRoot = nodePath.join(base, "global");
    const plugin = nodePath.join(userPlugins, "openrig-core");
    const source = kind === "plugin" ? nodePath.join(assets, "openrig-core") : plugin;
    const target = kind === "plugin" ? plugin : nodePath.join(globalRoot, "compaction-restore");
    const rel = kind === "plugin" ? "skills/compaction-restore/SKILL.md" : "SKILL.md";
    const dest = nodePath.join(target, rel);
    const logs: string[] = [];
    const ops = realVendorFs();
    const svc = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: userPlugins, fs: ops, httpClient,
      logger: (...args) => logs.push(args.map(String).join(" ")) });
    const manifest = (dir: string, version: string) => {
      for (const harness of [".claude-plugin", ".codex-plugin"]) {
        fs.mkdirSync(nodePath.join(dir, harness), { recursive: true });
        fs.writeFileSync(nodePath.join(dir, harness, "plugin.json"), JSON.stringify({ name: "openrig-core", version }));
      }
    };
    // Global projection reads a staged plugin; no daemon or native runtime involved.
    if (kind !== "plugin") {
      fs.mkdirSync(nodePath.join(plugin, "skills/compaction-restore"), { recursive: true });
      fs.writeFileSync(nodePath.join(plugin, "skills/compaction-restore/SKILL.md"), "# compaction-restore\n");
      manifest(plugin, "0.1.0");
    }
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    const edited = Buffer.from([0xff, 0, ...Buffer.from("my unique edit\r\n")]);
    fs.writeFileSync(dest, edited);
    if (kind === "plugin") manifest(target, "0.0.1");
    else fs.writeFileSync(nodePath.join(target, ".openrig-vendor-version"), "0.0.1\n");
    if (failBackup) ops.copyFileExclusive = () => { throw Error("fixture backup denied"); };
    const refresh = () => kind === "plugin" ? svc.ensureVendored("openrig-core")
      : kind === "plugin skill" ? svc.ensureSkillGlobally("openrig-core", "compaction-restore", [globalRoot])
        : svc.ensureSkillDirGlobally(nodePath.join(plugin, "skills/compaction-restore"), "compaction-restore", JSON.parse(fs.readFileSync(nodePath.join(source, ".claude-plugin/plugin.json"), "utf8")).version, [globalRoot]);
    const backupFiles = () => {
      const dir = nodePath.join(base, "home", "backups", "managed-refresh");
      return fs.existsSync(dir) ? ops.listFiles(dir).map(rel => nodePath.join(dir, rel)) : [];
    };
    return { base, source, target, dest, edited, logs, manifest, refresh, backupFiles, ops };
  }

  it.each(["plugin", "plugin skill", "packaged skill"] as const)("%s: recovers exact edited bytes after refresh and keeps earlier recovery copies across retries", async kind => {
    const f = upgrade(kind);
    try {
      // Fail the first target write after preservation, then retry the same version with another edit.
      const write = f.ops.writeFile;
      let failWrite = true;
      f.ops.writeFile = (file, content) => {
        if (failWrite && file.startsWith(f.target + nodePath.sep)) { failWrite = false; throw Error("fixture interrupted refresh"); }
        write(file, content);
      };
      await expect(Promise.resolve().then(f.refresh)).rejects.toThrow("fixture interrupted refresh");
      const saved = f.backupFiles().find(file => fs.readFileSync(file).equals(f.edited));
      expect(saved).toBeDefined();
      expect(f.logs.join("\n")).toContain(saved);
      expect(f.logs.join("\n")).toContain("may no longer be active");
      const nextEdit = Buffer.from("a second unique edit\n"); fs.writeFileSync(f.dest, nextEdit);
      await f.refresh();
      expect(fs.readFileSync(f.dest, "utf8")).toBe("# compaction-restore\n");
      expect(fs.readFileSync(saved!)).toEqual(f.edited);
      const second = f.backupFiles().find(file => fs.readFileSync(file).equals(nextEdit));
      expect(second).toBeDefined();
      await f.refresh(); // equal-version retry leaves both recovery copies intact
      expect(fs.readFileSync(saved!)).toEqual(f.edited);
      expect(fs.readFileSync(second!)).toEqual(nextEdit);
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  });

  it.each(["plugin", "plugin skill", "packaged skill"] as const)("%s: a failed preservation leaves all target files and version authority unchanged and warns", async kind => {
    const f = upgrade(kind, true);
    try {
      const before = Object.fromEntries(realVendorFs().listFiles(f.target).map(rel => [rel, fs.readFileSync(nodePath.join(f.target, rel))]));
      await expect(Promise.resolve().then(f.refresh)).resolves.toBeUndefined();
      for (const [rel, bytes] of Object.entries(before)) expect(fs.readFileSync(nodePath.join(f.target, rel))).toEqual(bytes);
      expect(f.logs.join("\n")).toContain("fixture backup denied");
      expect(f.logs.join("\n")).toContain("refresh skipped");
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  });
});
