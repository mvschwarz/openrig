// The macOS package suites are required checks that run only for a head a maintainer approved. These cells test
// the decision for each event shape, and the workflow shapes that keep a required check from passing without a
// test: no `package-tests (daemon|cli)` job on any push, no job-level skip of a required-named job, and a checkout
// bound to the approved head. They read files and run the plan script; nothing reaches GitHub.

import { test } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { MACOS_ENTRIES, MANUAL_ENTRIES, PLACEHOLDER_CHECK, planMacosPackageTests, reconcileMacosPackageTests, githubApi } from "./ci-macos-ready-plan.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const REQUIRED_MACOS = ["package-tests (daemon)", "package-tests (cli)"];

const approval = (overrides = {}) => ({
  action: "submitted",
  review: { id: 19, state: "approved", author_association: "COLLABORATOR", commit_id: HEAD, ...overrides.review },
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
  const manual = planMacosPackageTests("workflow_dispatch", {});
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

test("eligible approvals queue by PR and head without replacing pending coverage", () => {
  const doc = YAML.parse(readFileSync(path.join(WORKFLOWS, "macos-package-tests.yml"), "utf8"));
  assert.equal(doc.concurrency.queue, "max");
  assert.equal(doc.concurrency["cancel-in-progress"], false);
  const group = doc.concurrency.group;
  for (const guard of ["github.event_name == 'pull_request_review'", "github.event.review.state == 'approved'",
    `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.review.author_association)`,
    "github.event.review.commit_id == github.event.pull_request.head.sha",
    "format('pr-{0}-{1}', github.event.pull_request.number, github.event.review.commit_id)", "format('run-{0}', github.run_id)"])
    assert.ok(group.includes(guard), guard);
  assert.ok(group.startsWith("macos-package-tests-"));
  assert.ok(doc["run-name"].includes("format('macOS package tests PR #{0}', github.event.pull_request.number)"));
  for (const job of Object.values(doc.jobs)) assert.equal(job.concurrency, undefined);
});

test("the plan script writes the matrix and head for the workflow", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-macos-ready-plan-"));
  const eventPath = path.join(dir, "event.json");
  const outputPath = path.join(dir, "output");
  for (const [event, eligible, head] of [[approval({ review: { state: "commented" } }), "false", ""], [approval({ review: { commit_id: OLDER } }), "false", ""]]) {
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputPath, "");
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "ci-macos-ready-plan.mjs")], {
      env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request_review", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
      stdio: "pipe",
    });
    const output = Object.fromEntries(readFileSync(outputPath, "utf8").trim().split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    assert.equal(output.eligible, eligible);
    assert.equal(output.head, head);
    assert.equal(output.group, undefined);
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
  assert.deepEqual(doc.jobs.plan.permissions, { contents: "read", "pull-requests": "read", actions: "write" });
  assert.equal(doc.jobs["package-tests"].permissions, undefined, "suite jobs inherit only contents:read");
  assert.equal(doc.jobs.plan.steps.at(-1).env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(doc.jobs.plan.outputs.group, undefined);

  const job = doc.jobs["package-tests"];
  assert.equal(job.if, undefined, "a job-level condition would report a skipped required check as successful");
  assert.equal(job.name, "${{ matrix.check }}");
  assert.deepEqual(job.needs, "plan");
  assert.equal(job.strategy.matrix.include, "${{ fromJSON(needs.plan.outputs.matrix) }}");
  assert.equal(job.concurrency, undefined);
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

const run = (id, head = HEAD, extra = {}) => ({ id, run_number: id, run_attempt: 1, workflow_id: 42,
  updated_at: new Date(id * 1000).toISOString(), event: "pull_request_review", head_sha: head, status: "queued", conclusion: null, pull_requests: [{ number: 7 }], ...extra });
const passedJobs = () => REQUIRED_MACOS.map(name => ({ name, status: "completed", conclusion: "success" }));
function fixture({ runs = [], current = run(200), head = HEAD, review = approval().review, jobs = {}, refusal, target } = {}) {
  const calls = [], logs = []; let reads = 0;
  const api = async (path, method = "GET") => {
    calls.push({ path, method });
    if (path === "/pulls/7") return { state: "open", head: { sha: typeof head === "function" ? head(++reads) : head } };
    if (path === "/pulls/7/reviews/19") return review;
    const m = path.match(/^\/actions\/runs\/(\d+)(\/cancel)?$/);
    if (m) {
      const id = Number(m[1]);
      if (method === "POST") { if (refusal) throw new Error(refusal); return { status: 202 }; }
      return id === current.id ? current : target?.(id) ?? runs.find(r => r.id === id);
    }
    const url = new URL(path, "http://fixture");
    const offset = (Number(url.searchParams.get("page")) - 1) * 100;
    if (url.pathname === "/actions/workflows/42/runs") {
      const selected = runs.filter(r => r.status === url.searchParams.get("status"));
      return { workflow_runs: selected.slice(offset, offset + 100) };
    }
    const j = url.pathname.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
    if (j) return { jobs: (jobs[Number(j[1])] ?? []).slice(offset, offset + 100) };
    throw new Error("Unexpected API call " + path);
  };
  return { api, calls, logs, posts: () => calls.filter(c => c.method === "POST"),
    plan: (event = approval(), attempt = current.id, eventName = "pull_request_review") =>
      reconcileMacosPackageTests(eventName, event, attempt, api, line => logs.push(line)) };
}

test("an eligible current head cancels only this workflow's older obsolete review runs", async () => {
  const f = fixture({ runs: [run(10, OLDER), run(11, OLDER, { status: "in_progress" }), run(12),
    run(13, OLDER, { pull_requests: [{ number: 8 }] }), run(14, OLDER, { workflow_id: 99 }),
    run(15, OLDER, { event: "workflow_dispatch" }), run(300, OLDER), run(16, undefined, { head_sha: undefined })] });
  assert.equal((await f.plan()).eligible, true);
  assert.deepEqual(f.posts().map(c => c.path), ["/actions/runs/10/cancel", "/actions/runs/11/cancel"]);
});

test("delayed old events and their retries cannot cancel the newer useful head", async () => {
  for (const run_attempt of [1, 2]) {
    const f = fixture({ current: run(10, OLDER, { run_attempt }), runs: [run(200)], head: HEAD });
    const p = await f.plan(approval({ head: OLDER, review: { commit_id: OLDER } }), 10);
    assert.deepEqual(checks(p), [PLACEHOLDER_CHECK]); assert.equal(f.posts().length, 0);
  }
});

test("comments, requested changes, non-counting/stale approvals and manuals make no live cancellation calls", async () => {
  for (const [eventName, event] of [["workflow_dispatch", {}], ["pull_request_review", approval({ review: { state: "commented" } })],
    ["pull_request_review", approval({ review: { state: "changes_requested" } })],
    ["pull_request_review", approval({ review: { author_association: "NONE" } })],
    ["pull_request_review", approval({ review: { commit_id: OLDER } })]]) {
    const f = fixture(); const p = await f.plan(event, 200, eventName);
    assert.equal(p.eligible, false); assert.deepEqual(f.calls, []);
  }
});

test("a dismissed approval and a head that moves before cancellation cannot retire current coverage", async () => {
  for (const options of [{ review: { ...approval().review, state: "DISMISSED" } }, { head: n => n === 1 ? HEAD : OLDER }]) {
    const f = fixture({ runs: [run(10, OLDER)], ...options });
    assert.equal((await f.plan()).eligible, false); assert.deepEqual(f.posts(), []);
  }
});

test("a repeat approval reuses only a completed pair of genuine required macOS jobs", async () => {
  const complete = run(10, HEAD, { status: "completed", conclusion: "success" });
  const good = fixture({ runs: [complete], jobs: { 10: passedJobs() } });
  assert.deepEqual(checks(await good.plan()), [PLACEHOLDER_CHECK]);
  for (const jobs of [[], [{ name: PLACEHOLDER_CHECK, status: "completed", conclusion: "success" }],
    MANUAL_ENTRIES.map(e => ({ name: e.check, status: "completed", conclusion: "success" })),
    passedJobs().slice(0, 1), passedJobs().map((j, i) => i ? { ...j, conclusion: "failure" } : j)]) {
    const f = fixture({ runs: [complete], jobs: { 10: jobs } });
    assert.deepEqual(checks(await f.plan()), REQUIRED_MACOS);
  }
  for (const wrong of [{ head_sha: OLDER }, { pull_requests: [{ number: 8 }] }, { event: "workflow_dispatch" }, { conclusion: "failure" }]) {
    const f = fixture({ runs: [{ ...complete, ...wrong }], jobs: { 10: passedJobs() } });
    assert.equal((await f.plan()).eligible, true);
  }
});

test("an explicit current-head retry executes both suites and observes the target's latest attempt", async () => {
  const f = fixture({ current: run(200, HEAD, { run_attempt: 2 }), runs: [run(10, OLDER), run(20, HEAD, { status: "completed", conclusion: "success" })],
    jobs: { 20: passedJobs() }, target: id => run(id, OLDER, { run_attempt: 4 }) });
  assert.deepEqual(checks(await f.plan()), REQUIRED_MACOS);
  assert.match(f.logs.join("\n"), /run 10, attempt 4/);
});

test("a target that finished after listing is not canceled", async () => {
  const f = fixture({ runs: [run(10, OLDER)], target: id => run(id, OLDER, { status: "completed" }) });
  assert.equal((await f.plan()).eligible, true); assert.deepEqual(f.posts(), []);
});

test("native cancellation refusals are recorded once without force or lost current-head suites", async () => {
  for (const refusal of ["POST /actions/runs/10/cancel: HTTP 403: Resource not accessible by integration", "HTTP 409: run completed"]) {
    const f = fixture({ runs: [run(10, OLDER)], refusal });
    assert.equal((await f.plan()).eligible, true); assert.equal(f.posts().length, 1);
    assert.ok(f.logs.some(line => line.includes(refusal))); assert.ok(f.posts().every(c => !c.path.includes("force")));
  }
});

test("all pages of older active runs are considered", async () => {
  const runs = Array.from({ length: 101 }, (_, i) => run(i + 1, OLDER));
  const f = fixture({ runs }); assert.equal((await f.plan()).eligible, true);
  assert.equal(f.posts().length, 101); assert.ok(f.calls.some(c => c.path.includes("page=2")));
});

test("unknown GitHub identity stops reconciliation without a successful required placeholder or a cancellation", async () => {
  const f = fixture({ current: run(200, HEAD, { pull_requests: [] }) });
  await assert.rejects(f.plan(), /identity/); assert.deepEqual(f.posts(), []);
});

test("a fork's approval runs both suites; its peer runs also carry a PR-number title", async () => {
  // GitHub leaves a workflow run's pull_requests empty for a pull request from a fork.
  const forkRun = (id, head = HEAD, extra = {}) => run(id, head, { pull_requests: [], head_repository: { full_name: "contrib/openrig" },
    head_branch: "feature", display_title: "macOS package tests PR #7", ...extra });
  const forkApproval = () => { const e = approval();
    return { ...e, repository: { full_name: "mvschwarz/openrig" }, pull_request: { ...e.pull_request, head: { ...e.pull_request.head, ref: "feature", repo: { full_name: "contrib/openrig" } } } }; };
  const f = fixture({ current: forkRun(200), runs: [forkRun(10, OLDER), forkRun(11, OLDER, { head_repository: { full_name: "other/openrig" } }),
    run(12, OLDER, { pull_requests: [], head_branch: "feature", head_repository: { full_name: "mvschwarz/openrig" } })] });
  const plan = await f.plan(forkApproval());
  assert.deepEqual(checks(plan), REQUIRED_MACOS);
  // Only the same fork branch's older run is a cancellation target (a fork's read-only token may refuse it; that's logged).
  assert.deepEqual(f.posts().map(c => c.path), ["/actions/runs/10/cancel"]);
  // A repeat approval of the fork's head reuses its own genuine pair, as for a same-repository pull request.
  const repeat = fixture({ current: forkRun(201), runs: [forkRun(20, HEAD, { status: "completed", conclusion: "success" })], jobs: { 20: passedJobs() } });
  assert.deepEqual(checks(await repeat.plan(forkApproval(), 201)), [PLACEHOLDER_CHECK]);
});

test("the GitHub adapter uses the scoped token and preserves a native refusal", async () => {
  assert.throws(() => githubApi("owner/repo", ""), /GITHUB_TOKEN/);
  let captured;
  const api = githubApi("owner/repo", "fixture-token", "https://api.github.com", async (url, options) => {
    captured = { url, options }; return new Response(null, { status: 202 });
  });
  assert.deepEqual(await api("/actions/runs/10/cancel", "POST"), { status: 202 });
  assert.equal(captured.url, "https://api.github.com/repos/owner/repo/actions/runs/10/cancel");
  assert.equal(captured.options.headers.authorization, "Bearer fixture-token");
  const refused = githubApi("owner/repo", "fixture-token", undefined, async () => new Response("Resource not accessible by integration", { status: 403 }));
  await assert.rejects(refused("/actions/runs/10/cancel", "POST"), /HTTP 403: Resource not accessible by integration/);
});

test("the real planner entry point writes an eligible matrix after API reconciliation", async () => {
  const f = fixture({ runs: [run(10, OLDER)] });
  const server = createServer(async (req, res) => {
    try { const result = await f.api(req.url.replace("/repos/owner/repo", ""), req.method); res.writeHead(req.method === "POST" ? 202 : 200); res.end(JSON.stringify(result)); }
    catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "ci-macos-live-")), eventPath = path.join(dir, "event.json"), outputPath = path.join(dir, "output");
    writeFileSync(eventPath, JSON.stringify(approval()));
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "ci-macos-ready-plan.mjs")], { env: { PATH: process.env.PATH,
      GITHUB_EVENT_NAME: "pull_request_review", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
      GITHUB_RUN_ID: "200", GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "fixture-token", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
    const code = await new Promise(resolve => child.on("close", resolve)); assert.equal(code, 0, out);
    const output = readFileSync(outputPath, "utf8"); assert.match(output, /eligible=true/); assert.match(output, /package-tests \(daemon\)/);
    assert.equal(f.posts().length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("an earlier pass cannot hide a later failing attempt on the same head", async () => {
  const success = run(10, HEAD, { status: "completed", conclusion: "success" });
  const failed = run(20, HEAD, { status: "completed", conclusion: "failure", run_attempt: 3 });
  const f = fixture({ runs: [success, failed], jobs: { 10: passedJobs(), 20: passedJobs().map(j => ({ ...j, conclusion: "failure" })) } });
  assert.deepEqual(checks(await f.plan()), REQUIRED_MACOS);
  assert.ok(f.calls.some(c => c.path.includes("/runs/20/attempts/3/jobs")));
  const unknown = fixture({ runs: [{ ...success, updated_at: undefined }], jobs: { 10: passedJobs() } });
  assert.deepEqual(checks(await unknown.plan()), REQUIRED_MACOS);
});

test("one fork branch's other PR and unmarked legacy runs cannot be canceled or reused", async () => {
  const forkRun = (id, head = HEAD, extra = {}) => run(id, head, { pull_requests: [], head_repository: { full_name: "contrib/openrig" },
    head_branch: "feature", display_title: "macOS package tests PR #7", ...extra });
  const e = approval(); const event = { ...e, repository: { full_name: "mvschwarz/openrig" }, pull_request: { ...e.pull_request,
    head: { ...e.pull_request.head, ref: "feature", repo: { full_name: "contrib/openrig" } } } };
  // The current event knows its own fork PR even on an older, unmarked workflow attempt.
  const f = fixture({ current: forkRun(200, HEAD, { display_title: "old title" }), runs: [
    forkRun(10, OLDER, { display_title: "macOS package tests PR #8" }), forkRun(11, OLDER, { display_title: "old title" }),
    forkRun(12, HEAD, { display_title: "macOS package tests PR #8", status: "completed", conclusion: "success" }),
    forkRun(13, HEAD, { display_title: "old title", status: "completed", conclusion: "success" })],
    jobs: { 12: passedJobs(), 13: passedJobs() } });
  assert.deepEqual(checks(await f.plan(event)), REQUIRED_MACOS); assert.deepEqual(f.posts(), []);
});

test("a throwing reconcile API still writes the required matrix from the real entry point", async () => {
  const api = async () => { throw new Error("fixture API unavailable"); };
  const server = createServer(async (_req, res) => {
    try { await api(); } catch (error) { res.writeHead(503); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "ci-macos-fallback-")), eventPath = path.join(dir, "event.json"), outputPath = path.join(dir, "output");
    writeFileSync(eventPath, JSON.stringify(approval()));
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "ci-macos-ready-plan.mjs")], { env: { PATH: process.env.PATH,
      GITHUB_EVENT_NAME: "pull_request_review", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
      GITHUB_RUN_ID: "200", GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "fixture-token", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
    const code = await new Promise(resolve => child.on("close", resolve)); assert.equal(code, 0, out);
    const output = Object.fromEntries(readFileSync(outputPath, "utf8").trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    assert.equal(output.eligible, "true"); assert.equal(output.head, HEAD);
    assert.deepEqual(JSON.parse(output.matrix), MACOS_ENTRIES);
    assert.match(out, /::warning::.*using the plain suite plan.*HTTP 503/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
