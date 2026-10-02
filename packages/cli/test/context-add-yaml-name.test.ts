import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { contextCommand } from "../src/commands/context.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

it.each([
  "name: desired",
  "name: desired # inline comment",
  'name: "desired" # inline comment',
  "name: >-\n  desired",
])("installs the parsed manifest name from %s", async (name) => {
  const root = mkdtempSync(join(tmpdir(), "openrig-yaml-name-"));
  const source = join(root, "different-source-name");
  const target = join(root, "store");
  mkdirSync(source);
  writeFileSync(join(source, "manifest.yaml"), `${name}\nversion: 1\ntaxonomy: world\npurpose: fixture\nfiles:\n  - path: notes.md\n    role: notes\n`);
  writeFileSync(join(source, "notes.md"), "preserved bytes");
  vi.stubEnv("OPENRIG_CONTEXT_ROOT", target);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const post = vi.fn(async () => ({ status: 200, data: { count: 1, entries: [], errors: [] } }));
  const deps: StatusDeps = {
    lifecycleDeps: {
      readFile: (path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "fixture" }) : null,
      exists: (path: string) => path === STATE_FILE, isProcessAlive: () => true,
      fetch: async () => ({ ok: true }),
    } as StatusDeps["lifecycleDeps"],
    clientFactory: () => ({ post }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
  try {
    const program = new Command();
    program.addCommand(contextCommand(deps));
    await program.parseAsync(["node", "rig", "context", "add", source, "--json"]);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).installedAt).toBe(join(target, "desired"));
    expect(readFileSync(join(target, "desired", "notes.md"), "utf8")).toBe("preserved bytes");
    expect(existsSync(join(target, "different-source-name"))).toBe(false);
    expect(post).toHaveBeenCalledOnce();
  } finally {
    output.mockRestore(); error.mockRestore(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
