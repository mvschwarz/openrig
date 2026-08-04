// OPR.0.4.8.3 — built-in policy packaging/materialization pins (guard-sealed
// immutable plan v2 eea3c778, D4). The four built-in policies ship VERBATIM:
// canonical repo source packages/daemon/policies/builtin/<name>.policy.md,
// materialized at $OPENRIG_HOME/reference/policies/builtin/ as mode-0444
// read-only INSPECTION copies (guard ruling: copy-to-customize affordance,
// not a security boundary; no writer surface; user-custom copies unmodified).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUILTIN_POLICY_NAMES, materializeBuiltinPolicyReference } from "../src/domain/builtin-policy-reference.js";

const REPO_BUILTIN_DIR = resolve(import.meta.dirname, "../policies/builtin");

/** the four authoritative content pins (workspace/incoming/slice03-core-authoritative,
 * PM inline builtin ruling) — full 64-hex, copied VERBATIM into the repo source */
const AUTHORITY_SHA256: Record<string, string> = {
  "locked.policy.md": "dcb38c372def7fe58ddfc9f1f3e97b9ba391ae79a99ef486e44f017cb39e57fe",
  "standard.policy.md": "7b064c6d69f3140add6b40eadad115ef8bf9602942515a096c9979514a4c7ae2",
  "open.policy.md": "bb5fbb18e1f3706bd0676a9e709e29b5754bb6b41b6f304453dd6d73e7a4d62b",
  "yolo.policy.md": "908817b6fd6762a82d099759762c5d57dc568268fa1d13767ebb3fddbb14a6d7",
};

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function tempTarget(): string {
  return mkdtempSync(join(tmpdir(), "builtin-policy-ref-"));
}

describe("T1/T2 — canonical repo source: exact known-four inventory, verbatim bytes", () => {
  it("packages/daemon/policies/builtin contains EXACTLY the four built-in policy files", () => {
    const files = readdirSync(REPO_BUILTIN_DIR).sort();
    expect(files).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md", "yolo.policy.md"]);
  });

  it("every repo-source file is byte-identical to its authority (full sha256 pins)", () => {
    for (const [file, hash] of Object.entries(AUTHORITY_SHA256)) {
      expect(sha256(join(REPO_BUILTIN_DIR, file)), file).toBe(hash);
    }
  });
});

describe("T3/T4/T5 — materializer: byte-identical 0444 inspection copies, idempotent, allowlisted", () => {
  it("T3: copies the known four byte-identical into the target with mode 0444", () => {
    const target = tempTarget();
    try {
      const result = materializeBuiltinPolicyReference({ bundledDir: REPO_BUILTIN_DIR, targetDir: target });
      expect(result.written.sort()).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md", "yolo.policy.md"]);
      expect(result.skipped).toEqual([]);
      for (const [file, hash] of Object.entries(AUTHORITY_SHA256)) {
        const p = join(target, file);
        expect(sha256(p), file).toBe(hash);
        expect(statSync(p).mode & 0o777, `${file} mode`).toBe(0o444);
      }
      expect(readdirSync(target)).toHaveLength(4); // nothing extra materialized
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("T4: refresh restores tampered bytes over an existing READ-ONLY copy; content-skip still reconciles mode", () => {
    const target = tempTarget();
    try {
      materializeBuiltinPolicyReference({ bundledDir: REPO_BUILTIN_DIR, targetDir: target });
      // tamper a read-only copy (as an operator edit would after chmod), keep it read-only
      const victim = join(target, "locked.policy.md");
      chmodSync(victim, 0o644);
      writeFileSync(victim, "tampered — not the policy\n");
      chmodSync(victim, 0o444);
      // and break the MODE of an up-to-date copy (content untouched)
      chmodSync(join(target, "yolo.policy.md"), 0o644);
      materializeBuiltinPolicyReference({ bundledDir: REPO_BUILTIN_DIR, targetDir: target });
      expect(sha256(victim)).toBe(AUTHORITY_SHA256["locked.policy.md"]); // bytes restored
      expect(statSync(victim).mode & 0o777).toBe(0o444);
      expect(statSync(join(target, "yolo.policy.md")).mode & 0o777, "content-skip path reconciles mode").toBe(0o444);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("T5: a stranger file in the bundled dir is NEVER copied; a missing single source is a named skip, others still written", () => {
    const bundled = tempTarget();
    const target = tempTarget();
    try {
      for (const file of ["locked.policy.md", "standard.policy.md", "open.policy.md"])
        writeFileSync(join(bundled, file), readFileSync(join(REPO_BUILTIN_DIR, file)));
      writeFileSync(join(bundled, "rogue.policy.md"), "not a built-in\n"); // stranger
      const result = materializeBuiltinPolicyReference({ bundledDir: bundled, targetDir: target });
      expect(result.written.sort()).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md"]);
      expect(result.skipped).toEqual(["yolo.policy.md"]); // missing source named, never thrown
      expect(readdirSync(target).sort()).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md"]);
    } finally {
      rmSync(bundled, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("missing bundled dir is fully skipped (best-effort), never a throw", () => {
    const target = tempTarget();
    try {
      const result = materializeBuiltinPolicyReference({ bundledDir: join(target, "does-not-exist"), targetDir: target });
      expect(result.written).toEqual([]);
      expect(result.skipped.sort()).toEqual([...BUILTIN_POLICY_NAMES].map((n) => `${n}.policy.md`).sort());
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
