// The configuration ID and package digest match the shared vectors in
// docs/reference/schemas/fixtures/identity-vectors.json, which other implementations (the site) check too.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { configurationId, packageDigest } from "../src/domain/bundle-identity.js";

const vectors = JSON.parse(fs.readFileSync(nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/reference/schemas/fixtures/identity-vectors.json"), "utf-8")) as {
  configurationId: Array<{ mapping: Record<string, string>; expected: string }>;
  packageDigest: Array<{ integrityFiles: Record<string, string>; expected: unknown }>;
};

describe("bundle identity", () => {
  it.each(vectors.configurationId)("configuration ID for $expected", ({ mapping, expected }) => {
    expect(configurationId(mapping)).toBe(expected);
  });

  it.each(vectors.packageDigest)("package digest vector", ({ integrityFiles, expected }) => {
    expect(packageDigest(integrityFiles)).toEqual(expected);
  });

  it("the package digest does not depend on the order integrity entries arrive in", () => {
    const files = vectors.packageDigest[0]!.integrityFiles;
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(packageDigest(reversed)).toEqual(packageDigest(files));
  });

  it("a file name holding a tab and a newline cannot pass for two files", () => {
    const [h1, h2] = ["1".repeat(64), "2".repeat(64)];
    expect(packageDigest({ [`x\t${h1}\ny`]: h2 }).value).not.toBe(packageDigest({ x: h1, y: h2 }).value);
  });
});
