import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config-store.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";

it.runIf(process.platform === "win32").each(["cli", "daemon"] as const)("%s migrates existing native aliases of legacy workspace defaults", kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-legacy-alias-"));
  const alias = path.join(root, "alias");
  try {
    for (const name of ["OPENRIG_WORKSPACE_ROOT", "OPENRIG_WORKSPACE_SLICES_ROOT", "OPENRIG_WORKSPACE_STEERING_PATH"]) vi.stubEnv(name, undefined);
    const workspace = path.join(root, "physical");
    fs.mkdirSync(path.join(workspace, "slices"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "steering"));
    fs.mkdirSync(path.join(workspace, "custom"));
    fs.writeFileSync(path.join(workspace, "steering", "STEERING.md"), "owned legacy steering");
    fs.symlinkSync(workspace, alias, "junction");
    const file = path.join(root, "config.json");
    const save = (slicesRoot: string, steeringPath: string) => fs.writeFileSync(file, JSON.stringify({ workspace: { root: workspace, slicesRoot, steeringPath } }));
    const read = (key: string) => kind === "cli" ? new ConfigStore(file).resolveWithSource(key) : new SettingsStore(file).resolveOne(key);
    save(path.join(alias, "SLICES"), path.join(alias, "STEERING", "steering.md"));
    expect(read("workspace.slices_root")).toMatchObject({ source: "default", value: path.join(workspace, "missions") });
    expect(read("workspace.steering_path")).toMatchObject({ source: "default", value: path.join(workspace, "STEERING.md") });
    const custom = path.join(workspace, "custom");
    const missing = path.join(root, "missing", "steering.md");
    save(custom, missing);
    expect(read("workspace.slices_root")).toMatchObject({ source: "file", value: custom });
    expect(read("workspace.steering_path")).toMatchObject({ source: "file", value: missing });
  } finally {
    vi.unstubAllEnvs();
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
