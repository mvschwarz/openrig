// The macOS package suites are required checks that run only for a head a maintainer approved. These cells test
// the decision for each event shape, and the workflow shapes that keep a required check from passing without a
// test: no `package-tests (daemon|cli)` job on any push, no job-level skip of a required-named job, and a checkout
// bound to the approved head. They read files and run the plan script; nothing reaches GitHub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { MACOS_ENTRIES, MANUAL_ENTRIES, PLACEHOLDER_CHECK, planMacosPackageTests } from "./ci-macos-ready-plan.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const REQUIRED_MACOS = ["package-tests (daemon)", "package-tests (cli)"];

const approval = (overrides = {}) => ({
  action: "submitted",
  review: { state: "approved", author_association: "COLLABORATOR", commit_id: HEAD, ...overrides.review },
  pull_request: { number: 7, head: { sha: overrides.head ?? HEAD }, base: { ref: "main" } },
});

const checks = (plan) => plan.matrix.map((entry) => entry.check);

test("an approval of the current head by a maintainer runs both macOS suites for that head", () => {
  for (const author_association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const plan = planMacosPackageTests("pull_request_review", approval({ review: { author_association } }));
    assert.equal(plan.eligible, true);
    assert.equal(plan.head, HEAD);
    assert.deepEqual(checks(plan), REQUIRED_MACOS);
    assert.ok(plan.matrix.every((entry) => entry.os === "macos-latest"));
  }
  // The webhook spells the state in lower case; the REST API in upper case. Both are an approval.
  assert.equal(planMacosPackageTests("pull_request_review", approval({ review: { state: "APPROVED" } })).eligible, true);
});

test("readiness for one head never applies to another", () => {
  // The approval names an older commit than the head the pull request has now.
  const plan = planMacosPackageTests("pull_request_review", approval({ review: { commit_id: OLDER } }));
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, new RegExp(`${OLDER}.*${HEAD}`));
  assert.deepEqual(checks(plan), [PLACEHOLDER_CHECK]);
});

test("anything that isn't a counting approval of the current head runs no macOS suite", () => {
  const cases = [
    ["a comment", "pull_request_review", approval({ review: { state: "commented" } })],
    ["changes requested", "pull_request_review", approval({ review: { state: "changes_requested" } })],
    ["a dismissed review", "pull_request_review", { ...approval(), action: "dismissed" }],
    ["an edited review", "pull_request_review", { ...approval(), action: "edited" }],
    ["an approval from someone without write access", "pull_request_review", approval({ review: { author_association: "CONTRIBUTOR" } })],
    ["an approval from a first-time contributor", "pull_request_review", approval({ review: { author_association: "FIRST_TIME_CONTRIBUTOR" } })],
    ["an approval from no association", "pull_request_review", approval({ review: { author_association: "NONE" } })],
    ["an approval with no commit", "pull_request_review", approval({ review: { commit_id: undefined } })],
    ["an approval with a short commit", "pull_request_review", approval({ review: { commit_id: "abc1234" } })],
    ["no head", "pull_request_review", { ...approval(), pull_request: { number: 7 } }],
    ["a push", "push", {}],
    ["a pull request push", "pull_request", { action: "synchronize", pull_request: { head: { sha: HEAD } } }],
    ["a label", "pull_request", { action: "labeled", label: { name: "ready" }, pull_request: { head: { sha: HEAD } } }],
    ["a pull_request_target event", "pull_request_target", approval()],
    ["no event at all", "", {}],
  ];
  for (const [name, eventName, event] of cases) {
    const plan = planMacosPackageTests(eventName, event);
    assert.equal(plan.eligible, false, name);
    assert.equal(plan.head, "", name);
    assert.deepEqual(checks(plan), [PLACEHOLDER_CHECK], name);
  }
});

test("a manual run tests the suites under names no required check uses", () => {
  const manual = planMacosPackageTests("workflow_dispatch", {}, "41");
  assert.equal(manual.eligible, false);
  assert.deepEqual(manual.matrix, MANUAL_ENTRIES);
  assert.ok(manual.matrix.every((entry) => entry.os === "macos-latest" && entry.package !== "none"));
  for (const check of checks(manual)) {
    assert.ok(!REQUIRED_MACOS.includes(check), check);
    assert.ok(!check.startsWith("package-tests"), check);
  }
  // The placeholder can never be mistaken for a package suite, and the matrix is never empty.
  assert.ok(!PLACEHOLDER_CHECK.startsWith("package-tests"));
  assert.deepEqual(MACOS_ENTRIES.map((entry) => entry.check), REQUIRED_MACOS);
});

