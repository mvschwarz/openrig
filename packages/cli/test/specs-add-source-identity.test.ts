import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { specsCommand } from "../src/commands/specs.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

let root: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

async function install(mode: "foreign-first" | "foreign-only" | "hardlink-first" | "duplicate" | "case-alias", directory = false) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-spec-source-"));
  const home = path.join(root, "home"), source = path.join(root, directory ? "owned-pack" : "owned.yaml");
  const yaml = 'name: owned\nversion: "1"\npods: []\nedges: []\n';
  if (directory) fs.mkdirSync(source);
  fs.writeFileSync(directory ? path.join(source, "rig.yaml") : source, yaml);
  vi.stubEnv("OPENRIG_HOME", home);
  const installed = directory ? path.join(home, "specs", "owned-pack", "rig.yaml") : path.join(home, "specs", "owned.yaml");
  const foreign = directory ? path.join(root, "foreign", "owned-pack", "rig.yaml") : path.join(root, "foreign", "owned.yaml");
  const entry = (id: string, sourcePath: string) => ({ id, name: "owned", kind: "rig", sourcePath });
  const post = vi.fn(async (route: string) => {
    if (route === "/api/specs/review/rig") return { status: 200, data: { name: "owned" } };
    if (route !== "/api/specs/library/sync") throw new Error("Unexpected route");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    if (mode === "hardlink-first") fs.linkSync(installed, foreign); else fs.writeFileSync(foreign, yaml);
    const owned = entry("owned-id", mode === "case-alias" ? installed.toUpperCase() : installed);
    const data = mode === "foreign-only" ? [entry("foreign-id", foreign)]
      : mode === "duplicate" ? [owned, entry("duplicate-id", installed)] : mode === "case-alias" ? [owned]
      : [entry("foreign-id", foreign), owned];
    return { status: 200, data };
  });
  const deps = { lifecycleDeps: { exists: (file: string) => file === STATE_FILE,
    readFile: () => JSON.stringify({ pid: process.pid, port: 7433, db: "owned", startedAt: new Date().toISOString() }),
    isProcessAlive: () => true, fetch: async () => ({ ok: true }) } as never,
    clientFactory: () => ({ post }) as never };
  const logs = vi.spyOn(console, "log").mockImplementation(() => {}), errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await specsCommand(deps).parseAsync(["add", source, "--json"], { from: "user" });
  expect(errors).not.toHaveBeenCalled(); expect(process.exitCode).toBeUndefined();
  expect(fs.readFileSync(installed, "utf8")).toBe(yaml);
  return JSON.parse(String(logs.mock.calls.at(-1)?.[0]));
}

it.each(["foreign-first", "hardlink-first"] as const)("specs add reports the installed location despite a %s same-name entry", async mode => {
  expect(await install(mode)).toMatchObject({ id: "owned-id", entry: { id: "owned-id" } });
});
it.each(["foreign-only", "duplicate"] as const)("specs add leaves registration unconfirmed for %s source matches", async mode => {
  expect(await install(mode)).toMatchObject({ id: null, entry: null });
});
it("directory spec installation identifies its installed root YAML", async () => {
  expect(await install("foreign-first", true)).toMatchObject({ id: "owned-id" });
});
it.runIf(process.platform === "win32")("native installed source identity accepts actual filesystem case aliases", async () => {
  expect(await install("case-alias")).toMatchObject({ id: "owned-id" });
});
