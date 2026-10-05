// Public surface for the shared bundle identity definitions (docs/reference/bundle-formats.md),
// so the CLI and other consumers compute configuration IDs and package digests the same way.
export { configurationId, packageDigest, PACKAGE_DIGEST_COVERAGE, type PackageDigest } from "./domain/bundle-identity.js";
