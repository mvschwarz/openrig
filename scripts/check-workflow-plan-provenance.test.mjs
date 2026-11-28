// The `plan` job of the macOS package-tests workflow decides which required check names a run
// reports (`package-tests (daemon)`, `package-tests (cli)`). That decision has to come from the base
// branch, not from the head being graded: the workflow runs on the pull request's merge commit, so a
// checkout with no `ref` hands the plan a copy of scripts/ci-macos-ready-plan.mjs that the pull
// request itself wrote. Such a copy can name both required checks with `package: "none"` and every
// substantive step is guarded by `matrix.package != 'none'` — the required contexts then report
// success with no suite run.
//
// This pins the property: the plan job's checkout names a base-branch ref, and still narrows to the
// script it is about to run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const WORKFLOW = path.join(import.meta.dirname, "..", ".github", "workflows", "macos-package-tests.yml");

function doc() {
  return YAML.parse(readFileSync(WORKFLOW, "utf8"));
}

function planCheckout(workflow) {
  const steps = workflow.jobs?.plan?.steps ?? [];
  const checkout = steps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"));
  assert.ok(checkout, "the plan job checks out the tree it runs the plan script from");
  return checkout;
}

test("the plan job runs the base branch's copy of the plan script", () => {
  const checkout = planCheckout(doc());
  const ref = String(checkout.with?.ref ?? "");
  assert.ok(ref !== "", "the plan job's checkout names a ref; an unnamed checkout is the pull request's merge commit");
  assert.match(
    ref,
    /github\.event\.pull_request\.base\.sha/,
    `the plan job's checkout ref (${ref}) must name the base branch's commit, so a pull request cannot supply the script that grades it`,
  );
});

test("the plan job still materialises only the script it needs", () => {
  const checkout = planCheckout(doc());
  assert.equal(
    String(checkout.with?.["sparse-checkout"] ?? "").trim(),
    "scripts/ci-macos-ready-plan.mjs",
    "the plan job checks out the plan script alone",
  );
  assert.equal(checkout.with?.["persist-credentials"], false, "the plan job does not persist checkout credentials");
});

test("the plan script is the one the workflow runs", () => {
  const workflow = doc();
  const steps = workflow.jobs?.plan?.steps ?? [];
  const run = steps.map((step) => String(step?.run ?? "")).join("\n");
  assert.match(run, /node scripts\/ci-macos-ready-plan\.mjs/, "the plan job runs the pinned script");
});