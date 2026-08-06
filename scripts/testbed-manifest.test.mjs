import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTestbedManifest, TestbedManifestError } from "./testbed-manifest.mjs";

// 51-04 testbed image — the REPRODUCIBLE MANIFEST is the durable identity the runner /
// 51-05 matrix cite per run (census-receipt discipline, plan §1 + §3). REBUILD CONTRACT:
// same inputs => byte-identical manifest + digest. The digest is over CANONICAL sorted-key
// JSON, never a naive field-join — a delimiter inside a value must not forge another input
// set's digest (hash-join-delimiter-forgery). Loud-fail on missing/invalid input (never a
// silent partial manifest that would look build-clean). Pure + dep-free: node:test only.

const BASE = Object.freeze({
  baseDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  nodeVersion: "22.22.1",
  openrigSha: "9cf781060000000000000000000000000000000",
  stubAssetsHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  gitSha: "9cf781060000000000000000000000000000000",
});

test("produces the four identity fields + image tag + a sha256 manifest digest", () => {
  const m = computeTestbedManifest(BASE);
  assert.equal(m.baseDigest, BASE.baseDigest);
  assert.equal(m.nodeVersion, BASE.nodeVersion);
  assert.equal(m.openrigSha, BASE.openrigSha);
  assert.equal(m.stubAssetsHash, BASE.stubAssetsHash);
  // Image identity is tagged by the git sha (plan §1: openrig-testbed:<git-sha>).
  assert.equal(m.image, `openrig-testbed:${BASE.gitSha}`);
  // The manifest carries its own content digest (64-hex sha256).
  assert.match(m.manifestDigest, /^[0-9a-f]{64}$/);
});

test("REBUILD CONTRACT: same inputs => byte-identical manifest JSON + identical digest", () => {
  const a = computeTestbedManifest(BASE);
  const b = computeTestbedManifest({ ...BASE });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b)); // byte-stable serialization
  assert.equal(a.manifestDigest, b.manifestDigest);
});

test("per-field sensitivity: changing ANY identity field changes the digest (no collision)", () => {
  const base = computeTestbedManifest(BASE);
  for (const field of ["baseDigest", "nodeVersion", "openrigSha", "stubAssetsHash", "gitSha"]) {
    const mutated = computeTestbedManifest({ ...BASE, [field]: `${BASE[field]}-x` });
    assert.notEqual(mutated.manifestDigest, base.manifestDigest, `${field} must affect the digest`);
  }
});

test("forgery-resistance: a delimiter/quote inside a value cannot forge another input set's digest", () => {
  // A naive `fields.join(":")` (or unescaped concatenation) would let a crafted value that
  // embeds the delimiter + a sibling's content collide with a different, honest input set.
  // Canonical JSON escapes, so these two distinct input sets MUST yield distinct digests.
  const honest = computeTestbedManifest({ ...BASE, nodeVersion: "22", openrigSha: "abc" });
  const forged = computeTestbedManifest({ ...BASE, nodeVersion: '22","openrigSha":"abc', openrigSha: "z" });
  assert.notEqual(honest.manifestDigest, forged.manifestDigest);
});

test("loud-fail on a missing or empty required identity field (never a silent partial manifest)", () => {
  for (const field of ["baseDigest", "nodeVersion", "openrigSha", "stubAssetsHash", "gitSha"]) {
    assert.throws(() => computeTestbedManifest({ ...BASE, [field]: "" }), TestbedManifestError, `empty ${field}`);
    const { [field]: _omit, ...missing } = BASE;
    assert.throws(() => computeTestbedManifest(missing), TestbedManifestError, `missing ${field}`);
  }
  assert.throws(() => computeTestbedManifest(null), TestbedManifestError);
});
