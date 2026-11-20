// Vendoring copies a bundled plugin into ~/.openrig/plugins byte for byte, binary files included: a plugin's icon.png
// must arrive exactly as it ships, and a text file must arrive as it always did.
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { nodePluginVendorFs, PluginVendorService } from "../src/domain/plugin-vendor-service.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A PNG header and bytes that aren't valid UTF-8, so a text round trip would change them. */
const ICON = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28, 0xa0, 0xa1])]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const httpClient = async () => ({ ok: false, status: 404 });

function scratch(): { assets: string; plugins: string } {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-vendor-binary-"));
  dirs.push(root);
  return { assets: nodePath.join(root, "assets"), plugins: nodePath.join(root, "home", "plugins") };
}

function shipPlugin(assets: string, version: string, icon = ICON): void {
  const plugin = nodePath.join(assets, "openrig");
  fs.mkdirSync(nodePath.join(plugin, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(nodePath.join(plugin, "skills", "demo"), { recursive: true });
  fs.writeFileSync(nodePath.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "openrig", version, description: "Team — work" }));
  fs.writeFileSync(nodePath.join(plugin, ".claude-plugin", "icon.png"), icon);
  fs.writeFileSync(nodePath.join(plugin, "skills", "demo", "SKILL.md"), "# Demo — a skill\n");
  fs.writeFileSync(nodePath.join(plugin, "skills", "demo", "badge.png"), icon);
}

const service = (assets: string, plugins: string) =>
  new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: plugins, fs: nodePluginVendorFs(), httpClient });

describe("vendoring a plugin with a binary file", () => {
  it("installs the icon byte for byte, and its text files as before", async () => {
    const { assets, plugins } = scratch();
    shipPlugin(assets, "0.1.0");
    await service(assets, plugins).ensureVendored("openrig");
    const installed = fs.readFileSync(nodePath.join(plugins, "openrig", ".claude-plugin", "icon.png"));
    expect(sha(installed)).toBe(sha(ICON));
    expect(fs.readFileSync(nodePath.join(plugins, "openrig", "skills", "demo", "SKILL.md"), "utf-8")).toBe("# Demo — a skill\n");
  });

  it("leaves an identical install alone at the same version, and refreshes a newer one exactly, keeping the old bytes", async () => {
    const { assets, plugins } = scratch();
    shipPlugin(assets, "0.1.0");
    await service(assets, plugins).ensureVendored("openrig");
    await service(assets, plugins).ensureVendored("openrig");
    const backups = nodePath.join(nodePath.dirname(plugins), "backups");
    expect(fs.existsSync(backups)).toBe(false);

    const newer = Buffer.concat([ICON, Buffer.from([0xfd, 0xbe])]);
    fs.rmSync(assets, { recursive: true });
    shipPlugin(assets, "0.2.0", newer);
    await service(assets, plugins).ensureVendored("openrig");
    expect(sha(fs.readFileSync(nodePath.join(plugins, "openrig", ".claude-plugin", "icon.png")))).toBe(sha(newer));
    const kept = fs.readdirSync(nodePath.join(backups, "managed-refresh"))
      .map((id) => nodePath.join(backups, "managed-refresh", id, ".claude-plugin", "icon.png"))
      .filter((path) => fs.existsSync(path));
    expect(kept.map((path) => sha(fs.readFileSync(path)))).toEqual([sha(ICON)]);
  });

  it("projects a skill's binary file into a global skill root byte for byte", () => {
    const { assets, plugins } = scratch();
    shipPlugin(assets, "0.1.0");
    const root = nodePath.join(nodePath.dirname(plugins), "global-skills");
    service(assets, plugins).ensureSkillDirGlobally(nodePath.join(assets, "openrig", "skills", "demo"), "demo", "0.1.0", [root]);
    expect(sha(fs.readFileSync(nodePath.join(root, "demo", "badge.png")))).toBe(sha(ICON));
    expect(fs.readFileSync(nodePath.join(root, "demo", "SKILL.md"), "utf-8")).toBe("# Demo — a skill\n");
  });
});
