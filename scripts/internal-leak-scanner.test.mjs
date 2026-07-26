import test from "node:test";
import assert from "node:assert/strict";

test("scanner blocks internal paths before reading content", async () => {
  const scanner = await loadScanner();
  const findings = scanner.scanInternalLeaks({
    path: "skills/openrig-user/internal/host.md",
    bytes: Buffer.from("clean text\n"),
    rules: fixtureRules(),
  });

  assert.deepEqual(findings, [
    {
      file: "skills/openrig-user/internal/host.md",
      token: "**/internal/**",
      line: 1,
      remedy: scanner.INTERNAL_LEAK_REMEDY,
      kind: "path",
    },
  ]);
});

test("scanner reports case-insensitive text tokens with file, token, line, and remedy", async () => {
  const scanner = await loadScanner();
  const findings = scanner.scanInternalLeaks({
    path: "skills/public/SKILL.md",
    bytes: Buffer.from("# Public\nContact OPERATOR-AGENT@kernel.\n"),
    rules: fixtureRules(),
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    file: "skills/public/SKILL.md",
    token: "operator-agent@",
    line: 2,
    remedy: scanner.INTERNAL_LEAK_REMEDY,
    kind: "content",
  });
  assert.match(scanner.buildInternalLeakMessage(findings), /skills\/public\/SKILL\.md/);
  assert.match(scanner.buildInternalLeakMessage(findings), /operator-agent@/);
  assert.match(scanner.buildInternalLeakMessage(findings), /line 2/i);
  assert.match(scanner.buildInternalLeakMessage(findings), /sidecar|fence|genericize|host-only/i);
});

test("scanner honors an allowed-context substring on the same line only", async () => {
  const scanner = await loadScanner();
  const findings = scanner.scanInternalLeaks({
    path: "skills/public/SKILL.md",
    bytes: Buffer.from(
      [
        "Do not ship operator-agent@ examples.",
        "A later operator-agent@ reference is still a leak.",
        "",
      ].join("\n"),
    ),
    rules: fixtureRules(),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test("scanner finds tokens in NUL-containing bytes and does not crash on clean binary bytes", async () => {
  const scanner = await loadScanner();
  const planted = scanner.scanInternalLeaks({
    path: "skills/public/fixture.bin",
    bytes: Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from("mm2-secret"),
      Buffer.from([0, 255]),
    ]),
    rules: fixtureRules(),
  });
  assert.ok(planted.some((finding) => finding.token === "mm2-"));

  assert.doesNotThrow(() =>
    scanner.scanInternalLeaks({
      path: "skills/public/clean.bin",
      bytes: Buffer.from([0, 1, 2, 3, 255]),
      rules: fixtureRules(),
    }),
  );
});

test("scanner returns findings in deterministic path/token/line order", async () => {
  const scanner = await loadScanner();
  const findings = scanner.scanInternalLeaks({
    path: "skills/public/SKILL.md",
    bytes: Buffer.from("founder\noperator-agent@kernel\nfounder\n"),
    rules: fixtureRules(),
  });

  assert.deepEqual(
    findings.map(({ token, line }) => ({ token, line })),
    [
      { token: "founder", line: 1 },
      { token: "operator-agent@", line: 2 },
      { token: "founder", line: 3 },
    ],
  );
});

async function loadScanner() {
  const moduleUrl = new URL("./internal-leak-scanner.mjs", import.meta.url);
  const scanner = await import(moduleUrl).catch(() => null);
  assert.ok(scanner, "scripts/internal-leak-scanner.mjs must exist");
  assert.equal(typeof scanner.scanInternalLeaks, "function");
  assert.equal(typeof scanner.buildInternalLeakMessage, "function");
  return scanner;
}

function fixtureRules() {
  return {
    path_prefixes: ["openrig-work/"],
    seat_and_rig_patterns: ["operator-agent@"],
    host_patterns: ["mm2-"],
    charged_terms: ["founder"],
    internal_path_globs: ["*.internal.*", "**/internal/**", "*-internal/**"],
    allowed_context_substrings: ["do not ship"],
  };
}
