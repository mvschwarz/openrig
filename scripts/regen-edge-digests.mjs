#!/usr/bin/env node
// Disk-truth regen of scripts/skill-edge-digests.generated.json.
//
// Recomputes every edge's file-integrity hashes from the files ON DISK, using the in-repo (already
// correct) scripts/skill-edge-layout.generated.json to know which edges to walk. NO founder authority
// YAMLs are required — the digests are purely disk + layout derived. The full mirror APPLY that also
// re-derives membership/denylist/layout from the founder skill canon stays founder-gated; THIS regen
// only refreshes the reality side (hashes of present files) to match folded main.
//
// PROPERTY (layout = authority, disk = reality, regen touches only reality): buildEdgeDigests hashes
// PRESENT files only. A layout-demanded file missing from disk is never given a digest here, so
// `mirror-skills.mjs --check` stays LOUD about it (via its layout-missing check + the narrow, named,
// self-policing external-canon-pending allowlist) — a future accidental deletion can never be silently
// blessed by a regen.
//
// Usage: node scripts/regen-edge-digests.mjs   (writes in place; run when folded skill edges drift)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdgeDigests } from "../packages/daemon/scripts/gen-control-plane-json.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const layoutPath = join(repoRoot, "scripts/skill-edge-layout.generated.json");
const outPath = join(repoRoot, "scripts/skill-edge-digests.generated.json");

const layout = JSON.parse(readFileSync(layoutPath, "utf8"));
const digests = buildEdgeDigests({ repoRoot, layout });
writeFileSync(outPath, `${JSON.stringify(digests, null, 2)}\n`);

const fileCount = Object.values(digests.edges).reduce((n, files) => n + Object.keys(files).length, 0);
console.log(
  `Regenerated ${outPath} from disk: ${Object.keys(digests.edges).length} edges, ${fileCount} files.`,
);
