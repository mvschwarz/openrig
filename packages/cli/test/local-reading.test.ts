import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localRead } from "../src/local-reading.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(tmpdir(), "rig-local-reading-")); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

it("matches a filesystem-root allowlist without doubling its trailing separator", () => {
  const workspace = path.join(home, "workspace"); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "SPEC.md"), "owned");
  const drive = path.parse(fs.realpathSync(home)).root;
  vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("OPENRIG_WORKSPACE_ROOT", workspace); vi.stubEnv("OPENRIG_FILES_ALLOWLIST", `drive:${drive}`);
  const roots = localRead({ op: "roots" }) as any;
  const canonical = process.platform === "win32" ? fs.realpathSync.native(path.join(workspace, "SPEC.md")) : fs.realpathSync(path.join(workspace, "SPEC.md"));
  expect(roots.entries[0]).toMatchObject({ root: "drive", path: path.relative(drive, canonical) });
  expect(roots.entries[0].error).toBeUndefined();
});
it.runIf(process.platform === "win32")("uses the actual casing for an allowlist and an internal file alias", () => {
  const workspace = path.join(home, "Workspace"); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "SPEC.md"), "owned alias bytes");
  fs.symlinkSync(path.join(workspace, "SPEC.md"), path.join(workspace, "alias.md"));
  vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("OPENRIG_WORKSPACE_ROOT", workspace.toLowerCase());
  for (const spelling of [workspace.toUpperCase(), path.toNamespacedPath(workspace)]) {
    vi.stubEnv("OPENRIG_FILES_ALLOWLIST", `workspace:${spelling}`);
    expect((localRead({ op: "roots" }) as any).entries[0]).toMatchObject({ root: "workspace", path: "SPEC.md" });
    expect(localRead({ op: "read", root: "workspace", path: "alias.md" })).toMatchObject({ resolvedPath: "SPEC.md", binary: false });
  }
});
it.runIf(process.platform === "win32")("executes the native local reader through a linked parent directory", () => {
  const workspace = path.join(home, "workspace"); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "SPEC.md"), "owned");
  const link = path.join(home, "reader parent");
  fs.symlinkSync(fileURLToPath(new URL("../src", import.meta.url)), link, "junction");
  try {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const output = execFileSync(process.execPath, ["--import", loader, path.join(link, "local-reading.ts"), JSON.stringify({ op: "roots" })], {
      env: { ...process.env, OPENRIG_HOME: home, OPENRIG_WORKSPACE_ROOT: workspace, OPENRIG_FILES_ALLOWLIST: `workspace:${workspace}` },
      encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    expect(JSON.parse(output).entries[0]).toMatchObject({ root: "workspace", path: "SPEC.md" });
  } finally { fs.unlinkSync(link); }
});

it("reads configured local sources with the HTTP reader's containment, binary and truncation contract", () => {
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(path.join(workspace, "missions", "example", "slices", "01-one"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "specs"));
  fs.writeFileSync(path.join(workspace, "SPEC.md"), "# Project\r\nCurrent local intent\n");
  fs.writeFileSync(path.join(home, "outside.md"), "must not read");
  fs.symlinkSync(path.join(home, "outside.md"), path.join(workspace, "escape.md"));
  fs.symlinkSync(path.join(workspace, "SPEC.md"), path.join(workspace, "alias.md"));
  fs.writeFileSync(path.join(workspace, "binary.md"), Buffer.from([0, 255, 42]));
  fs.writeFileSync(path.join(workspace, "large.md"), "x".repeat(1_048_577));
  vi.stubEnv("OPENRIG_HOME", home);
  vi.stubEnv("OPENRIG_WORKSPACE_ROOT", workspace);
  vi.stubEnv("OPENRIG_FILES_ALLOWLIST", `workspace:${workspace}`);
  const roots = localRead({ op: "roots" }) as any;
  expect(roots.entries.map((e: any) => e.label)).toEqual(["Project intent", "Specs", "Projects", "Missions and slices"]);
  expect(roots.entries[3]).toMatchObject({ root: "workspace", path: "missions" });
  const read = (name: string) => localRead({ op: "read", root: "workspace", path: name }) as any;
  expect(read("alias.md")).toMatchObject({ resolvedPath: "SPEC.md", binary: false, truncated: false });
  expect(read("binary.md").binary).toBe(true);
  expect(read("large.md")).toMatchObject({ truncated: true, truncatedAtBytes: 1_048_576, totalBytes: 1_048_577 });
  for (const name of ["escape.md", "../outside.md", "absent.md"]) expect(() => read(name)).toThrow();
  expect(() => localRead({ op: "list", root: "workspace", path: "../" })).toThrow();
  vi.stubEnv("OPENRIG_FILES_ALLOWLIST", `other:${path.join(home, "elsewhere")}`);
  expect((localRead({ op: "roots" }) as any).entries[0].error).toContain("outside files.allowlist");
});
