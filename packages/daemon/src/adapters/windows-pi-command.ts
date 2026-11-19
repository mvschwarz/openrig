import { resolveWindowsCommand } from "../domain/windows-command.js";
export function resolveWindowsPiCommand(searchPath: string, nodeExecutable: string, cwd = process.cwd(), pathExt?: string): { command: string; prefix: string[] } {
  const selected = resolveWindowsCommand(["pi"], searchPath, pathExt, cwd, { packageName: "@earendil-works/pi-coding-agent", nodeExecutable });
  if (selected[0] === "pi") throw new Error("Pi was not found on the Windows runner PATH");
  return { command: selected[0]!, prefix: selected.slice(1) };
}
