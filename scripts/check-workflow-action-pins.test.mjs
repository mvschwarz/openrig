// Both workflows run on every pull request, including one from a fork, so the third-party actions they
// use are pinned to a commit SHA: a tag is mutable and can be moved under a job that already trusts it.
// This pins the property, and the SHAs stay current through .github/dependabot.yml.
//
// The check parses the YAML rather than matching text, so a pinned reference is verified as the step's
// own `uses` value and not as prose or a comment that happens to look like one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const WORKFLOWS = path.join(import.meta.dirname, "..", ".github", "workflows");
const SHA_PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

function usesOf(workflowPath) {
  const doc = YAML.parse(readFileSync(workflowPath, "utf8"));
  const uses = [];
  for (const [job, definition] of Object.entries(doc.jobs ?? {})) {
    for (const step of definition?.steps ?? []) if (step?.uses) uses.push({ job, uses: step.uses });
  }
  return uses;
}

test("every action a workflow uses is pinned to a commit SHA", () => {
  const workflows = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length > 0, "the repository ships workflows");
  let checked = 0;
  for (const workflow of workflows) {
    for (const { job, uses } of usesOf(path.join(WORKFLOWS, workflow))) {
      assert.match(uses, SHA_PINNED, `${workflow} job ${job} uses ${uses}, which is not a pinned commit SHA`);
      checked++;
    }
  }
  assert.ok(checked > 0, "the workflows use at least one action");
});

test("a version comment names the release beside each pin, and dependabot keeps them moving", () => {
  const comment = /uses:\s*[^@\s]+@[0-9a-f]{40}\s+#\s*v\d+/;
  for (const workflow of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(path.join(WORKFLOWS, workflow), "utf8");
    const pins = text.split("\n").filter((line) => /\buses:\s*[^@\s]+@[0-9a-f]{40}/.test(line));
    assert.ok(pins.length > 0, `${workflow} has pins`);
    for (const line of pins) assert.match(line, comment, `${workflow}: ${line.trim()}`);
  }
  const dependabot = YAML.parse(readFileSync(path.join(WORKFLOWS, "..", "dependabot.yml"), "utf8"));
  const actions = (dependabot.updates ?? []).filter((update) => update["package-ecosystem"] === "github-actions");
  assert.equal(actions.length, 1, "dependabot watches github-actions");
  assert.ok(actions[0].schedule?.interval, "the watch has a schedule");
});
