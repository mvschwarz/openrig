import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveMissionsRoot } from "../src/lib/scope/scope-fs.js";

it.runIf(process.platform === "win32")("resolves an explicitly named missions directory through native casing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-missions-case-"));
  try {
    vi.stubEnv("OPENRIG_WORK_ROOT", undefined);
    const missions = path.join(root, "missions");
    fs.mkdirSync(missions);
    fs.mkdirSync(path.join(root, "configured"));
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { slicesRoot: path.join(root, "configured") } }));
    for (const name of ["MISSIONS", "Missions"]) {
      const override = path.join(root, name);
      expect(resolveMissionsRoot({ override, configPath, strictOverride: true })).toBe(override);
      expect(resolveMissionsRoot({ override, configPath })).toBe(override);
      vi.stubEnv("OPENRIG_WORK_ROOT", override);
      expect(resolveMissionsRoot({ configPath, strictOverride: true })).toBe(override);
      vi.stubEnv("OPENRIG_WORK_ROOT", undefined);
    }
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
