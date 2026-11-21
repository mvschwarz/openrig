import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { expect, it } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

it.runIf(process.platform === "win32").each([
  { outside: false, nested: false }, { outside: true, nested: false },
  { outside: false, nested: true }, { outside: true, nested: true },
])("authors a bundle with a native plugin junction (%j)", async ({ outside, nested }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-author-native-"));
  const db = createFullTestDb();
  let alias: string | undefined;
  try {
    const source = path.join(root, "source");
    const target = path.join(outside ? root : source, "payload");
    fs.mkdirSync(path.join(source, "agents/impl"), { recursive: true });
    fs.mkdirSync(path.join(source, "plugins"));
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "owned.txt"), "owned plugin fixture\n");
    fs.writeFileSync(path.join(source, "agents/impl/agent.yaml"),
      'name: impl-agent\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n');
    const specPath = path.join(source, "rig.yaml");
    fs.writeFileSync(specPath, 'version: "0.2"\nname: native-author\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []\n');
    if (nested) fs.mkdirSync(path.join(source, "plugins/owned"));
    alias = path.join(source, nested ? "plugins/owned/inner" : "plugins/owned");
    fs.symlinkSync(fs.realpathSync.native(target).toUpperCase(), alias, "junction");
    fs.writeFileSync(path.join(source, "bundle.yaml"), 'plugins:\n  - id: owned\n    source:\n      kind: local\n      path: plugins/owned\n');
    const outputPath = path.join(root, "owned.rigbundle");
    const app = createTestApp(db).app;
    const response = await app.request("/api/bundles/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rigRoot: source, outputPath, bundleName: "native-author", bundleVersion: "0.1.0" }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(outside ? 500 : 201);
    if (outside) {
      expect(body.error).toMatch(/outside bundle source root|escaping bundle source root|symlink escape/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } else {
      const extracted = path.join(root, "extracted"); fs.mkdirSync(extracted);
      await tar.extract({ file: outputPath, cwd: extracted });
      expect(fs.readFileSync(path.join(extracted, nested ? "plugins/owned/inner/owned.txt" : "plugins/owned/owned.txt"), "utf8")).toBe("owned plugin fixture\n");
      expect(fs.lstatSync(path.join(extracted, "plugins/owned")).isSymbolicLink()).toBe(false);
      if (nested) expect(fs.lstatSync(path.join(extracted, "plugins/owned/inner")).isSymbolicLink()).toBe(false);
    }
    expect(fs.readFileSync(path.join(target, "owned.txt"), "utf8")).toBe("owned plugin fixture\n");
  } finally {
    db.close();
    if (alias && fs.existsSync(alias)) fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
