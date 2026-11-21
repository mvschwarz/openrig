// Read-only subprocess used by the TUI. No daemon, cache, credentials or lifecycle effects.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config-store.js";
import { decodeAllowlist, resolveAllowedDirectory, resolveAllowedPath, readAllowedFile, FilePathSafetyError } from "@openrig/daemon/local-reading";

export interface LocalRequest { op: "roots" | "list" | "read"; root?: string; path?: string }

export function localRead(request: LocalRequest) {
  const config = new ConfigStore().resolve();
  const roots = decodeAllowlist(config.files.allowlist);
  if (request.op === "roots") {
    const targets = [
      ["Project intent", config.workspace.root ? path.join(config.workspace.root, "SPEC.md") : "", "file"],
      ["Specs", config.workspace.specsRoot, "directory"],
      ["Projects", config.workspace.projectsRoot, "directory"],
      ["Missions and slices", config.workspace.slicesRoot, "directory"],
    ];
    return { source: "local configuration and disk", readAt: new Date().toISOString(),
      entries: targets.map(([label, source, kind]) => {
        let canonical = source!;
        try { canonical = process.platform === "win32" ? fs.realpathSync.native(source!) : fs.realpathSync(source!); } catch { /* the selected read reports the actual error */ }
        const root = [...roots].sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)
          .find((r) => canonical === r.canonicalPath || canonical.startsWith(r.canonicalPath.endsWith(path.sep) ? r.canonicalPath : r.canonicalPath + path.sep));
        return { label, kind, source, root: root?.name ?? "", path: root ? path.relative(root.canonicalPath, canonical) : "",
          ...(!source ? { error: "Source is not configured" } : !root ? { error: "Source is outside files.allowlist; no local read permitted" } : {}) };
      }),
    };
  }
  if (!request.root || typeof request.path !== "string") throw new Error("root and path required");
  if (request.op === "read") return readAllowedFile(roots, request.root, request.path);
  if (request.op !== "list") throw new Error("Unknown local read operation");
  const directory = resolveAllowedDirectory(roots, request.root, request.path);
  // Browse one selected directory at a time; never scan the workspace at startup.
  return { source: directory, readAt: new Date().toISOString(),
    entries: fs.readdirSync(directory, { withFileTypes: true }).filter((e) => !e.name.startsWith("."))
      .map((entry) => {
        const relative = path.join(request.path!, entry.name);
        try {
          const resolved = resolveAllowedPath(roots, request.root!, relative);
          const stat = fs.statSync(resolved);
          return { label: entry.name, root: request.root!, path: relative, source: resolved, kind: stat.isDirectory() ? "directory" : "file" };
        } catch (error) {
          return { label: entry.name, root: request.root!, path: relative, source: path.join(directory, entry.name), kind: "file", error: error instanceof Error ? error.message : String(error) };
        }
      }).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.label.localeCompare(b.label)),
  };
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try { return process.platform === "win32"
    ? fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
    : path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isDirectRun) {
  try { process.stdout.write(JSON.stringify(localRead(JSON.parse(process.argv[2] ?? "{}")))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof FilePathSafetyError ? error.code : "local_read_failed", message: error instanceof Error ? error.message : String(error) })); }
}
