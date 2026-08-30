// OPR.0.4.8.3 — built-in policy PACKING pins (guard-sealed plan v2 eea3c778,
// D4 T6/T7). NEW file beside the existing check-packing floor (the floor is
// added-beside, never edited).
//
// The chain this file pins (mirrors the sdlc-conventions daemon-package
// precedent documented in check-packing.test.mjs):
//   repo source      packages/daemon/policies/builtin/<name>.policy.md
//   packed           daemon/policies/builtin/<name>.policy.md   (build-package.sh staging)
//   installed stable $OPENRIG_HOME/reference/policies/builtin/<name>.policy.md
//                    (daemon startup materializer, mode 0444 inspection copies)
// The runtime edge is proven at the compiled assembled boundary by
// scripts/verify-packaged-builtins.mjs (plan D5b); these tests pin the source
// and staging legs so a dropped staging block or edited source fails loudly.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

const AUTHORITY_SHA256 = {
  "locked.policy.md": "dcb38c372def7fe58ddfc9f1f3e97b9ba391ae79a99ef486e44f017cb39e57fe",
  "standard.policy.md": "737d3f56e6d8275fe548a3a06e9b02ede8f328207ec2e6223cea6a83f40f5148",
  "open.policy.md": "bb5fbb18e1f3706bd0676a9e709e29b5754bb6b41b6f304453dd6d73e7a4d62b",
  "yolo.policy.md": "ff1f21ef05a560d338b25fc035b548d12461429345230e2afe4855c0bb0f1217",
};

test("T6: build-package.sh stages daemon policies into the assembled package", () => {
  const sh = readFileSync("scripts/build-package.sh", "utf-8");
  assert.ok(
    /if \[ -d "\$DAEMON_DIR\/policies" \]/.test(sh),
    "build-package.sh no longer stages $DAEMON_DIR/policies — the assembled daemon would ship no built-in policies and the startup materializer would find nothing to copy to $OPENRIG_HOME/reference/policies/builtin/."
  );
  assert.ok(
    sh.includes('cp -r "$DAEMON_DIR/policies" "$CLI_DIR/daemon/policies"'),
    "the policies staging copy line is missing/changed — packed daemon/policies would not match the repo source."
  );
});

test("T7: the canonical repo-source built-ins are exactly the known four, byte-equal to authority", () => {
  const dir = "packages/daemon/policies/builtin";
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["locked.policy.md", "open.policy.md", "standard.policy.md", "yolo.policy.md"],
    "the built-in policy inventory must be EXACTLY locked|standard|open|yolo");
  for (const [file, expected] of Object.entries(AUTHORITY_SHA256)) {
    const actual = createHash("sha256").update(readFileSync(`${dir}/${file}`)).digest("hex");
    assert.equal(actual, expected, `${file} diverged from the authoritative verbatim content`);
  }
});
