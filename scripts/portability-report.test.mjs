import test from "node:test";
import assert from "node:assert/strict";
import { addedLines, findPortabilityIssues, renderReport } from "./portability-report.mjs";

const diff = [
  "diff --git a/docs/a.md b/docs/a.md",
  "--- a/docs/a.md",
  "+++ b/docs/a.md",
  "@@ -1,0 +10,2 @@",
  "+Clone into /Users/alice/code/app first.",
  "+Nothing machine-specific here.",
  "diff --git a/old.md b/old.md",
  "+++ /dev/null",
  "+ignored because the file is deleted",
].join("\n");

test("reads only added lines with their new line numbers", () => {
  assert.deepEqual(addedLines(diff), [
    { file: "docs/a.md", line: 10, text: "Clone into /Users/alice/code/app first." },
    { file: "docs/a.md", line: 11, text: "Nothing machine-specific here." },
  ]);
});

function categories(text) {
  return findPortabilityIssues([{ file: "f", line: 1, text }]).map((finding) => finding.category);
}

test("reports each principle's typical cases", () => {
  assert.deepEqual(categories("key = 'ghp_" + "a".repeat(36) + "'"), ["Credential"]);
  assert.deepEqual(categories("-----BEGIN OPENSSH PRIVATE KEY-----"), ["Credential"]);
  assert.deepEqual(categories("see /home/bob/project"), ["Home path"]);
  assert.deepEqual(categories("cache in /private/tmp/claude-501/x"), ["Machine path"]);
  assert.deepEqual(categories("ssh 100.95.1.2"), ["Network address"]);
  assert.deepEqual(categories("reach build-box.local"), ["Network address"]);
  assert.deepEqual(categories("mail jane.doe@acme.io"), ["Email address"]);
});

test("placeholders, loopback, documentation ranges and product names are not reported", () => {
  for (const text of [
    "cd /Users/example/repo",
    "cd /home/user/repo",
    "listen on 127.0.0.1:7433",
    "docs address 192.0.2.10",
    "noreply@anthropic.com",
    "dev@example.com",
    "send to operator-agent@kernel and orch-lead@v-openrig-build",
    "token = process.env.GITHUB_TOKEN",
    'const token = "00000000-0000-7000-8000-000000000001";',
    'resume_token : "other-thread"',
    "edit .claude/settings.local.json",
    "id: OPR.99.0.1.1",
    "release v2.0.0.1",
    "maintainers at conduct@openrig.dev",
  ]) {
    assert.deepEqual(categories(text), [], text);
  }
});

test("the report never repeats a suspected credential", () => {
  const secret = "ghp_" + "Zz9".repeat(12);
  const report = renderReport(
    findPortabilityIssues([{ file: "f", line: 1, text: `const key = "${secret}"` }]),
    "x..y",
  );
  assert.match(report, /## Credential \(1\)/);
  assert.ok(!report.includes(secret.slice(6)), report);
});

test("a credential on the same line as another finding is withheld from every category", () => {
  const secret = "ghp_" + "Qx7".repeat(12);
  const lines = [
    { file: "f", line: 1, text: `token = "${secret}" in /Users/alice/.config and 100.95.1.2` },
  ];
  const findings = findPortabilityIssues(lines);
  assert.deepEqual(
    findings.map((finding) => finding.category),
    ["Credential", "Home path", "Network address"],
  );
  const report = renderReport(findings, "x..y");
  assert.ok(!report.includes(secret.slice(6)), report);
  assert.match(report, /\/Users\/alice\//);
  assert.match(report, /100\.95\.1\.2/);
});

test("locations-only output names file and line without quoting the matched text", () => {
  const findings = findPortabilityIssues(addedLines(diff));
  const report = renderReport(findings, "x..y", { locationsOnly: true });
  assert.match(report, /## Home path \(1\)/);
  assert.match(report, /- `docs\/a\.md:10`/);
  assert.ok(!report.includes("/Users/alice/"), report);
});

test("the report says so when nothing is found and groups findings when something is", () => {
  assert.match(renderReport([], "x..y"), /No matching machine-specific values detected/);
  const report = renderReport(findPortabilityIssues(addedLines(diff)), "x..y");
  assert.match(report, /## Home path \(1\)/);
  assert.match(report, /docs\/a\.md:10/);
});
