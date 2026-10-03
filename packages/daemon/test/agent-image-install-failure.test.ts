import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import type { AgentImageManifest } from "../src/domain/agent-images/agent-image-types.js";

const failure = vi.hoisted(() => ({ enabled: false, path: "supplement.md", race: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, mkdirSync: ((...args: Parameters<typeof fs.mkdirSync>) => {
    if (failure.race && basename(String(args[0])) === "snapshot" && args[1] === undefined) {
      failure.race = false;
      fs.mkdirSync(args[0]);
      fs.writeFileSync(join(String(args[0]), "foreign.txt"), "other creator");
    }
    return fs.mkdirSync(...args);
  }) as typeof fs.mkdirSync, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (failure.enabled && String(args[0]).endsWith(failure.path)) {
      fs.writeFileSync(args[0], "partial");
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    }
    return fs.writeFileSync(...args);
  } };
});
let root: string | undefined;
afterEach(() => { failure.enabled = false; failure.race = false; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function manifest(): AgentImageManifest {
  return { name: "snapshot", version: "1", runtime: "claude-code", sourceSeat: "dev@fixture",
    sourceSessionId: "conversation", sourceResumeToken: "conversation", createdAt: new Date().toISOString(),
    files: [{ path: "supplement.md", role: "notes" }] };
}
it.each(["stats.json", "supplement.md", "manifest.yaml"])("cleans partial %s writes without publishing a snapshot and allows a clean retry", (path) => {
  root = mkdtempSync(join(tmpdir(), "openrig-image-failure-"));
  const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  failure.enabled = true; failure.path = path;
  expect(() => library.install(root!, manifest(), new Map([["supplement.md", "complete bytes"]]))).toThrow("fixture disk full");
  library.scan();
  expect.soft(library.list()).toEqual([]);
  expect.soft(existsSync(join(root, "snapshot"))).toBe(false);
  failure.enabled = false;
  const dir = library.install(root, manifest(), new Map([["supplement.md", "complete bytes"]]));
  expect(readFileSync(join(dir, "supplement.md"), "utf-8")).toBe("complete bytes");
  library.scan(); expect(library.list()).toHaveLength(1);
});

it("reports a concurrent creator without removing its directory", () => {
  root = mkdtempSync(join(tmpdir(), "openrig-image-race-"));
  const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  failure.race = true;
  try { library.install(root, manifest(), new Map()); throw new Error("install unexpectedly succeeded"); }
  catch (error) { expect(error).toMatchObject({ name: "AgentImageError", code: "image_referenced" }); }
  expect(readFileSync(join(root, "snapshot", "foreign.txt"), "utf-8")).toBe("other creator");
  expect(existsSync(join(root, "snapshot", "stats.json"))).toBe(false);
  expect(existsSync(join(root, "snapshot", "manifest.yaml"))).toBe(false);
});
