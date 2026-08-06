// 51-04 testbed image — the build verb's manifest-emit orchestrator (plan §1).
//
// `scripts/build-testbed-image.sh` runs the docker-dependent steps HOST-side (npm pack, docker
// build, docker tag — the locus ruling), then calls this pure, docker-independent orchestrator to
// gather the manifest identity from the tree and write the reproducible manifest + census receipt
// into the build artifact dir. Keeping the logic here (config-wrapper-code doctrine: thin shell,
// tested node) makes the whole identity story unit-testable in the VM.
//
// Identity sources: baseDigest = the host-resolved digest from docker/testbed/base-image (the pin
// fence); stubAssetsHash = the census over the exact staged stub-asset set; gitSha/openrigSha/
// nodeVersion supplied by the shell (git rev-parse / the tree / the Dockerfile pin). REBUILD
// CONTRACT: same inputs => byte-identical manifest.json + receipt. Any missing input fails loudly.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTestbedManifest } from "./testbed-manifest.mjs";
import { deriveStubAssetsHash, readBaseImage, TestbedBuildInputsError } from "./testbed-build-inputs.mjs";

/** Deterministic 2-space JSON with a trailing newline — the byte-stable artifact form. */
function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Gather the testbed image manifest identity and write manifest.json + the stub-assets census
 * receipt into outDir.
 * @returns {{ manifest: object, receipt: object, manifestPath: string, receiptPath: string }}
 */
export function emitTestbedManifest(opts) {
  if (opts === null || typeof opts !== "object") {
    throw new TestbedBuildInputsError("emitTestbedManifest requires an options object");
  }
  const { gitSha, openrigSha, nodeVersion, baseImagePath, stubAssetsRoot, stubAssetFiles, outDir } = opts;

  for (const [name, val] of Object.entries({ baseImagePath, stubAssetsRoot, outDir })) {
    if (typeof val !== "string" || val.trim().length === 0) {
      throw new TestbedBuildInputsError(`emitTestbedManifest requires a non-empty '${name}'`);
    }
  }

  // Base digest — from the host-resolved pin slot (readBaseImage enforces the digest fence).
  const base = readBaseImage(baseImagePath);
  // Stub-assets census over the exact staged set.
  const { hash: stubAssetsHash, receipt } = deriveStubAssetsHash(stubAssetsRoot, stubAssetFiles);

  // computeTestbedManifest validates every remaining identity field (loud on empty/missing).
  const manifest = computeTestbedManifest({
    baseDigest: base.digest,
    nodeVersion,
    openrigSha,
    stubAssetsHash,
    gitSha,
  });

  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "manifest.json");
  const receiptPath = join(outDir, "stub-assets-receipt.json");
  writeFileSync(manifestPath, stableJson(manifest));
  writeFileSync(receiptPath, stableJson(receipt));

  return { manifest, receipt, manifestPath, receiptPath };
}

/** True when this module is the process entry point (invoked as a CLI, not imported). */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// CLI shim — the shell build verb's manifest-emit step:
//   node scripts/testbed-emit-manifest.mjs <inputs.json> <outDir>
// inputs.json carries the identity the shell assembled (gitSha, openrigSha, nodeVersion,
// baseImagePath, stubAssetsRoot, stubAssetFiles). Any failure exits non-zero with a loud stderr
// line — never a silent partial manifest.
if (isMainModule()) {
  const [inputsPath, outDir] = process.argv.slice(2);
  if (!inputsPath || !outDir) {
    console.error("usage: testbed-emit-manifest.mjs <inputs.json> <outDir>");
    process.exit(2);
  }
  try {
    const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
    const { manifestPath, receiptPath, manifest } = emitTestbedManifest({ ...inputs, outDir });
    console.error(`[testbed] wrote ${manifestPath} (${manifest.image}) + ${receiptPath}`);
  } catch (err) {
    console.error(`[testbed] manifest emit failed: ${err.message}`);
    process.exit(1);
  }
}
