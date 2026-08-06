// 51-04 testbed image — the reproducible MANIFEST generator (plan §1 + §3).
//
// The manifest is the durable identity the 51-02 runner + 51-05 matrix cite per run
// (census-receipt discipline): base image digest, node version, the openrig sha the image
// was built from, and the stub-asset hash. REBUILD CONTRACT: same inputs => byte-identical
// manifest + digest, so runs are comparable across image versions. The build verb
// (scripts/build-testbed-image.sh class) computes these inputs from the tree + the docker
// build and calls this to emit the manifest — kept as a pure, dep-free helper so it
// unit-tests hermetically (node:test), matching the scripts/ house convention.
//
// The content digest is taken over CANONICAL sorted-key JSON, never a naive field-join: a
// delimiter embedded in one field value must not be able to forge another honest input
// set's digest (hash-join-delimiter-forgery). JSON escaping makes distinct inputs distinct.

import { createHash } from "node:crypto";

/** Loud, typed failure — a missing/invalid identity input must fail, never a silent partial
 *  manifest that would look build-clean while omitting an identity field. */
export class TestbedManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "TestbedManifestError";
  }
}

/** The image name prefix (plan §1: `openrig-testbed:<git-sha>`). */
export const TESTBED_IMAGE_NAME = "openrig-testbed";

/** The manifest schema id — bumped only on a breaking manifest-shape change. */
export const TESTBED_MANIFEST_SCHEMA = "openrig-testbed-manifest/v1";

/** The identity fields that define a testbed image build (all required, all non-empty). */
const IDENTITY_FIELDS = ["baseDigest", "nodeVersion", "openrigSha", "stubAssetsHash", "gitSha"];

/** Deterministic JSON with recursively sorted keys — the byte-stable form the digest is
 *  taken over (two objects with the same entries serialize identically regardless of key
 *  insertion order). */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** Compute the reproducible testbed image manifest from its identity inputs. */
export function computeTestbedManifest(inputs) {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new TestbedManifestError("testbed manifest inputs must be an object");
  }
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    const raw = inputs[field];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new TestbedManifestError(`testbed manifest input '${field}' is required (non-empty string)`);
    }
    identity[field] = raw;
  }

  // The digested payload is the schema + the identity fields (NOT the digest itself). Taken
  // over canonical JSON so the digest is order-independent + forgery-resistant.
  const digested = { schema: TESTBED_MANIFEST_SCHEMA, ...identity };
  const manifestDigest = createHash("sha256").update(canonicalJson(digested), "utf8").digest("hex");

  return {
    schema: TESTBED_MANIFEST_SCHEMA,
    image: `${TESTBED_IMAGE_NAME}:${identity.gitSha}`,
    ...identity,
    manifestDigest,
  };
}
