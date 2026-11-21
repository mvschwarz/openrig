import { resolveWindowsCommand } from "./windows-command.js";
export function windowsCommunityCommand(words: string[], searchPath: string, pathExt = ".COM;.EXE;.BAT;.CMD", cwd?: string): string[] {
  return resolveWindowsCommand(words, searchPath, pathExt, cwd);
}
