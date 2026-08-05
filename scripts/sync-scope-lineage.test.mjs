// OPR.0.5.0.18 — sync-scope-lineage guard: the generated daemon mirror stays in
// lockstep with the canonical CLI derivation, drift dies loudly, and a canonical
// mutation propagates to BOTH surfaces through one sync run (the structural kill
// of the old copy-drift class).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts/sync-scope-lineage.mjs");
const CANONICAL = "packages/cli/src/lib/scope/attestation-lineage.ts";
const GENERATED = "packages/daemon/src/domain/scope/attestation-lineage.generated.ts";

function run(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-lineage-"));
  for (const rel of [CANONICAL, GENERATED]) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), target);
  }
  return root;
}

test("the repo is in sync (--check passes on the committed tree)", () => {
  const r = run(["--check"]);
  assert.equal(r.code, 0, r.stderr ?? "");
});

test("a hand-edited generated mirror is DRIFT: --check exits 1 naming the fix", () => {
  const root = makeTmpRoot();
  try {
    fs.appendFileSync(path.join(root, GENERATED), "\n// vandalized\n");
    const r = run(["--check"], { SYNC_LINEAGE_ROOT: root });
    assert.equal(r.code, 1);
    assert.match(r.stderr ?? "", /DRIFT/);
    assert.match(r.stderr ?? "", /sync-scope-lineage\.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a canonical mutation propagates to BOTH surfaces in one sync (the drift class is structurally dead)", () => {
  const root = makeTmpRoot();
  try {
    const canonicalPath = path.join(root, CANONICAL);
    fs.writeFileSync(
      canonicalPath,
      fs.readFileSync(canonicalPath, "utf8").replace("priors > 0", "priors > 0 /* mutated */"),
      "utf8",
    );
    // Before the sync: the mirror does NOT carry the mutation (drift exists).
    assert.equal(run(["--check"], { SYNC_LINEAGE_ROOT: root }).code, 1);
    // One sync run: the mirror now carries it — both surfaces changed together.
    assert.equal(run([], { SYNC_LINEAGE_ROOT: root }).code, 0);
    const generated = fs.readFileSync(path.join(root, GENERATED), "utf8");
    assert.match(generated, /priors > 0 \/\* mutated \*\//);
    assert.equal(run(["--check"], { SYNC_LINEAGE_ROOT: root }).code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
