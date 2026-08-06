import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveStubAssetsHash } from "./testbed-build-inputs.mjs";

// 51-04 stub-asset increment — the L0.2 census check as a durable pin. The build verb
// (scripts/build-testbed-image.sh) stages EXACTLY the paths named in
// docker/testbed/stub-assets.list and feeds that same list to the manifest census
// (census-scope-match-code-path). An EMPTY census is an L0.2 FAIL — deriveStubAssetsHash
// loud-fails and the build verb refuses. This suite pins that the shipped list names the
// concrete zero-token stub trio (a runtime:stub rig.yaml + its agent fixture + culture.md)
// and that the receipt is well-formed, so the list can never silently drift back to empty
// or reference a missing file.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIST = join(REPO_ROOT, "docker/testbed/stub-assets.list");

// The SAME comment-tolerant parse the build verb feeds the census (strip #.* , trim, drop
// blanks — build-testbed-image.sh's node -e / while-read), so the test's census == the
// build's census exactly.
function parseCensus(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((s) => s.replace(/#.*/, "").trim())
    .filter(Boolean);
}

// The concrete stub trio (sorted — deriveStubAssetsHash sorts its receipt by POSIX path).
const EXPECTED = [
  "docker/testbed/stub-assets/agents/worker/agent.yaml",
  "docker/testbed/stub-assets/culture.md",
  "docker/testbed/stub-assets/rig.yaml",
];

test("stub-assets.list census is populated (empty census = L0.2 FAIL, build verb refuses)", () => {
  const files = parseCensus(LIST);
  assert.ok(files.length > 0, "stub-assets.list must be populated (an empty census fails L0.2)");
});

test("census names EXACTLY the stub trio and every listed file exists", () => {
  const files = parseCensus(LIST);
  assert.deepEqual(
    [...files].sort(),
    EXPECTED,
    "census must name exactly the stub trio (rig.yaml + culture.md + agent fixture)",
  );
  for (const rel of files) {
    assert.ok(existsSync(join(REPO_ROOT, rel)), `listed stub asset must exist: ${rel}`);
  }
});

test("L0.2 receipt: deriveStubAssetsHash lists exactly the trio, each with a 64-hex sha256", () => {
  const files = parseCensus(LIST);
  const { hash, receipt } = deriveStubAssetsHash(REPO_ROOT, files);
  assert.match(hash, /^[0-9a-f]{64}$/, "census hash is a 64-hex sha256");
  assert.deepEqual(
    receipt.files.map((f) => f.path).sort(),
    EXPECTED,
    "receipt names exactly the trio",
  );
  for (const f of receipt.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `each receipt entry carries a 64-hex digest: ${f.path}`);
  }
});
