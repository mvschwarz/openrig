import { chmodSync, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Finish a compiled workspace with the same assets/modes on every host. */
export function prepareWorkspaceBuild(root, workspace, platform = process.platform) {
  if (workspace !== "cli" && workspace !== "tui") throw new Error(`Unknown workspace: ${workspace}`);
  const dir = path.join(root, "packages", workspace);
  const entry = path.join(dir, "dist", workspace === "cli" ? "bin-wrapper.js" : "main.js");
  const mode = statSync(entry).mode;
  if (platform !== "win32") chmodSync(entry, mode | 0o111);
  if (workspace === "tui") return;
  for (const [source, target, extension] of [
    ["src/schemas", "dist/schemas", ".json"],
    ["src/lib/scope-templates", "dist/lib/scope-templates", ".md"],
  ]) {
    const destination = path.join(dir, target);
    mkdirSync(destination, { recursive: true });
    let copied = 0;
    for (const item of readdirSync(path.join(dir, source), { withFileTypes: true })) {
      if (item.name.startsWith(".") || !item.name.endsWith(extension)) continue;
      const file = path.join(dir, source, item.name);
      if (item.isFile() || (item.isSymbolicLink() && statSync(file).isFile())) {
        copyFileSync(file, path.join(destination, item.name));
        copied++;
      }
    }
    if (!copied) throw new Error(`No ${extension} files matched in ${source}`);
  }
  for (const name of ["LICENSE", "README.md"]) copyFileSync(path.join(root, name), path.join(dir, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  prepareWorkspaceBuild(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), process.argv[2]);
