import { parseWindowsCommandLine } from "../../src/adapters/windows-argv.js";
import { parseLiteralLaunchWords } from "../../src/adapters/windows-launch.js";

/** Inspect the typed command's actual data; never execute a fake terminal. */
export function runnerCommandArguments(command: string): string[] {
  const native = /^\$openrigStart\.Arguments = '((?:[^']|'')*)'\r?$/m.exec(command);
  return native ? parseWindowsCommandLine(native[1]!.replaceAll("''", "'")) : parseLiteralLaunchWords(command);
}

export function runnerCommandArgument(command: string, flag: string): string | undefined {
  const args = runnerCommandArguments(command);
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
