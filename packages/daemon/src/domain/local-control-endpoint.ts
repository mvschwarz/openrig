import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export function localControlEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform, family = "openrig-tui"): string {
  if (platform !== "win32" || /^\\\\[.?]\\pipe\\/i.test(socketPath)) return socketPath;
  const resolved = path.resolve(socketPath);
  let parent = path.dirname(resolved);
  const tail = [path.basename(resolved)];
  // The pipe itself is not a filesystem entry, and its run directory need not
  // exist. Resolve the nearest existing parent so junctions and DOS short names
  // name the same endpoint without creating directories for Windows IPC.
  for (;;) {
    try {
      parent = fs.realpathSync.native(parent);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = path.dirname(parent);
      if (next === parent) break;
      tail.unshift(path.basename(parent));
      parent = next;
    }
  }
  const identity = createHash("sha256").update(path.join(parent, ...tail).toLowerCase()).digest("hex");
  return `\\\\.\\pipe\\${family}-${identity}`;
}
