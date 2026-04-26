import test from "node:test";
import assert from "node:assert/strict";
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
