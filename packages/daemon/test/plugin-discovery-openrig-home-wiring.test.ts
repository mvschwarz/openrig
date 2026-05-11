// bug-fix slice plugin-discovery-respects-openrig-home — wiring test.
//
// Verifies the startup-time wiring of PluginDiscoveryService honors
// `OPENRIG_HOME` env override (HG-1, HG-3, HG-4 per IMPL-PRD §5). The
// service-level tests in plugin-discovery-service.test.ts cover the
// scan logic against injected paths; THIS test covers the call-site
// resolution in startup.ts that pre-fix hardcoded
// `~/.openrig/plugins`. Without this gate, the next regression at the
// call site would only surface via end-to-end VM dogfood exercise
// (which is exactly how velocity-qa caught the bug originally).
//
// HG-5 (audit-grep) is asserted as a static check in the second
// describe: no `homedir().*\.openrig.*plugins` literal remains in
// daemon src.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../src/startup.js";

let tmpHome: string;
let savedHome: string | undefined;
let savedNoKernel: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "openrig-home-wiring-"));
  savedHome = process.env.OPENRIG_HOME;
  savedNoKernel = process.env.OPENRIG_NO_KERNEL;
  process.env.OPENRIG_HOME = tmpHome;
  process.env.OPENRIG_NO_KERNEL = "1"; // belt-and-suspenders; vitest already auto-skips
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENRIG_HOME;
  else process.env.OPENRIG_HOME = savedHome;
  if (savedNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
  else process.env.OPENRIG_NO_KERNEL = savedNoKernel;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeClaudePluginManifest(pluginDir: string, manifest: Record<string, unknown>) {
  const pluginDotDir = join(pluginDir, ".claude-plugin");
  mkdirSync(pluginDotDir, { recursive: true });
  writeFileSync(join(pluginDotDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

describe("plugin discovery honors OPENRIG_HOME (HG-1, HG-3, HG-4)", () => {
  it("scans <OPENRIG_HOME>/plugins and finds a plugin placed there", async () => {
    // Vendor a synthetic plugin at <OPENRIG_HOME>/plugins/example/
    const pluginDir = join(tmpHome, "plugins", "example");
    writeClaudePluginManifest(pluginDir, {
      name: "example",
      version: "0.1.0",
      description: "test plugin",
    });

    const { deps, db } = await createDaemon({ dbPath: ":memory:" });
    try {
      const service = deps.pluginDiscoveryService;
      expect(service).toBeDefined();
      const plugins = await service!.listPlugins({});
      const ids = plugins.map((p) => p.id);
      expect(ids).toContain("example");
    } finally {
      db.close();
    }
  });

  it("vendor + discovery resolve to the SAME OPENRIG_HOME-rooted path (path startsWith verification)", async () => {
    // Hardened symmetric-resolution check: assert the discovered
    // PluginEntry.path actually lives under <tmpHome>/plugins, not
    // just that an id with the same name appeared. A host with
    // ~/.openrig/plugins/openrig-core would otherwise let pre-fix
    // code satisfy the id-only assertion from the wrong root.
    //
    // Two layers of evidence:
    //   1. Synthetic plugin id (NOT 'openrig-core' — that name exists
    //      at the host default location on some operators' machines,
    //      so it wouldn't discriminate pre-fix vs post-fix code).
    //   2. PluginEntry.path startsWith <tmpHome>/plugins/<unique-id>.
    const uniqueId = `synthetic-cross-leak-${Date.now()}`;
    const pluginDir = join(tmpHome, "plugins", uniqueId);
    writeClaudePluginManifest(pluginDir, {
      name: uniqueId,
      version: "0.1.0",
      description: "cross-leak probe",
    });

    const { deps, db } = await createDaemon({ dbPath: ":memory:" });
    try {
      const plugins = await deps.pluginDiscoveryService!.listPlugins({});
      const entry = plugins.find((p) => p.id === uniqueId);
      expect(entry, `discovery should surface synthetic plugin ${uniqueId}`).toBeDefined();
      expect(entry!.source).toBe("vendored");
      // Path-startsWith proof: discovery resolved against tmpHome,
      // not the host's default ~/.openrig.
      expect(entry!.path.startsWith(join(tmpHome, "plugins"))).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("plugin-discovery-respects-openrig-home audit (HG-2, HG-5)", () => {
  // T5: static-grep audit — no hardcoded `homedir() ... .openrig ...
  // plugins` literal should remain in daemon src. Comments OK; runtime
  // path construction NOT OK. This test will fail if a future change
  // reintroduces the hardcoded path that velocity-qa VM dogfood
  // exposed.
  it("no daemon src file constructs the plugins path via homedir() literal", () => {
    const daemonSrcDir = resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const NEEDLE = /homedir\(\)\s*,\s*["']\.openrig["']\s*,\s*["']plugins["']/;
    const NEEDLE_PATH_JOIN = /path\.join\([^)]*homedir\(\)[^)]*\.openrig[^)]*plugins/;

    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf-8");
        // Strip line comments + block comments to avoid false positives
        // on documentation that mentions the legacy path.
        const stripped = text
          .split("\n")
          .map((line) => {
            const idx = line.indexOf("//");
            return idx === -1 ? line : line.slice(0, idx);
          })
          .join("\n")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        if (NEEDLE.test(stripped) || NEEDLE_PATH_JOIN.test(stripped)) {
          offenders.push(full.replace(daemonSrcDir + "/", ""));
        }
      }
    }
    walk(daemonSrcDir);
    if (offenders.length > 0) {
      throw new Error(
        `Daemon src files still construct plugins path via homedir() literal — must use getDefaultOpenRigPath('plugins') instead:\n  - ${offenders.join("\n  - ")}`,
      );
    }
    // Reference the unused import deliberately to silence lint
    void statSync;
    void dirname;
  });
});
