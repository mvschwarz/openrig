// Summarise a vitest JSON report (--reporter=json --includeTaskLocation) as Markdown:
// counts by status, then each failed file and each test that did not pass, with its file
// and line, up to LIST_LIMIT rows per section (the JSON report keeps the complete list).
// Skipped and todo tests are listed by name so they are never read as passes.
// Exits non-zero only when the report is missing or unreadable; the suite step
// carries the test result itself.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";

const LIST_LIMIT = 300;

function section(title, rows) {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, LIST_LIMIT).map(([where, text]) => `- \`${where}\` ${text}`);
  const rest = rows.length > LIST_LIMIT ? [`- … and ${rows.length - LIST_LIMIT} more in the JSON report`] : [];
  return ["", `### ${title} (${rows.length})`, "", ...shown, ...rest];
}

export function summarize(report, root = process.cwd()) {
  const files = report.testResults ?? [];
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, other: 0 };
  const failedFiles = [];
  const failed = [];
  const notRun = [];
  for (const file of files) {
    const path = relative(root, file.name);
    const tests = file.assertionResults ?? [];
    // A file can fail with every assertion passing (a load error, or an afterAll hook), so list it on its own.
    if (file.status === "failed") {
      failedFiles.push([path, (file.message || "failed; see its failed tests").split("\n")[0]]);
    }
    for (const test of tests) {
      const where = test.location ? `${path}:${test.location.line}` : path;
      const name = test.fullName.trim();
      if (test.status === "passed") {
        counts.passed++;
      } else if (test.status === "failed") {
        counts.failed++;
        failed.push([where, name]);
      } else {
        counts[test.status === "skipped" || test.status === "todo" ? test.status : "other"]++;
        notRun.push([where, `${name} (${test.status})`]);
      }
    }
  }
  const totals = `Files: ${files.length}. Tests: ${counts.passed} passed, ${counts.failed} failed, ` +
    `${counts.skipped} skipped, ${counts.todo} todo${counts.other ? `, ${counts.other} other` : ""}.`;
  return [
    totals,
    ...section("Failed files, including load and hook errors", failedFiles),
    ...section("Failed", failed),
    ...section("Skipped or todo: these did not run", notRun),
  ].join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: ci-vitest-summary.mjs <vitest-report.json>");
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`No readable vitest report at ${file}: ${error.message}`);
    process.exit(1);
  }
  process.stdout.write(summarize(report));
}
