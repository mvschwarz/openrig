#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProgramDeps } from "./program-full.js";
import { serveBuiltRootHelp } from "./root-help.js";
import { runProgram } from "./cli-error.js";
import { runFrontDoor } from "./front-door.js";

export type { ProgramDeps } from "./program-full.js";
export { runProgram, wantsJsonOutput } from "./cli-error.js";
export { runFrontDoor } from "./front-door.js";

export function isDirectRun(argv1 = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}

const direct = isDirectRun();
const servedHelp = direct && serveBuiltRootHelp(process.argv, fileURLToPath(import.meta.url));
let lazyProgram: import("commander").Command | null = null;
if (direct && !servedHelp && process.argv.length > 2) {
  const { createLazyProgram } = await import("./lazy-program.js");
  lazyProgram = await createLazyProgram(process.argv[2]);
}
// Library imports load the complete synchronous factory before exposing it.
// Direct help invocations do not need its command dependencies.
const full = servedHelp || lazyProgram ? null : await import("./program-full.js");
export function createProgram(depsOverride?: ProgramDeps) {
  return full!.createProgram(depsOverride);
}

if (direct && !servedHelp) {
  if (lazyProgram) await runProgram(lazyProgram, process.argv);
  else {
    const owned = await runFrontDoor(process.argv);
    if (!owned) await runProgram(createProgram(), process.argv);
  }
}
