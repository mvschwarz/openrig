#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

  if (options.report) {
    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(options.report, `${JSON.stringify({
      mode: options.mode,
      scannedFiles: files.map(({ path }) => path),
      findingCount: findings.length,
    }, null, 2)}\n`);
  }

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
  if (!["full", "staged", "range", "tree"].includes(values.mode)) {
    throw new Error(`Unknown mode: ${values.mode}`);
  }
  if (values.mode === "range" && (!values.from || !values.to)) {
    throw new Error("--from and --to are required for range mode");
  }
  if (values.mode === "tree" && !values.tree) {
    throw new Error("--tree is required for tree mode");
  }
  if (values["files-manifest"] && (values.mode !== "full" || !values.tree)) {
    throw new Error("--files-manifest requires --mode full and --tree");
  }
  return {
    ...values,
    repo: resolve(values.repo),
    rules: resolve(values.rules),
    ...(values.tree ? { tree: resolve(values.tree) } : {}),
    ...(values["files-manifest"] ? { filesManifest: resolve(values["files-manifest"]) } : {}),
    ...(values.report ? { report: resolve(values.report) } : {}),
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
  if (options.mode === "tree") {
    if (!existsSync(options.tree)) {
      throw new Error(`Tree not found: ${options.tree}`);
    }
    return walkTree(options.tree).map((path) => ({
      path: relative(options.repo, path).replaceAll("\\", "/"),
      bytes: readFileSync(path),
    }));
  }

  if (options.mode === "full") {
    if (options.filesManifest) {
      return readFilesManifest(options.filesManifest).map((path) => {
        const absolutePath = resolve(options.tree, path);
        if (absolutePath !== options.tree && !absolutePath.startsWith(`${options.tree}/`)) {
          throw new Error(`Artifact path escapes scan tree: ${path}`);
        }
        if (!existsSync(absolutePath)) throw new Error(`Artifact file not found under scan tree: ${path}`);
        return { path, bytes: readFileSync(absolutePath) };
      });
    }
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

function readFilesManifest(path) {
  if (!existsSync(path)) throw new Error(`Files manifest not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const files = Array.isArray(parsed) ? parsed : parsed?.files;
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || file === "")) {
    throw new Error(`Files manifest ${path} must be a JSON array or an object with a string files array`);
  }
  return [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort().map((file) => {
    if (isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`Files manifest ${path} contains unsafe path: ${file}`);
    }
    return file;
  });
}

function walkTree(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };
  visit(root);
  return files;
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
