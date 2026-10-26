import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// macOS has no /proc/<pid>/exe. JXA's built-in C bridge calls the same
// proc_pidpath API without a compiler, Python installation or native addon.
// One invocation covers the sample; argv contains numeric PIDs only.
const MAC_PROCESS_PATHS = `ObjC.import("Foundation");
ObjC.bindFunction("proc_pidpath", ["int", ["int", "void *", "uint32_t"]]);
function run(argv) {
  return JSON.stringify(argv.map(function(value) {
    var pid = Number(value);
    var buffer = $.NSMutableData.dataWithLength(4096);
    var size = $.proc_pidpath(pid, buffer.mutableBytes, 4096);
    return [pid, size > 0 ? ObjC.unwrap($.NSString.alloc.initWithDataEncoding(buffer, $.NSUTF8StringEncoding)).split("\\u0000")[0] : null];
  }));
}`;

/** Optional OS executable witnesses. Unavailable, exited and over-budget PIDs
 * have no witness; this never substitutes argv or a version string for a path. */
export async function readNativeExecutablePaths(requested: number[]): Promise<Map<number, string>> {
  const pids = [...new Set(requested.filter(pid => Number.isInteger(pid) && pid > 0 && pid <= 2147483647))].slice(0, 1024);
  const result = new Map<number, string>();
  if (pids.length === 0) return result;
  let entries: unknown;
  try {
    if (process.platform === "linux") {
      entries = await Promise.all(pids.map(async pid => [pid, await readlink(`/proc/${pid}/exe`).catch(() => null)]));
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_PROCESS_PATHS, ...pids.map(String)], {
        encoding: "utf-8", timeout: 2000, maxBuffer: 1024 * 1024,
      });
      entries = JSON.parse(stdout);
    } else return result;
    if (!Array.isArray(entries)) return result;
    const requestedPids = new Set(pids);
    for (const entry of entries) {
      if (!Array.isArray(entry) || !requestedPids.has(entry[0])) continue;
      const path = entry[1];
      if (typeof path === "string" && path.startsWith("/") && !path.includes("\0")
        && !path.split("/").some(part => part === "." || part === "..")) result.set(entry[0], path);
    }
  } catch { /* A missing OS witness is unknown, not positive identity. */ }
  return result;
}
