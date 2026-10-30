import fs from "node:fs";

/** Concurrent native readers can briefly prevent a Windows replacement rename.
 * Keep the staged file and replacement semantics; never unlink the destination.
 * Persistent access failures still surface after a bounded 250 ms wait. */
export function replaceScopeFile(source: string, destination: string): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || attempt >= 25) throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
}