test("a later review can't replace a waiting approval run: only approvals of the same head share a group", () => {
  const approved = planMacosPackageTests("pull_request_review", approval(), "100");
  assert.equal(approved.group, `macos-package-tests-approved-7-${HEAD}`);
  // A comment review, CodeRabbit's included, arriving while the approval run waits.
  const comment = planMacosPackageTests("pull_request_review", approval({ review: { state: "commented" } }), "101");
  assert.notEqual(comment.group, approved.group);
  assert.equal(comment.group, "macos-package-tests-other-101");
  // Every non-approval run has a group of its own, so none can replace another either.
  const another = planMacosPackageTests("pull_request_review", approval({ review: { state: "commented" } }), "102");
  assert.notEqual(another.group, comment.group);
  for (const [name, plan] of [
    ["an approval from someone without write access", planMacosPackageTests("pull_request_review", approval({ review: { author_association: "CONTRIBUTOR" } }), "103")],
    ["an approval of an older head", planMacosPackageTests("pull_request_review", approval({ review: { commit_id: OLDER } }), "104")],
    ["a manual run", planMacosPackageTests("workflow_dispatch", {}, "105")],
  ]) assert.notEqual(plan.group, approved.group, name);
  // A second approval of the same head joins the first one's group, where nothing is cancelled.
  assert.equal(planMacosPackageTests("pull_request_review", approval(), "106").group, approved.group);
  // Another head's approval has its own group.
  assert.notEqual(planMacosPackageTests("pull_request_review", approval({ head: OLDER, review: { commit_id: OLDER } }), "107").group, approved.group);
});

test("the plan script writes the matrix and head for the workflow", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-macos-ready-plan-"));
  const eventPath = path.join(dir, "event.json");
  const outputPath = path.join(dir, "output");
  for (const [event, eligible, head] of [[approval(), "true", HEAD], [approval({ review: { commit_id: OLDER } }), "false", ""]]) {
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputPath, "");
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "ci-macos-ready-plan.mjs")], {
      env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request_review", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, GITHUB_RUN_ID: "9" },
      stdio: "pipe",
    });
    const output = Object.fromEntries(readFileSync(outputPath, "utf8").trim().split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    assert.equal(output.eligible, eligible);
    assert.equal(output.head, head);
    assert.equal(output.group, planMacosPackageTests("pull_request_review", event, "9").group);
    assert.deepEqual(JSON.parse(output.matrix), planMacosPackageTests("pull_request_review", event).matrix);
  }
});

const workflow = (name) => YAML.parse(readFileSync(path.join(WORKFLOWS, name), "utf8"));

test("tests.yml no longer runs the macOS suites on a push", () => {
  const job = workflow("tests.yml").jobs["package-tests"];
  assert.deepEqual(job.strategy.matrix.package, ["tui", "ui"]);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.strategy.matrix.include, undefined);
});

test("the macOS workflow runs only on an approval or by hand, and never skips a required-named job", () => {
  const doc = workflow("macos-package-tests.yml");
  // YAML reads the bare key `on` as a string key; it holds the triggers.
  assert.deepEqual(Object.keys(doc.on).sort(), ["pull_request_review", "workflow_dispatch"]);
  assert.deepEqual(doc.on.pull_request_review.types, ["submitted"]);
  assert.deepEqual(doc.permissions, { contents: "read" });
  // No workflow-level group: one there would let any review's run replace a waiting approval run.
  assert.equal(doc.concurrency, undefined);
  assert.equal(doc.jobs.plan.outputs.group, "${{ steps.plan.outputs.group }}");

  const job = doc.jobs["package-tests"];
  assert.equal(job.if, undefined, "a job-level condition would report a skipped required check as successful");
  assert.equal(job.name, "${{ matrix.check }}");
  assert.deepEqual(job.needs, "plan");
  assert.equal(job.strategy.matrix.include, "${{ fromJSON(needs.plan.outputs.matrix) }}");
  assert.deepEqual(job.concurrency, { group: "${{ needs.plan.outputs.group }}-${{ matrix.package }}", "cancel-in-progress": false });
  assert.equal(doc.jobs.plan.steps.at(-1).run, "node scripts/ci-macos-ready-plan.mjs");

  const guard = job.steps.find((step) => step.name === "Check that the checkout is the approved head merged into main");
  assert.ok(guard, "the checkout is checked against the approved head");
  assert.equal(guard.env.APPROVED_HEAD, "${{ needs.plan.outputs.head }}");
  assert.match(guard.run, /git rev-parse HEAD\^2/);
  assert.match(guard.run, /exit 1/);
  const checkoutAt = job.steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  const guardAt = job.steps.indexOf(guard);
  const testAt = job.steps.findIndex((step) => /npm run test -w/.test(String(step.run ?? "")));
  assert.ok(checkoutAt < guardAt && guardAt < testAt, "the guard runs after the checkout and before the suite");
});

test("no other job anywhere can report a macOS package check", () => {
  for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    for (const [id, job] of Object.entries(workflow(file).jobs ?? {})) {
      if (file === "macos-package-tests.yml" && id === "package-tests") continue;
      const name = String(job?.name ?? id);
      for (const required of REQUIRED_MACOS) assert.notEqual(name, required, `${file} job ${id}`);
      if (/package-tests/.test(name) && /matrix\.package/.test(name)) {
        const packages = job.strategy?.matrix?.package ?? (job.strategy?.matrix?.include ?? []).map((entry) => entry.package);
        assert.ok(Array.isArray(packages), `${file} job ${id} has a static package list`);
        for (const p of ["daemon", "cli"]) assert.ok(!packages.includes(p), `${file} job ${id} would report package-tests (${p})`);
      }
    }
  }
});
