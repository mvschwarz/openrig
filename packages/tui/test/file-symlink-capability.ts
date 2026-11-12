import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Probe the actual file-link permission, rather than skipping all Windows use.
// Junctions cannot replace these tests: they resolve directories, not files.
export const fileSymlinksSupported = (() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rig-file-link-"));
  try {
    const file = path.join(home, "source"); fs.writeFileSync(file, "fixture");
    fs.symlinkSync(file, path.join(home, "link"), "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally { fs.rmSync(home, { recursive: true }); }
})();
