#!/usr/bin/env node

import module from "node:module";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunProgramIo } from "./cli-error.js";

const REEXEC_GUARD_ENV = "OPENRIG_BIN_REEXEC";

// Each `rig` is a new process: Node's on-disk compile cache lets the next call skip compiling the modules
// again. The cache dates from Node v22.1.0, but this JavaScript API from v22.8.0: before it, `?.()` does
// nothing. NODE_COMPILE_CACHE and NODE_DISABLE_COMPILE_CACHE still control it.
module.enableCompileCache?.();

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
  // An alias is not runtime authority. Keep a working interpreter; only switch
  // when the installed native dependency actually loads under the alternative.
  if (canLoadInstalledNative(process.execPath, scriptPath)) return;
  if (!canLoadInstalledNative(preferredNode, scriptPath)) return;
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

export function canLoadInstalledNative(node: string, wrapper: string): boolean {
  const probe = spawnSync(node, ["--input-type=module", "-e",
    "import {createRequire} from 'node:module'; const require=createRequire(process.argv[1]); const D=require('better-sqlite3'); new D(':memory:').close();",
    wrapper,
  ], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  return probe.status === 0;
}

/** A command whose modules cannot be loaded fails as any other command does: the shared error object on stdout under
 *  `--json`, `error: …` on stderr otherwise, and exit 1. A human run also gets the stack, which names the module and
 *  line that failed, as Node's own crash did. The error helpers are imported only here: statically, they and the
 *  client they import would load before the compile cache is on. Should they fail to load too, Node's crash stands. */
async function failedToLoad(argv: string[], error: unknown, io: RunProgramIo): Promise<void> {
  let helpers: typeof import("./cli-error.js");
  try {
    helpers = await import("./cli-error.js");
  } catch {
    throw error;
  }
  const { formatCliError, wantsJsonOutput } = helpers;
  const failure = formatCliError(error);
  const out = io.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
  if (wantsJsonOutput(argv.slice(2))) {
    out(JSON.stringify(failure));
  } else {
    err(`error: ${failure.error.message}`);
    if (error instanceof Error && error.stack) err(error.stack);
  }
  (io.exit ?? ((c: number) => process.exit(c)))(1);
}

export async function run(argv = process.argv, io: RunProgramIo = {}): Promise<void> {
  const normalizedArgv = [...argv];
  if (normalizedArgv[1]) {
    normalizedArgv[1] = realpathSync(normalizedArgv[1]);
  }

  const entryPath = resolveBinEntry(normalizedArgv[1], import.meta.url);
  // A named command loads only its own module (lazy-program.ts), which ships beside the entry.
  if (normalizedArgv.length > 2) {
    const lazyPath = path.join(path.dirname(entryPath), "lazy-program.js");
    let lazy: {
      createLazyProgram: (first: string | undefined) => Promise<import("commander").Command | null>;
      runProgram: (program: import("commander").Command, argv: string[], io?: RunProgramIo) => Promise<number>;
    };
    let program: import("commander").Command | null;
    try {
      lazy = await import(pathToFileURL(lazyPath).href) as typeof lazy;
      program = await lazy.createLazyProgram(normalizedArgv[2]);
    } catch (error) {
      await failedToLoad(normalizedArgv, error, io);
      return;
    }
    if (program) {
      await lazy.runProgram(program, normalizedArgv, io);
      return;
    }
  }

  const entryUrl = pathToFileURL(entryPath).href;
  let mod: {
    createProgram: () => import("commander").Command;
    runProgram: (program: import("commander").Command, argv: string[], io?: RunProgramIo) => Promise<number>;
    runFrontDoor?: (argv: readonly string[]) => Promise<boolean>;
  };
  try {
    mod = await import(entryUrl) as typeof mod;
  } catch (error) {
    await failedToLoad(normalizedArgv, error, io);
    return;
  }
  // Slice 17: the PUBLIC bin is the real front door — bare `rig` in a TTY
  // opens the TUI here, not only under a direct `node dist/index.js` run
  // (guard finding 1: importing the entry makes its isDirectRun false).
  // Feature-detected so the wrapper still runs an older sibling entry.
  const owned = mod.runFrontDoor ? await mod.runFrontDoor(normalizedArgv) : false;
  if (owned) return;
  // Slice 15: run through the shared error path so `--json` failures emit a JSON
  // error object with a nonzero exit instead of plain Commander text.
  await mod.runProgram(mod.createProgram(), normalizedArgv, io);
}

if (isDirectRun()) {
  maybeReexecWithSiblingNode(process.argv);
  await run(process.argv);
}
