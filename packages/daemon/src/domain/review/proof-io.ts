// VM-006 (progress-review-done-coherence) — the ONE home for the slice
// proof-artifact read (arch Cell A ruling A1, 2026-07-11): this function is
// `gather.readProofArtifacts` extracted VERBATIM (gather delegates to it;
// the slice-detail projector imports the same reader), so pm-lead's
// exact-mirror semantics ruling holds BY CONSTRUCTION — same `.md` filter,
// same `.sort()`, same `mtime → ISO` droppedAt, same per-file
// try/catch-skip. One implementation cannot drift from itself; if the two
// tabs ever read different artifact sets they re-diverge, which is the
// disease this slice exists to kill. compose.ts stays PURE — impure proof
// IO lives here, never there.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseC1Header } from "./compose.js";

export function readProofArtifacts(sliceDir: string) {
  const proofDir = path.join(sliceDir, "proof");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(proofDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((f) => {
      const full = path.join(proofDir, f);
      try {
        const content = fs.readFileSync(full, "utf8");
        const mtime = fs.statSync(full).mtime.toISOString();
        return parseC1Header(content, `proof/${f}`, mtime);
      } catch {
        return null;
      }
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
}
