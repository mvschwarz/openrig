import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { unpack } from "../src/domain/bundle-archive.js";
import { materializePodBundle } from "../src/domain/bundle-source-resolver.js";

// A pod bundle copies agent packages and declared rig files verbatim. Every byte must survive
// create -> archive -> install, whether or not the file is UTF-8 text.

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function pseudoRandom(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const PAYLOADS: Record<string, Buffer> = {
  "agents/impl/assets/random.bin": pseudoRandom(4096, 7),
  "agents/impl/assets/logo.png": Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(Array.from({ length: 128 }, (_, i) => 128 + i))]),
  "agents/impl/assets/nul.dat": Buffer.from([0x61, 0x00, 0x62, 0x00, 0x00, 0x63]),
  "agents/impl/assets/invalid-utf8.txt": Buffer.from([0x6f, 0x6b, 0x20, 0xc3, 0x28, 0x20, 0xa0, 0xa1, 0x20, 0xff]),
  "agents/impl/assets/empty.txt": Buffer.alloc(0),
  "agents/impl/skills/greet/SKILL.md": Buffer.from("Greet ü 漢 😀\r\nCRLF line\r\nno trailing newline", "utf8"),
  "startup/blob.bin": Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0x80, 0x00, 0xc0]),
};

const AGENT_YAML = [
  'name: impl',
  'version: "1.0.0"',
  "resources:",
  "  skills:",
  "    - id: greet",
  "      path: skills/greet",
  "profiles:",
  "  default:",
  "    uses:",
  "      skills: [greet]",
].join("\n");

const RIG_YAML = [
  'version: "0.2"',
  "name: bytes-rig",
  "pods:",
  "  - id: dev",
  "    label: Dev",
  "    members:",
  "      - id: impl",
  '        agent_ref: "local:agents/impl"',
  "        profile: default",
  "        runtime: claude-code",
  "        cwd: .",
  "        startup:",
  "          files:",
  "            - path: startup/blob.bin",
  "          actions: []",
  "    edges: []",
  "edges: []",
].join("\n");

describe("pod bundle byte preservation (create -> archive -> install)", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-bytes-"));
    app = createTestApp(db).app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("keeps executable and restrictive modes through create and install", async () => {
    const src = path.join(tmpDir, "mode-source");
    fs.mkdirSync(path.join(src, "agents/impl/bin"), { recursive: true });
    fs.writeFileSync(path.join(src, "agents/impl/agent.yaml"), AGENT_YAML);
    fs.writeFileSync(path.join(src, "rig.yaml"), RIG_YAML);
    fs.mkdirSync(path.join(src, "startup"));
    fs.writeFileSync(path.join(src, "startup/blob.bin"), PAYLOADS["startup/blob.bin"]!);
    fs.mkdirSync(path.join(src, "agents/impl/skills/greet"), { recursive: true });
    fs.writeFileSync(path.join(src, "agents/impl/skills/greet/SKILL.md"), "# Greet");
    const modes = [0o700, 0o750, 0o755, 0o600];
    for (const mode of modes) {
      const file = path.join(src, "agents/impl/bin", `${mode.toString(8)}.sh`);
      fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(file, mode);
    }

    const outputPath = path.join(tmpDir, "modes.rigbundle");
    const created = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: path.join(src, "rig.yaml"), rigRoot: src, bundleName: "modes", bundleVersion: "0.1.0", outputPath }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const extracted = path.join(tmpDir, "mode-extracted");
    await unpack(outputPath, extracted);
    const target = path.join(tmpDir, "mode-installed");
    fs.mkdirSync(target);
    expect(materializePodBundle(extracted, target)).toEqual({ ok: true });
    for (const mode of modes) {
      const relative = path.join("agents/impl/bin", `${mode.toString(8)}.sh`);
      expect(fs.statSync(path.join(extracted, relative)).mode & 0o777, `${relative} archived`).toBe(mode);
      expect(fs.statSync(path.join(target, relative)).mode & 0o777, `${relative} installed`).toBe(mode);
    }
  });

  it("keeps binary, non-UTF-8, NUL, empty and multibyte files byte-identical, with truthful integrity", async () => {
    const src = path.join(tmpDir, "src");
    for (const [rel, bytes] of Object.entries(PAYLOADS)) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), bytes);
    }
    fs.writeFileSync(path.join(src, "agents/impl/agent.yaml"), AGENT_YAML);
    fs.writeFileSync(path.join(src, "rig.yaml"), RIG_YAML);
    const sourceBefore = Object.fromEntries(Object.keys(PAYLOADS).map((rel) => [rel, sha(fs.readFileSync(path.join(src, rel)))]));

    const outputPath = path.join(tmpDir, "bytes.rigbundle");
    const created = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: path.join(src, "rig.yaml"), rigRoot: src, bundleName: "bytes", bundleVersion: "0.1.0", outputPath }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await created.json()).schemaVersion).toBe(2);

    // Source assets stay untouched.
    for (const rel of Object.keys(PAYLOADS)) {
      expect(sha(fs.readFileSync(path.join(src, rel))), rel).toBe(sourceBefore[rel]);
    }

    // Archive: every copied file equals its source, and the manifest hashes the source bytes.
    const extracted = path.join(tmpDir, "extracted");
    fs.mkdirSync(extracted);
    await unpack(outputPath, extracted);
    const manifest = fs.readFileSync(path.join(extracted, "bundle.yaml"), "utf8");
    for (const [rel, bytes] of Object.entries(PAYLOADS)) {
      const archived = fs.readFileSync(path.join(extracted, rel));
      expect(archived.equals(bytes), `${rel} in archive`).toBe(true);
      expect(manifest, `${rel} integrity hash`).toContain(`${rel}: ${sha(bytes)}`);
    }

    const inspected = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: outputPath }),
    });
    const view = await inspected.json();
    expect(view.digestValid).toBe(true);
    expect(view.integrityResult.passed).toBe(true);

    // Install: the materialized target holds the source bytes.
    const target = path.join(tmpDir, "target");
    fs.mkdirSync(target);
    expect(materializePodBundle(extracted, target)).toEqual({ ok: true });
    for (const [rel, bytes] of Object.entries(PAYLOADS)) {
      expect(fs.readFileSync(path.join(target, rel)).equals(bytes), `${rel} installed`).toBe(true);
    }
  });
});
