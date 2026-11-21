import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./ci-vitest-summary.mjs";

const script = fileURLToPath(new URL("ci-vitest-summary.mjs", import.meta.url));
const root = "/repo";
const report = {
  testResults: [
    {
      name: "/repo/packages/daemon/test/a.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        { fullName: " a passes", status: "passed", location: { line: 3, column: 1 } },
        { fullName: " a fails", status: "failed", location: { line: 7, column: 1 } },
        { fullName: " a needs zsh", status: "skipped", location: { line: 11, column: 1 } },
        { fullName: " a later", status: "todo", location: { line: 15, column: 1 } },
      ],
    },
    {
      name: "/repo/packages/daemon/test/broken.test.ts",
      status: "failed",
      message: "Failed to load url ./missing.js\n    at stack",
      assertionResults: [],
    },
  ],
};

test("lists every test that did not pass, with its file and line", () => {
  const text = summarize(report, root);
  assert.match(text, /^Files: 2\. Tests: 1 passed, 1 failed, 1 skipped, 1 todo\.$/m);
  assert.match(text, /### Failed \(1\)\n\n- `packages\/daemon\/test\/a\.test\.ts:7` a fails/);
  assert.match(text, /### Skipped or todo: these did not run \(2\)/);
  assert.match(text, /- `packages\/daemon\/test\/a\.test\.ts:11` a needs zsh \(skipped\)/);
  assert.match(text, /- `packages\/daemon\/test\/a\.test\.ts:15` a later \(todo\)/);
  assert.match(text, /### Failed files, including load and hook errors \(2\)/);
  assert.match(text, /- `packages\/daemon\/test\/a\.test\.ts` failed; see its failed tests$/m);
  assert.match(text, /- `packages\/daemon\/test\/broken\.test\.ts` Failed to load url \.\/missing\.js$/m);
  assert.doesNotMatch(text, /a passes/);
});

test("lists a failed file whose assertions all passed, as an afterAll failure leaves it", () => {
  const text = summarize({ testResults: [{ name: "/repo/hook.test.ts", status: "failed",
    message: "afterAll cleanup failed\n    at stack",
    assertionResults: [{ fullName: " hook passes", status: "passed", location: { line: 4, column: 1 } }] }] }, root);
  assert.match(text, /^Files: 1\. Tests: 1 passed, 0 failed, 0 skipped, 0 todo\.$/m);
  assert.match(text, /### Failed files, including load and hook errors \(1\)\n\n- `hook\.test\.ts` afterAll cleanup failed$/m);
});

test("counts an unexpected status instead of dropping it", () => {
  const text = summarize({ testResults: [{ name: "/repo/x.test.ts", status: "passed",
    assertionResults: [{ fullName: "x", status: "pending" }] }] }, root);
  assert.match(text, /0 skipped, 0 todo, 1 other\./);
  assert.match(text, /- `x\.test\.ts` x \(pending\)/);
});

test("caps long lists and says how many it left out", () => {
  const assertionResults = Array.from({ length: 305 }, (_, i) => ({ fullName: `t${i}`, status: "skipped" }));
  const text = summarize({ testResults: [{ name: "/repo/x.test.ts", status: "passed", assertionResults }] }, root);
  assert.match(text, /### Skipped or todo: these did not run \(305\)/);
  assert.match(text, /- … and 5 more in the JSON report/);
  assert.doesNotMatch(text, /t300 /);
});

test("fails loudly when the report is missing or unreadable", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-vitest-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = spawnSync(process.execPath, [script, join(dir, "none.json")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No readable vitest report/);
  writeFileSync(join(dir, "partial.json"), "{\"testResults\": [");
  const partial = spawnSync(process.execPath, [script, join(dir, "partial.json")], { encoding: "utf8" });
  assert.equal(partial.status, 1);
  const usage = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("prints the summary for a readable report", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-vitest-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "report.json"), JSON.stringify({ testResults: [] }));
  const result = spawnSync(process.execPath, [script, join(dir, "report.json")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Files: 0. Tests: 0 passed, 0 failed, 0 skipped, 0 todo.\n");
});
