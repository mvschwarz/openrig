import { win32 } from "node:path";
import { readPlatformEnv } from "./platform-env.js";
/** Windows helper runtime, independent of the interactive pane shell and PATH. */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env, lookup: "native" | "shell-bootstrap" = "native"): string {
  // A bootstrap entered through either Git Bash or PowerShell must remain a bare command.
  // It executes in the target shell's PATH, unlike the daemon's native helper processes.
  if (lookup === "shell-bootstrap") return "powershell.exe";
  return win32.join(readPlatformEnv(env, "SystemRoot", "win32") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
