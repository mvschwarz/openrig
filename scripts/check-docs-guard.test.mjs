import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDocsGuardMessage, findBlockedDocsPaths } from "./check-docs-guard.mjs";

test("findBlockedDocsPaths allows durable docs folders and rejects other docs paths", () => {
  const blocked = findBlockedDocsPaths([
    "docs/as-built/architecture.md",
    "docs/reference/rig-spec.md",
    "docs/releases/v0.1.12.md",
    "docs/plans/2026-04-10-thing.md",
    "docs/local/notes.md",
    "README.md",
    "docs/plans/2026-04-10-thing.md",
  ]);

  assert.deepEqual(blocked, [
    "docs/local/notes.md",
    "docs/plans/2026-04-10-thing.md",
  ]);
});

test("buildDocsGuardMessage explains the policy and offending files", () => {
  const message = buildDocsGuardMessage([
    "docs/plans/example.md",
  ]);

  assert.match(message, /Blocked tracked docs paths/);
  assert.match(message, /docs\/plans\/example\.md/);
  assert.match(message, /docs\/as-built\/, docs\/reference\/, and docs\/releases\//);
});

// 572bc477 — docs/DESIGN.md is RATIFIED doctrine, and the guard failed to encode it.
//
// `docs/as-built/ui/library-specs-and-design-system.md` §4 states it outright: "The canonical
// OpenRig visual/design system is `docs/DESIGN.md` (at the repo `docs/` root, NOT under
// `docs/as-built/`). Q1 is ratified: DESIGN.md stays at root, byte-identical."
//
// Root placement is therefore a deliberate, recorded decision — not drift to be tidied away.
// It also cannot be satisfied by relocating into any allowed root:
//   docs/as-built/  — all 24 files there carry `last-verified-against-source`; DESIGN.md is not
//                     source-derived, and Q1 explicitly rules this out anyway
//   docs/reference/ — that directory SHIPS (build-package.sh stages it into the package and the
//                     daemon materializes it to $OPENRIG_HOME/reference/), so moving there would
//                     start distributing the brand spec to every operator
//   docs/releases/  — not a release note
// So this one file is named explicitly rather than relocated, and the directory allowlist is
// left alone. Consequence today: root `npm run test:repo` cannot pass on a clean tree, which
// trains people to ignore a gate that is otherwise doing real work.
test("findBlockedDocsPaths allows the ratified docs/DESIGN.md root placement", () => {
  assert.deepEqual(findBlockedDocsPaths(["docs/DESIGN.md"]), []);
});

// Guard-of-the-guard: the exception must be EXACT-PATH, never a hole in the docs/ root. If this
// ever goes green for a sibling root file, the fix has widened into a directory allowance and
// the ephemera policy the guard exists to enforce is gone.
// Deliberately does NOT include docs/DESIGN.md in the input: this pin must hold IDENTICALLY
// before and after the fix. Coupling it to the new allowance would make it a third RED and
// destroy its value — an invariant that only starts passing once you change the code is not
// an invariant, it is a restatement of the feature.
test("the DESIGN.md exception is exact-path — sibling root docs and plan/note folders stay blocked", () => {
  assert.deepEqual(
    findBlockedDocsPaths([
      "docs/OTHER.md",
      "docs/plans/example.md",
      "docs/notes/scratch.md",
    ]),
    ["docs/OTHER.md", "docs/notes/scratch.md", "docs/plans/example.md"],
  );
});

// Integration: the unit contract above is worthless if the real script still fails on the real
// tree. This asserts the actual operator-visible outcome — `npm run test:repo` can be green and
// therefore trustworthy again.
test("the real check-docs-guard.mjs exits 0 against the actual repository", () => {
  // process.execPath, not ambient "node": pins the child to the SAME runtime executing this
  // test rather than whatever PATH happens to resolve.
  // fileURLToPath, not URL.pathname: pathname stays percent-encoded, so a checkout under a
  // path containing spaces would silently resolve to the wrong cwd — this repo has no spaces,
  // so the naive form passes HERE and fails elsewhere, which is the worst kind of green.
  const result = execFileSync(process.execPath, ["scripts/check-docs-guard.mjs"], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.trim(), "");
});
