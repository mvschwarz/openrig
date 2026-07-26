#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildInternalLeakMessage,
  scanInternalLeaks,
} from "./internal-leak-scanner.mjs";

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const rules = readRules(options.rules);
  const files = selectFiles(options);
  const findings = files.flatMap(({ path, bytes }) =>
    scanInternalLeaks({ path, bytes, rules }),
  );

  if (findings.length > 0) {
    process.stderr.write(`${buildInternalLeakMessage(findings)}\n`);
    return 1;
  }
  return 0;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    values[key.slice(2)] = value;
  }
  if (!values.repo || !values.rules || !values.mode) {
    throw new Error("--repo, --rules, and --mode are required");
  }
  if (!["full", "staged", "range"].includes(values.mode)) {
    throw new Error(`Unknown mode: ${values.mode}`);
  }
  if (values.mode === "range" && (!values.from || !values.to)) {
    throw new Error("--from and --to are required for range mode");
  }
  return {
    ...values,
    repo: resolve(values.repo),
    rules: resolve(values.rules),
  };
}

function readRules(path) {
  if (!existsSync(path)) throw new Error(`Rules file not found: ${path}`);
  try {
    const rules = JSON.parse(readFileSync(path, "utf8"));
    validateRules(rules, path);
    return rules;
  } catch (error) {
    if (error.message.startsWith(`Invalid rules file ${path}:`)) throw error;
    throw new Error(`Invalid rules file ${path}: ${error.message}`);
  }
}

function selectFiles(options) {
  if (options.mode === "full") {
    return splitNul(git(options.repo, ["ls-files", "-z"]))
      .filter((path) => existsSync(resolve(options.repo, path)))
      .map((path) => ({
        path,
        bytes: readFileSync(resolve(options.repo, path)),
      }));
  }

  if (options.mode === "staged") {
    return splitNul(
      git(options.repo, [
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
      ]),
    ).map((path) => ({
      path,
      bytes: git(options.repo, ["show", `:${path}`]),
    }));
  }

  const commits = git(options.repo, [
    "rev-list",
    "--reverse",
    `${options.from}..${options.to}`,
  ])
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return commits.flatMap((commit) =>
    changedPathsAtCommit(options.repo, commit).map((path) => ({
      path,
      bytes: git(options.repo, ["show", `${commit}:${path}`]),
    })),
  );
}

function changedPathsAtCommit(repo, commit) {
  const ancestry = git(repo, ["rev-list", "--parents", "-n", "1", commit])
    .toString("utf8")
    .trim()
    .split(/\s+/);
  const parents = ancestry.slice(1);
  if (parents.length === 0) {
    return splitNul(git(repo, ["ls-tree", "-r", "--name-only", "-z", commit]));
  }
  return [
    ...new Set(
      parents.flatMap((parent) =>
        splitNul(
          git(repo, [
            "diff",
            "--name-only",
            "--diff-filter=ACMR",
            "-z",
            parent,
            commit,
          ]),
        ),
      ),
    ),
  ].sort();
}

function validateRules(rules, path) {
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error(`Invalid rules file ${path}: rules must be an object`);
  }
  for (const field of [
    "path_prefixes",
    "seat_and_rig_patterns",
    "host_patterns",
    "charged_terms",
    "internal_path_globs",
    "allowed_context_substrings",
  ]) {
    if (
      !Array.isArray(rules[field]) ||
      rules[field].length === 0 ||
      rules[field].some((value) => typeof value !== "string" || value === "")
    ) {
      throw new Error(
        `Invalid rules file ${path}: ${field} must be a nonempty string array`,
      );
    }
  }
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo });
}

function splitNul(bytes) {
  return bytes
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
