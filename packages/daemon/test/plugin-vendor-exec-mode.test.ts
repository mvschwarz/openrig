// OPR skills-vendoring exec-mode QA blocker — SECOND hop (review50-r1 NOT-CLEAR on ac34ed75).
// PluginVendorService.ensureVendored stages assets (repo -> ~/.openrig/plugins) via text
// readFile->writeFile, which drops executable mode — an UPSTREAM hop the adapter preserveMode
// fix could not reach (the adapters faithfully preserve the already-644 staged copy). These are
// REAL-fs pins over the same fsOps shape production wires in startup.ts, covering the fresh-write
// path AND the content-identical hash-skip path (a previously-staged 644 must repair on re-vendor).

import { describe, it, expect } from "vitest";
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
    statMode: (p) => fs.statSync(p).mode,
    chmod: (p, m) => fs.chmodSync(p, m),
  };
}

const httpClient = async () => ({ ok: false, status: 404 });
const perm = (p: string) => fs.statSync(p).mode & 0o777;

function seedAssets(root: string) {
  const skillDir = nodePath.join(root, "openrig-core", "skills", "compaction-restore", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  const hook = nodePath.join(skillDir, "precompact-hook.mjs");
  const skillMd = nodePath.join(root, "openrig-core", "skills", "compaction-restore", "SKILL.md");
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

    // Pre-stage a byte-identical copy with the WRONG (0644) mode — the exact QA state.
    const outHook = nodePath.join(userPlugins, "openrig-core", rel.hookRel);
    fs.mkdirSync(nodePath.dirname(outHook), { recursive: true });
    fs.copyFileSync(nodePath.join(assets, "openrig-core", rel.hookRel), outHook);
    fs.chmodSync(outHook, 0o644);
    expect(perm(outHook)).toBe(0o644);

    await svc.ensureVendored("openrig-core");

    // Content unchanged (write skipped) but mode reconciled to the source 0755.
    expect(perm(outHook)).toBe(0o755);
  });
});
