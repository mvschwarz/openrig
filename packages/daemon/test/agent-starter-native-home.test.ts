import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStarterResolver } from "../src/domain/agent-starter-resolver.js";

it.runIf(process.platform === "win32")("resolves a starter from the supplied native profile and mixed-case registry override", () => {
  const root = mkdtempSync(join(tmpdir(), "starter-native-home-"));
  const profile = join(root, "用户 profile"), registry = join(profile, ".openrig", "agent-starters");
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, "sample.yaml"), "starter_id: sample\nsummary: synthetic fixture\n");
  try {
    const exists = (file: string) => file.startsWith(root) && existsSync(file);
    for (const env of [{ userprofile: profile }, { openrig_agent_starter_root: registry, HOME: "unused" }]) {
      const resolver = new AgentStarterResolver({ env, exists });
      expect(resolver.getRegistryRoot()).toBe(registry);
      expect(resolver.resolveStarter("sample").files).toEqual([expect.objectContaining({
        path: "sample.yaml", absolutePath: join(registry, "sample.yaml"), ownerRoot: registry,
      })]);
    }
    const explicit = new AgentStarterResolver({ registryRoot: registry, env: { OPENRIG_AGENT_STARTER_ROOT: "unused" }, exists });
    expect(explicit.resolveStarter("sample").registryPath).toBe(join(registry, "sample.yaml"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("reads the owned starter registry under USERPROFILE when HOME is empty", () => {
  const root = mkdtempSync(join(tmpdir(), "starter-profile-用户-"));
  const registry = join(root, ".openrig", "agent-starters");
  mkdirSync(registry, { recursive: true });
  const file = join(registry, "owned.yaml");
  writeFileSync(file, "starter_id: owned\r\nsummary: synthetic local starter\r\n");
  try {
    const resolver = new AgentStarterResolver({ env: { Home: "", UserProfile: root } });
    expect(resolver.getRegistryRoot()).toBe(registry);
    const result = resolver.resolveStarter("owned");
    expect(result.registryPath).toBe(file);
    expect(result.files).toEqual([expect.objectContaining({ absolutePath: file, ownerRoot: registry, required: true })]);
    expect(new AgentStarterResolver({ registryRoot: root, env: { HOME: "", USERPROFILE: root } }).getRegistryRoot()).toBe(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
