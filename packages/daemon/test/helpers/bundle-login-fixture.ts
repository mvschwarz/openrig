import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { expect } from "vitest";
import { pack } from "../../src/domain/bundle-archive.js";
import type { IntegrityFsOps } from "../../src/domain/bundle-integrity.js";

export const LOGIN_FILES = [".claude/.credentials.json", ".codex/auth.json", ".pi/agent/auth.json"];
export const MARKER = "SYNTHETIC_LOGIN_FIXTURE_ONLY";
export const RIG = `version: "0.2"
name: login-fixture
pods:
  - id: dev
    label: Dev
    members:
      - { id: worker, runtime: codex, agent_ref: "local:agents/worker", profile: default, cwd: . }
    edges: []
edges: []
`;
export const AGENT = 'name: worker\nversion: "1.0"\nprofiles:\n  default: {}\n';

export function put(root: string, relative: string, content = MARKER): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o644 });
}

export function author(root: string): string {
  put(root, "rig.yaml", RIG);
  put(root, "agents/worker/agent.yaml", AGENT);
  return path.join(root, "rig.yaml");
}

export function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(root, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]).sort();
}

export const integrityFs: IntegrityFsOps = {
  readFile: file => fs.readFileSync(file, "utf8"), readFileBuffer: file => fs.readFileSync(file),
  writeFile: (file, content) => fs.writeFileSync(file, content), exists: fs.existsSync, walkFiles: walk,
};

/** A correctly hashed archive made before the login-path policy existed; no new create check is bypassed. */
export async function existingArchive(root: string, paths = LOGIN_FILES.map(file => `agents/worker/${file}`), recorded?: unknown, schemaVersion: 1 | 2 = 2) {
  const staging = path.join(root, "staging");
  author(staging);
  for (const file of paths) put(staging, file);
  const integrity = { algorithm: "sha256" as const, files: Object.fromEntries(walk(staging)
    .map(file => [file, createHash("sha256").update(fs.readFileSync(path.join(staging, file))).digest("hex")])) };
  const manifest = { schema_version: schemaVersion, name: "login-fixture", version: "1.0", created_at: "2026-01-01T00:00:00Z",
    rig_spec: "rig.yaml", ...(recorded !== undefined ? { included_login_files: recorded } : {}), ...(schemaVersion === 1 ? { packages: [{ name: "worker", version: "1.0", path: "agents/worker", original_source: "local:agents/worker" }] } : {}), agents: [{ name: "worker", version: "1.0", path: "agents/worker",
      original_ref: "local:agents/worker", hash: "0".repeat(64), import_entries: [] }], integrity };
  put(staging, "bundle.yaml", stringify(manifest));
  const archive = path.join(root, "existing.rigbundle");
  await pack(staging, archive);
  return { archive, staging, integrity };
}

export function expectLoginMessage(message: string, file: string): void {
  expect(message).toContain(file);
  expect(message).toMatch(/harness login file/i);
  expect(message).toMatch(/anyone with the bundle could read/i);
  expect(message).toMatch(/remove it from the agent folder/i);
  expect(message).toMatch(/carried project/i);
  expect(message).toMatch(/build.*again/i);
  expect(message).toContain("--include-login-files");
  expect(message).toContain("only if recipients should have this login");
  expect(message).toContain("internal test bundle");
  expect(message).toContain("its owner agrees");
  expect(message).not.toContain(MARKER);
}
