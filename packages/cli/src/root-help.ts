import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RunProgramIo } from "./cli-error.js";

/** Build-derived complete command help, without loading command dependencies. */
export function serveBuiltRootHelp(argv: readonly string[], entryPath: string, io: RunProgramIo = {}): boolean {
  const barePiped = argv.length === 2 && (!process.stdin.isTTY || !process.stdout.isTTY);
  const rootHelp = argv.length === 3 && ["--help", "-h"].includes(argv[2]!);
  const helpPath = path.join(path.dirname(entryPath), "root-help.txt");
  if ((!barePiped && !rootHelp) || !existsSync(helpPath)) return false;
  const help = readFileSync(helpPath, "utf8");
  const write = barePiped ? io.err : io.out;
  if (write) write(help.replace(/\n$/, ""));
  else (barePiped ? process.stderr : process.stdout).write(help);
  return true;
}
