// The workspace context-pack root (`<workspace>/.openrig/context-packs`) is a
// discovery root even when it doesn't exist yet at daemon start. A pack added
// there later must appear after `POST /library/sync`, without a restart.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = ["OPENRIG_HOME", "OPENRIG_WORKSPACE_ROOT", "OPENRIG_CONTEXT_ROOT"];
const REF = "late-workspace-pack";

describe("workspace context-pack root and library sync", () => {
  const saved: Record<string, string | undefined> = {};
  let base: string;
  let workspacePacksRoot: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pack-root-sync-"));
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.OPENRIG_HOME = path.join(base, "home");
    fs.mkdirSync(process.env.OPENRIG_HOME, { recursive: true });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    const caseDir = fs.mkdtempSync(path.join(base, "case-"));
    const workspace = path.join(caseDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    workspacePacksRoot = path.join(workspace, ".openrig", "context-packs");
    process.env.OPENRIG_WORKSPACE_ROOT = workspace;
    process.env.OPENRIG_CONTEXT_ROOT = path.join(caseDir, "context");
  });

  function writeWorkspacePack(): void {
    const packDir = path.join(workspacePacksRoot, REF);
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "world.md"), "# Late workspace pack\n");
    fs.writeFileSync(
      path.join(packDir, "manifest.yaml"),
      `name: ${REF}\nversion: "1"\ntaxonomy: world\npurpose: Late pack fixture\nfiles:\n  - path: world.md\n    role: world\n`,
    );
  }

  async function addPackThenSync(): Promise<void> {
    const { createDaemon } = await import("../src/startup.js");
    const { app, db } = await createDaemon({ dbPath: ":memory:" });
    try {
      const url = `/api/context-packs/library/by-ref?ref=${encodeURIComponent(REF)}`;
      expect((await app.request(url)).status).toBe(404);

      writeWorkspacePack();
      const sync = await app.request("/api/context-packs/library/sync", { method: "POST" });
      expect(sync.status).toBe(200);

      const res = await app.request(url);
      expect(res.status).toBe(200);
      const entry = (await res.json()) as { name: string; sourceType: string };
      expect(entry).toMatchObject({ name: REF, sourceType: "workspace" });
    } finally {
      db.close();
    }
  }

  it("finds a pack added after startup when the root was absent at startup", async () => {
    expect(fs.existsSync(workspacePacksRoot)).toBe(false);
    await addPackThenSync();
  });

  it("finds a pack added after startup when the empty root existed at startup", async () => {
    fs.mkdirSync(workspacePacksRoot, { recursive: true });
    await addPackThenSync();
  });
});
