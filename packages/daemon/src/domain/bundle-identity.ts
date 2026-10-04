import { createHash } from "node:crypto";

/**
 * The two names a shared bundle carries, defined once (docs/reference/bundle-formats.md):
 * the configuration ID (what someone chose) and the package digest (what was packaged).
 * What actually ran is the run record's execution binding, not either of these.
 */

/** The coverage of `packageDigest`, named so it is shown wherever the digest is. */
export const PACKAGE_DIGEST_COVERAGE = "openrig.package-digest/v1";

export interface PackageDigest {
  algorithm: "sha256";
  value: string;
  coverage: typeof PACKAGE_DIGEST_COVERAGE;
}

/**
 * The configuration ID: every member's `pod.member=runtime`, sorted by `pod.member` in plain code-unit
 * order and joined with `,`. Runtimes are spelled as in rig.yaml. Preset names are aliases beside the ID.
 */
export function configurationId(mapping: Record<string, string>): string {
  return Object.keys(mapping)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((member) => `${member}=${mapping[member]}`)
    .join(",");
}

/**
 * The package digest: SHA-256 over UTF-8 lines `JSON.stringify(path) + "\t" + sha256 + "\n"`, one per
 * entry of the built bundle's `integrity.files`, sorted by path in code-unit order. The path is a JSON
 * string so a tab or newline in a file name can't make two different file lists hash the same. It
 * covers the bytes of every packaged file. It does not cover bundle.yaml (so no manifest field, provenance or createdAt), the
 * basenames the integrity walk skips (.DS_Store, Thumbs.db, .gitkeep), file modes, or anything
 * resolved on the installing host.
 */
export function packageDigest(integrityFiles: Record<string, string>): PackageDigest {
  const lines = Object.keys(integrityFiles)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => `${JSON.stringify(path)}\t${integrityFiles[path]}\n`)
    .join("");
  return { algorithm: "sha256", value: createHash("sha256").update(lines, "utf8").digest("hex"), coverage: PACKAGE_DIGEST_COVERAGE };
}
