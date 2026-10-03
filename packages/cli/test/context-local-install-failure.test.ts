import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextCommand } from "../src/commands/context.js";
import { ContextPackLibraryService } from "../../daemon/src/domain/context-packs/context-pack-library-service.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
const failure = vi.hoisted(() => ({ enabled: false, observe: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, cpSync: (...args: Parameters<typeof fs.cpSync>) => {
    if (failure.enabled) {
      const target = String(args[1]); fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(join(String(args[0]), "manifest.yaml"), join(target, "manifest.yaml"));
      failure.observe?.();
      throw Object.assign(new Error("fixture partial copy failed"), { code: "EIO" });
    }
    return fs.cpSync(...args);
  } };
});
let root: string | undefined;
afterEach(() => { failure.enabled = false; failure.observe = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined;
  if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
it("does not retain a partial local pack or sync it and allows a clean retry", async () => {
  root = mkdtempSync(join(tmpdir(), "openrig-local-pack-failure-"));
  const source = join(root, "source"); const library = join(root, "library");
  mkdirSync(source); mkdirSync(library);
  const manifest = "name: fixture\nversion: \"1\"\ntaxonomy: world\nfiles:\n  - path: notes.md\n    role: notes\n";
  writeFileSync(join(source, "manifest.yaml"), manifest); writeFileSync(join(source, "notes.md"), "complete bytes");
  vi.stubEnv("OPENRIG_CONTEXT_ROOT", library);
  const post = vi.fn(async () => ({ status: 200, data: { count: 1, entries: [] } }));
  const deps = { lifecycleDeps: { exists: (p: string) => p === STATE_FILE,
    readFile: () => JSON.stringify({ pid: process.pid, port: 7433, db: "fixture", startedAt: new Date().toISOString() }),
    isProcessAlive: () => true, fetch: async () => ({ ok: true }) } as never,
    clientFactory: () => ({ post }) as never };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const discovery = new ContextPackLibraryService({ roots: [{ path: library, sourceType: "user_file" }] });
  const visibleDuringCopy: string[] = [];
  const errorsDuringCopy: Array<{ source: string; error: string }> = [];
  failure.observe = () => { errorsDuringCopy.push(...discovery.scan().errors); visibleDuringCopy.push(...discovery.list().map((pack) => pack.ref)); };
  failure.enabled = true;
  await contextCommand(deps).parseAsync(["add", source], { from: "user" });
  expect(process.exitCode).toBe(1); expect(error.mock.calls.flat().join(" ")).toContain("fixture partial copy failed");
  expect.soft(visibleDuringCopy).toEqual([]);
  expect.soft(errorsDuringCopy).toEqual([]);
  expect.soft(readdirSync(library)).toEqual([]); expect(post).not.toHaveBeenCalled();
  expect(readFileSync(join(source, "notes.md"), "utf-8")).toBe("complete bytes");
  failure.enabled = false; process.exitCode = undefined; error.mockClear();
  await contextCommand(deps).parseAsync(["add", source, "--json"], { from: "user" });
  expect(process.exitCode).toBeUndefined(); expect(error).not.toHaveBeenCalled();
  expect(readFileSync(join(library, "fixture", "notes.md"), "utf-8")).toBe("complete bytes");
  await contextCommand(deps).parseAsync(["add", source, "--name", "group/fixture", "--json"], { from: "user" });
  expect(process.exitCode).toBeUndefined(); expect(error).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(library, "group/fixture", "notes.md"), "utf-8")).toBe("complete bytes");
  expect(readdirSync(library).sort()).toEqual(["fixture", "group"]);
  expect(discovery.scan()).toEqual({ count: 2, errors: [] });
  // Skip only the installer prefix, not every invalid or hidden directory.
  const unrelatedInvalid = join(library, ".not-a-pack");
  mkdirSync(unrelatedInvalid); writeFileSync(join(unrelatedInvalid, "manifest.yaml"), manifest);
  const scan = discovery.scan();
  expect(scan.count).toBe(2);
  expect(scan.errors).toHaveLength(1);
  expect(scan.errors[0]!.source).toBe(unrelatedInvalid);
  expect(scan.errors[0]!.error).toContain("unsafe pack ref");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("installs into a writable library without requiring its parent to be writable", async () => {
  root = mkdtempSync(join(tmpdir(), "openrig-local-pack-permission-"));
  const source = join(root, "source"), library = join(root, "library");
  mkdirSync(source); mkdirSync(library); chmodSync(library, 0o700);
  writeFileSync(join(source, "manifest.yaml"), 'name: fixture\nversion: "1"\ntaxonomy: world\nfiles:\n  - path: notes.md\n    role: notes\n');
  writeFileSync(join(source, "notes.md"), "complete bytes");
  vi.stubEnv("OPENRIG_CONTEXT_ROOT", library);
  const post = vi.fn(async () => ({ status: 200, data: { count: 1, entries: [] } }));
  const deps = { lifecycleDeps: { exists: (p: string) => p === STATE_FILE,
    readFile: () => JSON.stringify({ pid: process.pid, port: 7433, db: "fixture", startedAt: new Date().toISOString() }),
    isProcessAlive: () => true, fetch: async () => ({ ok: true }) } as never,
    clientFactory: () => ({ post }) as never };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  chmodSync(root, 0o500);
  try {
    await contextCommand(deps).parseAsync(["add", source, "--json"], { from: "user" });
    expect.soft(errors.mock.calls.flat().join(" ")).toBe("");
    expect.soft(process.exitCode).toBeUndefined();
    expect.soft(post).toHaveBeenCalledOnce();
    expect.soft(readdirSync(library)).toEqual(["fixture"]);
    if (readdirSync(library).includes("fixture")) expect(readFileSync(join(library, "fixture", "notes.md"), "utf-8")).toBe("complete bytes");
  } finally { chmodSync(root, 0o700); }
});
