#!/usr/bin/env node

import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REEXEC_GUARD_ENV = "OPENRIG_BIN_REEXEC";

export function resolveBinEntry(invokedPath = process.argv[1], moduleUrl = import.meta.url): string {
  const wrapperPath = invokedPath ? realpathSync(invokedPath) : realpathSync(fileURLToPath(moduleUrl));
  const packageRoot = path.resolve(path.dirname(wrapperPath), "..");
  return path.join(packageRoot, "dist", "index.js");
}

export function isDirectRun(argv1 = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export function resolveNodeReexecBinary(
  currentExecPath = process.execPath,
  invokedPath = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
  realpath: (candidate: string) => string = realpathSync,
): string | null {
  if (!invokedPath) return null;
  if (env[REEXEC_GUARD_ENV] === "1") return null;

  try {
    const binDir = realpath(path.dirname(invokedPath));
    const siblingNode = path.join(binDir, process.platform === "win32" ? "node.exe" : "node");
    if (!exists(siblingNode)) return null;

    const normalizedSiblingNode = realpath(siblingNode);
    const normalizedCurrentExec = realpath(currentExecPath);
    if (normalizedSiblingNode === normalizedCurrentExec) return null;

    return normalizedSiblingNode;
  } catch {
    return null;
  }
}

function maybeReexecWithSiblingNode(argv = process.argv): void {
  const preferredNode = resolveNodeReexecBinary(process.execPath, argv[1], process.env);
  if (!preferredNode) return;

  const scriptPath = argv[1] ? realpathSync(argv[1]) : fileURLToPath(import.meta.url);
  const result = spawnSync(preferredNode, [scriptPath, ...argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      [REEXEC_GUARD_ENV]: "1",
    },
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

export async function run(argv = process.argv): Promise<void> {
  const normalizedArgv = [...argv];
  if (normalizedArgv[1]) {
    normalizedArgv[1] = realpathSync(normalizedArgv[1]);
  }

  const entryUrl = pathToFileURL(resolveBinEntry(normalizedArgv[1], import.meta.url)).href;
  const mod = await import(entryUrl) as { createProgram: () => { parseAsync: (argv: string[]) => Promise<void> } };
  await mod.createProgram().parseAsync(normalizedArgv);
}

if (isDirectRun()) {
  maybeReexecWithSiblingNode(process.argv);
  await run(process.argv);
}
