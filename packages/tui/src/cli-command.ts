import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve the CLI used for TUI prerequisite reads and interactive launches. */
export function resolveTuiCliEntry(env: NodeJS.ProcessEnv = process.env, moduleUrl: string = import.meta.url): string | undefined {
  const explicit = env["OPENRIG_TUI_CLI_ENTRY"];
  if (explicit || process.platform !== "win32") return explicit;
  // A standalone native TUI has no launcher-injected entry. npm's rig.cmd
  // cannot be execFile'd, so use the CLI paired with this TUI installation.
  // Workspace build and the assembled CLI have different sibling layouts.
  for (const relative of ["../../cli/dist/index.js", "../../dist/index.js"]) {
    const candidate = fileURLToPath(new URL(relative, moduleUrl));
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync.native(candidate);
    } catch { /* try the other supported installation layout */ }
  }
  return undefined;
}
