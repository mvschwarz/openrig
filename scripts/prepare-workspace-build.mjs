import { chmodSync, copyFileSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
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

let invokedDirectly = false;
try { invokedDirectly = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
catch { /* Imported without an existing entry file. */ }
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  prepareWorkspaceBuild(root, process.argv[2]);
  if (process.argv[2] === "cli") {
    // Derive the piped/root-help artifact from the complete command tree at
    // build time, not a second hand-maintained command catalog at startup.
    const { createProgram } = await import(pathToFileURL(path.join(root, "packages/cli/dist/index.js")).href);
    let help = "";
    createProgram().configureHelp({ helpWidth: 80 }).configureOutput({ writeOut: text => { help += text; } }).outputHelp();
    writeFileSync(path.join(root, "packages/cli/dist/root-help.txt"), help);
  }
}
