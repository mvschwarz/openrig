#!/usr/bin/env node

// Lists lines added by a change that contain values tied to one machine, network or account, so
// the author can replace them with portable ones or keep them on purpose. Findings never fail it: a finding is a question, not a verdict. It exits 0
// with or without findings and 2 on an operational error (bad argument, git failure).
//
// What it looks for:
//   1. Credentials: keys, tokens, passwords, key blocks.
//   2. Absolute home paths, IP addresses and local-network hostnames.
//   3. Temporary and instance-specific directories.
//   4. Email addresses.
// Rig, seat and agent names are ordinary identifiers and are not reported.
//
// Usage:
//   node scripts/portability-report.mjs                      # merge-base with origin/main .. HEAD
//   node scripts/portability-report.mjs --from A --to B      # a commit range
//   node scripts/portability-report.mjs --staged             # what is staged for the next commit
//   add --out report.md to also write the report to a file

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const CHECKS = [
  {
    category: "Credential",
    why: "looks like a credential; load it from the environment or a secret store instead",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|pk_(?:live|test)_[A-Za-z0-9]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b|\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'](?![0-9a-f]{8}-[0-9a-f]{4}-)(?=[^"']*\d)(?=[^"']*[A-Za-z])[^"'\s$<{]{16,}["']/i,
  },
  {
    category: "Home path",
    why: "absolute path under one person's home directory; will not exist on another machine",
    pattern: /(?:\/Users|\/home)\/(?!(?:example|you|your-?name|username|user|me|someone|name|op|x|test|tester|runner)\/)[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\(?!(?:example|you|user|username)\\)[A-Za-z0-9._-]+\\/,
  },
  {
    category: "Machine path",
    why: "temporary or instance-specific directory tied to one machine",
    pattern: /\/private\/tmp\/[A-Za-z0-9._-]+|\/var\/folders\/[A-Za-z0-9_]+\/|\/tmp\/claude-\d+|\.openrig-[a-z0-9-]*-[0-9a-f]{6,}/,
  },
  {
    category: "Network address",
    why: "IP address or local-network hostname that only resolves on one network",
    pattern: /(?<![\w.])(?!127\.|0\.0\.0\.0(?![\w.])|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])|(?<![\w.-])[a-z0-9-]+\.(?:local|lan|internal|ts\.net|home\.arpa)\b(?![.\w-])/i,
  },
  {
    category: "Email address",
    why: "contact details belong in project documentation, not in code",
    pattern: /\b(?![A-Za-z0-9._%+-]*noreply)[A-Za-z0-9._%+-]+@(?!(?:example|test|localhost|openrig)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/,
  },
];

// Parses `git diff -U0` output into the lines it adds, with their new line numbers.
export function addedLines(diffText) {
  const lines = [];
  let file = null;
  let lineNumber = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.replace(/^\+\+\+ b\//, "");
    } else if (raw.startsWith("@@")) {
      lineNumber = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (file && raw.startsWith("+")) {
      lines.push({ file, line: lineNumber, text: raw.slice(1) });
      lineNumber += 1;
    }
  }
  return lines;
}

export function findPortabilityIssues(lines, checks = CHECKS) {
  const findings = [];
  for (const entry of lines) {
    for (const check of checks) {
      const match = check.pattern.exec(entry.text);
      if (match) findings.push({ ...entry, category: check.category, why: check.why, match: match[0] });
    }
  }
  return findings;
}

export function renderReport(findings, label) {
  const out = [`# Portability report: ${label}`, ""];
  if (findings.length === 0) {
    out.push("No added line contains a machine-specific value.");
    return `${out.join("\n")}\n`;
  }
  out.push(
    `${findings.length} added line(s) contain values that may not work on another machine. For each`,
    "one, replace it with a portable value or placeholder, or keep it because it is intended.",
    "",
  );
  // A report can be public (a CI summary), so a suspected credential is never repeated in it,
  // including through another category's excerpt of the same line.
  const secretsByLine = new Map();
  for (const { file, line, match, category } of findings) {
    if (category !== "Credential") continue;
    const key = `${file}:${line}`;
    secretsByLine.set(key, [...(secretsByLine.get(key) ?? []), match]);
  }
  const withhold = (value, key) =>
    (secretsByLine.get(key) ?? []).reduce((text, secret) => text.replaceAll(secret, "[withheld]"), value);
  for (const check of CHECKS) {
    const group = findings.filter((finding) => finding.category === check.category);
    if (group.length === 0) continue;
    out.push(`## ${check.category} (${group.length})`, "", `_${check.why}_`, "");
    for (const { file, line, match, text } of group) {
      if (check.category === "Credential") {
        out.push(`- \`${file}:${line}\` matched \`${match.slice(0, 6)}…\` (value withheld)`);
        continue;
      }
      const key = `${file}:${line}`;
      const safe = withhold(text.trim(), key);
      const excerpt = safe.length > 140 ? `${safe.slice(0, 140)}…` : safe;
      out.push(`- \`${key}\` matched \`${withhold(match, key)}\`: ${excerpt.replaceAll("|", "\\|")}`);
    }
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { staged: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--staged") options.staged = true;
    else if (["--from", "--to", "--out", "--repo"].includes(key)) options[key.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument: ${key}`);
  }
  return options;
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const repo = resolve(options.repo ?? ".");
  let range;
  let label;
  if (options.staged) {
    range = ["--cached"];
    label = "staged changes";
  } else {
    const to = options.to ?? "HEAD";
    const from = options.from ?? git(repo, ["merge-base", "origin/main", to]).trim();
    range = [`${from}..${to}`];
    label = `${from.slice(0, 8)}..${to.length > 12 ? to.slice(0, 8) : to}`;
  }
  const diff = git(repo, ["diff", "-U0", "--no-color", "--diff-filter=ACMR", ...range]);
  const report = renderReport(findPortabilityIssues(addedLines(diff)), label);
  process.stdout.write(report);
  if (options.out) writeFileSync(options.out, report);
  return 0;
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
