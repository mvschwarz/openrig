import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveStubAssetsHash,
  parseDigestPinnedBase,
  readBaseImage,
  TestbedBuildInputsError,
} from "./testbed-build-inputs.mjs";

// 51-04 testbed image — the build verb derives the manifest's `stubAssetsHash` (plan §1) by
// hashing the EXACT stub-asset file set the Dockerfile COPYs into the image. This is the
// census receipt: a byte-reproducible identity of what shipped, scoped to the code path's
// exact file list (census-scope-match-code-path — an author-supplied list, NEVER a recursive
// walk that would over-count untracked/generated siblings). The digest is over CANONICAL
// content (each file hashed, then a sorted {path,sha256} map hashed) — never a naive path/
// content join a delimiter could forge (hash-join-delimiter-forgery). Loud-fail on a missing
// file / empty set / a path escaping the asset root (never a silent partial receipt).

/** Build a temp asset tree from a {relpath: content} map; returns its root dir. */
function makeAssetTree(entries) {
  const root = mkdtempSync(join(tmpdir(), "testbed-assets-"));
  for (const [rel, content] of Object.entries(entries)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const ASSETS = Object.freeze({
  "stub-runner.js": "// compiled stub runner\nexport const x = 1;\n",
  "stub-runner.protocol.md": "the stub protocol\n",
  "hooks/compaction-restore-bridge.cjs": "module.exports = {};\n",
});

test("produces a 64-hex digest + a sorted per-file census receipt over the asset set", () => {
  const root = makeAssetTree(ASSETS);
  try {
    const { hash, receipt } = deriveStubAssetsHash(root, Object.keys(ASSETS));
    assert.match(hash, /^[0-9a-f]{64}$/);
    // Receipt lists every named asset, each with its own 64-hex content digest, SORTED by path.
    assert.equal(receipt.files.length, 3);
    assert.deepEqual(
      receipt.files.map((f) => f.path),
      ["hooks/compaction-restore-bridge.cjs", "stub-runner.js", "stub-runner.protocol.md"],
    );
    for (const f of receipt.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REBUILD CONTRACT: identical files => identical digest, INDEPENDENT of input list order", () => {
  const a = makeAssetTree(ASSETS);
  const b = makeAssetTree(ASSETS);
  try {
    const forward = deriveStubAssetsHash(a, Object.keys(ASSETS));
    const reversed = deriveStubAssetsHash(b, [...Object.keys(ASSETS)].reverse());
    assert.equal(forward.hash, reversed.hash);
    assert.equal(JSON.stringify(forward.receipt), JSON.stringify(reversed.receipt));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("content sensitivity: changing ANY file's bytes changes the digest", () => {
  const base = makeAssetTree(ASSETS);
  const mutated = makeAssetTree({ ...ASSETS, "stub-runner.js": "// DIFFERENT bytes\n" });
  try {
    assert.notEqual(
      deriveStubAssetsHash(base, Object.keys(ASSETS)).hash,
      deriveStubAssetsHash(mutated, Object.keys(ASSETS)).hash,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(mutated, { recursive: true, force: true });
  }
});

test("path sensitivity: same content at a different path changes the digest (path is identity)", () => {
  const a = makeAssetTree({ "a.js": "same", "b.js": "other" });
  const b = makeAssetTree({ "renamed.js": "same", "b.js": "other" });
  try {
    assert.notEqual(
      deriveStubAssetsHash(a, ["a.js", "b.js"]).hash,
      deriveStubAssetsHash(b, ["renamed.js", "b.js"]).hash,
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("set sensitivity: adding or dropping a file changes the digest", () => {
  const full = makeAssetTree(ASSETS);
  try {
    const all = deriveStubAssetsHash(full, Object.keys(ASSETS)).hash;
    const fewer = deriveStubAssetsHash(full, ["stub-runner.js", "stub-runner.protocol.md"]).hash;
    assert.notEqual(all, fewer);
  } finally {
    rmSync(full, { recursive: true, force: true });
  }
});

test("forgery-resistance: a delimiter/quote in a path cannot forge another honest set's digest", () => {
  // A naive `${path}:${contentHash}` join could let a crafted path embed a sibling's boundary
  // and collide with a different, honest asset set. Canonical JSON escaping keeps them distinct.
  const honest = makeAssetTree({ "a.js": "x", "b.js": "y" });
  const forged = makeAssetTree({ 'a.js","sha256":"forged': "x", "b.js": "y" });
  try {
    assert.notEqual(
      deriveStubAssetsHash(honest, ["a.js", "b.js"]).hash,
      deriveStubAssetsHash(forged, ['a.js","sha256":"forged', "b.js"]).hash,
    );
  } finally {
    rmSync(honest, { recursive: true, force: true });
    rmSync(forged, { recursive: true, force: true });
  }
});

test("loud-fail: empty asset set (never a silent empty receipt)", () => {
  const root = makeAssetTree(ASSETS);
  try {
    assert.throws(() => deriveStubAssetsHash(root, []), TestbedBuildInputsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loud-fail: a named asset that does not exist on disk", () => {
  const root = makeAssetTree(ASSETS);
  try {
    assert.throws(
      () => deriveStubAssetsHash(root, ["stub-runner.js", "does-not-exist.js"]),
      TestbedBuildInputsError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loud-fail: a path escaping the asset root (containment guard)", () => {
  const root = makeAssetTree(ASSETS);
  try {
    assert.throws(() => deriveStubAssetsHash(root, ["../escape.js"]), TestbedBuildInputsError);
    assert.throws(() => deriveStubAssetsHash(root, ["/etc/passwd"]), TestbedBuildInputsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- base image: the digest-pin fence (plan §1: "digest-pinned, not tag-floating") ---
// The base LTS-slim Linux MUST be pinned by @sha256 digest so the image is byte-reproducible; a
// tag-floating base (`debian:bookworm-slim`) drifts silently between builds. The resolved digest
// becomes the manifest's baseDigest. The build verb refuses anything but a digest-pinned ref; the
// digest is resolved HOST-side (the locus ruling) and recorded in docker/testbed/base-image.

const GOOD_DIGEST = "sha256:" + "a".repeat(64);

test("parseDigestPinnedBase accepts a digest-pinned ref and returns its name + sha256 digest", () => {
  const { ref, name, digest } = parseDigestPinnedBase(`debian:bookworm-slim@${GOOD_DIGEST}`);
  assert.equal(ref, `debian:bookworm-slim@${GOOD_DIGEST}`);
  assert.equal(name, "debian:bookworm-slim");
  assert.equal(digest, GOOD_DIGEST);
  // A fully-qualified registry path is fine too.
  assert.equal(parseDigestPinnedBase(`docker.io/library/debian@${GOOD_DIGEST}`).digest, GOOD_DIGEST);
});

test("parseDigestPinnedBase REFUSES a tag-floating (non-@sha256) base — the fence", () => {
  assert.throws(() => parseDigestPinnedBase("debian:bookworm-slim"), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("node:22.22.1-bookworm-slim"), TestbedBuildInputsError);
});

test("parseDigestPinnedBase REFUSES a malformed digest (short hex / non-hex / wrong algo)", () => {
  assert.throws(() => parseDigestPinnedBase("debian@sha256:" + "a".repeat(63)), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("debian@sha256:" + "g".repeat(64)), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("debian@sha256:" + "A".repeat(64)), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("debian@sha512:" + "a".repeat(128)), TestbedBuildInputsError);
});

test("parseDigestPinnedBase REFUSES empty / non-string input", () => {
  assert.throws(() => parseDigestPinnedBase(""), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("   "), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase(null), TestbedBuildInputsError);
});

test("readBaseImage reads a comment-tolerant single digest-pinned ref from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "testbed-base-"));
  try {
    const p = join(dir, "base-image");
    writeFileSync(p, `# resolved host-side per the L0 runbook\n\ndebian:bookworm-slim@${GOOD_DIGEST}\n`);
    const { digest, name } = readBaseImage(p);
    assert.equal(digest, GOOD_DIGEST);
    assert.equal(name, "debian:bookworm-slim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBaseImage loud-fails on an UNRESOLVED slot (comment-only — no ref yet)", () => {
  const dir = mkdtempSync(join(tmpdir(), "testbed-base-"));
  try {
    const p = join(dir, "base-image");
    writeFileSync(p, "# not yet resolved — run the host-side base-image resolve step\n");
    assert.throws(() => readBaseImage(p), TestbedBuildInputsError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBaseImage loud-fails on multiple refs (ambiguous) and on a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "testbed-base-"));
  try {
    const p = join(dir, "base-image");
    writeFileSync(p, `debian@${GOOD_DIGEST}\nubuntu@${GOOD_DIGEST}\n`);
    assert.throws(() => readBaseImage(p), TestbedBuildInputsError);
    assert.throws(() => readBaseImage(join(dir, "nope")), TestbedBuildInputsError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
