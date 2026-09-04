export interface NativeProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export type NativeRuntime = "claude-code" | "codex";

function tokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
}

function executableName(token: string): string {
  return (token.split("/").pop() ?? token).toLowerCase().replace(/\.exe$/, "");
}

function commandUsesExpectedToken(command: string, runtime: NativeRuntime, expectedToken: string): boolean {
  const argv = tokens(command);
  const executable = runtime === "claude-code" ? "claude" : "codex";
  const executableIndex = argv.findIndex((token) => executableName(token) === executable);
  if (executableIndex < 0) return false;
  const args = argv.slice(executableIndex + 1);
  if (runtime === "claude-code") {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if ((arg === "--resume" || arg === "--session-id") && args[index + 1] === expectedToken) return true;
      if (arg === `--resume=${expectedToken}` || arg === `--session-id=${expectedToken}`) return true;
    }
    return false;
  }

  const topLevelOptionsWithValues = new Set([
    "-a", "--ask-for-approval", "-c", "--config", "-m", "--model",
    "-p", "--profile", "-s", "--sandbox",
  ]);
  let resumeIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (topLevelOptionsWithValues.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    if (arg === "resume") resumeIndex = index;
    break;
  }
  if (resumeIndex < 0) return false;
  const resumeArgs = args.slice(resumeIndex + 1);
  let index = 0;
  while (index < resumeArgs.length) {
    const arg = resumeArgs[index]!;
    if (arg === "--add-dir") { index += 2; continue; }
    if (arg.startsWith("-")) { index += 1; continue; }
    return arg === expectedToken;
  }
  return false;
}

/** Require a live process in the pane's own lineage whose argv names both the
 * declared runtime and the exact native resume identity. */
export function findExactNativeResumeProcess(
  processes: NativeProcessRow[],
  panePid: number,
  runtime: string | null,
  expectedToken: string,
): NativeProcessRow | null {
  if (runtime !== "claude-code" && runtime !== "codex") return null;
  const byParent = new Map<number, NativeProcessRow[]>();
  for (const process of processes) {
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const queue = [panePid];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const process = byPid.get(pid);
    if (process && commandUsesExpectedToken(process.command, runtime, expectedToken)) return process;
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return null;
}
