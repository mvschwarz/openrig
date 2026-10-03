import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import type { AgentImageManifest } from "../src/domain/agent-images/agent-image-types.js";

const failure = vi.hoisted(() => ({ enabled: false, path: "supplement.md" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (failure.enabled && String(args[0]).endsWith(failure.path)) {
      fs.writeFileSync(args[0], "partial");
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    }
    return fs.writeFileSync(...args);
  } };
});
let root: string | undefined;
afterEach(() => { failure.enabled = false; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
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
