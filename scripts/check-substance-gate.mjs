#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildInternalLeakMessage,
  scanInternalLeaks,
} from "./internal-leak-scanner.mjs";

const FIX = "Genericize the content, cite its public home, or re-home it to the internal pack root.";
const REFUSAL_VERDICTS = new Set(["instance-fact", "internal-path", "position-knowledge", "lore-class"]);
const RULE_FIELDS = [
  "path_prefixes",
  "seat_and_rig_patterns",
  "host_patterns",
  "charged_terms",
  "internal_path_globs",
  "allowed_context_substrings",
];

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const rules = readJson(options.rules, "rules");
  const review = readJson(options.review, "review");
  assertCleanCut(options.repo, options.cutSha);

  const artifactFiles = derivePackageArtifacts(options.packageRoot);
  const treeClasses = partitionPackageArtifacts(artifactFiles);
  const surfaceRoots = readSurfaceRoots(options.surfaceManifest);
  const surfaces = enumerateSurfaces(options.packageRoot, surfaceRoots, artifactFiles, rules);
  refuseStructuralFindings(surfaces);

  const derivedRules = selectDerivedRules(rules);
  const blockingScans = {
    content: runArtifactScan(options, "content", treeClasses.content, rules),
    derived: runArtifactScan(options, "derived", treeClasses.derived, derivedRules),
  };
  const scannedFiles = [
    ...blockingScans.content.scannedFiles,
    ...blockingScans.derived.scannedFiles,
  ].sort();
  const scannedSet = new Set(scannedFiles);
  const artifactSet = new Set(artifactFiles);
  const missingFromScan = artifactFiles.filter((path) => !scannedSet.has(path));
  const extraInScan = scannedFiles.filter((path) => !artifactSet.has(path));
  if (missingFromScan.length > 0) {
    throw new Error([
      "substance gate artifact coverage failed: scanned set is not a superset of the npm artifact set",
      ...missingFromScan.map((path) => `  missing: ${path}`),
    ].join("\n"));
  }

  const reviewed = bindReview(surfaces, review);
  assertCleanCut(options.repo, options.cutSha);
  const receipt = {
    gate: "substance gate",
    judge: options.judge,
    cutSha: options.cutSha,
    createdAt: new Date().toISOString(),
    surfaceRoots,
    surfaceCount: reviewed.length,
    treeClassPartition: {
      contentPathCount: treeClasses.content.length,
      derivedPathCount: treeClasses.derived.length,
    },
    activeRulesByClass: {
      content: countActiveRules(rules),
      derived: countActiveRules(derivedRules),
    },
    blockingScans: {
      content: summarizeBlockingScan(blockingScans.content),
      derived: summarizeBlockingScan(blockingScans.derived),
    },
    fullScan: {
      status: "pass",
      mode: "full",
      artifactFileCount: artifactFiles.length,
      scannedFileCount: scannedFiles.length,
      missingFromScan,
      extraInScan,
      artifactFiles,
      scannedFiles,
    },
    surfaces: reviewed,
  };
  mkdirSync(dirname(options.receipt), { recursive: true });
  writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
}

function assertCleanCut(repo, cutSha) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (head !== cutSha) {
    throw new Error(`cut sha mismatch: --cut-sha ${cutSha} but ${repo} is at ${head}`);
  }
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  if (dirty !== "") {
    throw new Error(`release cut is dirty; receipt cannot bind worktree bytes to ${cutSha}:\n${dirty}`);
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    values[key.slice(2)] = value;
  }
  for (const required of ["review", "receipt", "judge", "cut-sha"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  const repo = resolve(values.repo ?? ".");
  const packageRoot = resolve(values["package-root"] ?? join(repo, "packages/cli"));
  if (packageRoot !== repo && !packageRoot.startsWith(`${repo}/`)) {
    throw new Error(`package root must be inside the cut repository: ${packageRoot}`);
  }
  return {
    repo,
    packageRoot,
    rules: resolve(values.rules ?? join(repo, "scripts/internal-tokens.generated.json")),
    review: resolve(values.review),
    receipt: resolve(values.receipt),
    surfaceManifest: resolve(values["surface-manifest"] ?? join(packageRoot, "daemon/substance-surfaces.json")),
    judge: values.judge,
    cutSha: values["cut-sha"],
  };
}

function derivePackageArtifacts(packageRoot) {
  if (!existsSync(packageRoot)) throw new Error(`package root not found: ${packageRoot}`);
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    throw new Error(`npm artifact enumeration failed:\n${packed.stderr || packed.stdout || `exit ${packed.status}`}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error(`npm artifact enumeration did not return JSON: ${error.message}`);
  }
  const rawFiles = parsed?.[0]?.files;
  if (!Array.isArray(rawFiles)) throw new Error("npm artifact enumeration returned no files array");
  const files = rawFiles.map((entry) => entry?.path).filter((path) => typeof path === "string");
  if (files.length !== rawFiles.length || files.length === 0) {
    throw new Error("npm artifact enumeration contains an empty or invalid file path");
  }
  return [...new Set(files.map(normalizeSafeRelativePath))].sort();
}

function partitionPackageArtifacts(artifactFiles) {
  const derived = [];
  const content = [];
  for (const path of artifactFiles) {
    const target = path.startsWith("dist/")
      || path.includes("/dist/")
      || path.startsWith("node_modules/")
      ? derived
      : content;
    target.push(path);
  }
  return { content, derived };
}

function selectDerivedRules(rules) {
  return {
    path_prefixes: (rules.path_prefixes ?? []).filter((entry) =>
      entry.startsWith("/") || entry.startsWith("~")),
    seat_and_rig_patterns: [],
    host_patterns: [...(rules.host_patterns ?? [])],
    charged_terms: [],
    internal_path_globs: [...(rules.internal_path_globs ?? [])],
    allowed_context_substrings: [...(rules.allowed_context_substrings ?? [])],
  };
}

function countActiveRules(rules) {
  return Object.fromEntries(
    RULE_FIELDS.flatMap((field) => {
      const count = Array.isArray(rules[field]) ? rules[field].length : 0;
      return count === 0 ? [] : [[field, count]];
    }),
  );
}

function readSurfaceRoots(path) {
  const manifest = readJson(path, "surface manifest");
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.roots) || manifest.roots.length === 0) {
    throw new Error("surface manifest must have schemaVersion 1 and a nonempty roots array");
  }
  return [...new Set(manifest.roots.map(normalizeSafeRelativePath))].sort();
}

function enumerateSurfaces(packageRoot, roots, artifactFiles, rules) {
  const surfacePaths = artifactFiles.filter((path) =>
    roots.some((root) => path === root || path.startsWith(`${root}/`)),
  );
  for (const root of roots) {
    if (!surfacePaths.some((path) => path === root || path.startsWith(`${root}/`))) {
      throw new Error(`surface root is absent from npm artifact enumeration: ${root}`);
    }
  }
  return surfacePaths.map((path) => {
    const bytes = readFileSync(resolve(packageRoot, path));
    return {
      path,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      candidates: collectCandidates(bytes.toString("utf8")),
      structuralFindings: [
        ...scanInternalLeaks({ path, bytes, rules }).map((finding) => ({
          class: classifyLeak(finding.token, finding.kind, rules),
          line: finding.line,
          value: finding.token,
        })),
        ...(declaresLoreTaxonomy(path, bytes.toString("utf8"))
          ? [{ class: "lore-class", line: 1, value: "taxonomy: lore" }]
          : []),
      ],
    };
  });
}

function runArtifactScan(options, treeClass, artifactFiles, rules) {
  const findings = [];
  const scannedFiles = [];
  for (const path of artifactFiles) {
    const normalized = normalizeSafeRelativePath(path);
    findings.push(...scanInternalLeaks({
      path: normalized,
      bytes: readFileSync(resolve(options.packageRoot, normalized)),
      rules,
    }));
    scannedFiles.push(normalized);
  }
  if (findings.length > 0) {
    throw new Error(`substance gate ${treeClass} scan failed:\n${buildInternalLeakMessage(findings)}`);
  }
  return {
    status: "pass",
    artifactFileCount: artifactFiles.length,
    scannedFileCount: scannedFiles.length,
    findingCount: 0,
    scannedFiles,
  };
}

function summarizeBlockingScan(scan) {
  return {
    status: scan.status,
    artifactFileCount: scan.artifactFileCount,
    scannedFileCount: scan.scannedFileCount,
    findingCount: scan.findingCount,
  };
}

function normalizeSafeRelativePath(path) {
  const normalized = String(path).replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`unsafe artifact path: ${path}`);
  }
  return normalized;
}

function refuseStructuralFindings(surfaces) {
  const findings = surfaces.flatMap((surface) =>
    surface.structuralFindings.map((finding) => ({ path: surface.path, ...finding })),
  );
  if (findings.length === 0) return;
  throw new Error([
    "Substance gate refused public content:",
    ...findings.map((finding) =>
      `  classifier verdict ${finding.class}: ${finding.path}: line ${finding.line}: ${finding.value}`),
    `Fix: ${FIX}`,
  ].join("\n"));
}

function bindReview(surfaces, review) {
  if (!review || !Array.isArray(review.surfaces)) {
    throw new Error("review must contain a surfaces array of per-file judgments");
  }
  const byPath = new Map();
  for (const entry of review.surfaces) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      throw new Error("each review surface needs a path");
    }
    if (byPath.has(entry.path)) throw new Error(`duplicate review judgment for ${entry.path}`);
    byPath.set(entry.path, entry);
  }

  const errors = [];
  const result = [];
  for (const surface of surfaces) {
    const judgment = byPath.get(surface.path);
    if (!judgment) {
      errors.push(`${surface.path}: missing human judgment (unreviewed)`);
      continue;
    }
    byPath.delete(surface.path);
    if (judgment.sha256 !== surface.sha256) {
      errors.push(`${surface.path}: review hash ${judgment.sha256 ?? "<missing>"} does not match ${surface.sha256}`);
    }
    if (typeof judgment.reason !== "string" || judgment.reason.trim() === "") {
      errors.push(`${surface.path}: judgment reason is required`);
    }
    if (judgment.verdict !== "ship") {
      if (REFUSAL_VERDICTS.has(judgment.verdict)) {
        errors.push(
          `${surface.path}: classifier verdict ${judgment.verdict}: ${judgment.reason || "no reason supplied"}. Fix: ${FIX}`,
        );
      } else {
        errors.push(
          `${surface.path}: unknown classifier verdict ${JSON.stringify(judgment.verdict)}; expected ship or one of ${[...REFUSAL_VERDICTS].join(", ")}`,
        );
      }
      continue;
    }
    const dispositions = Array.isArray(judgment.candidateDispositions)
      ? judgment.candidateDispositions
      : [];
    const dispositionMap = new Map(dispositions.map((entry) => [candidateKey(entry), entry]));
    for (const candidate of surface.candidates) {
      const disposition = dispositionMap.get(candidateKey(candidate));
      if (!disposition || typeof disposition.disposition !== "string" || disposition.disposition.trim() === "") {
        errors.push(`${surface.path}: undispositioned ${candidate.kind} candidate line ${candidate.line}: ${candidate.value}`);
      } else {
        dispositionMap.delete(candidateKey(candidate));
      }
    }
    for (const stale of dispositionMap.values()) {
      errors.push(`${surface.path}: stale candidate disposition ${candidateKey(stale)}`);
    }
    result.push({
      path: surface.path,
      sha256: surface.sha256,
      verdict: judgment.verdict,
      reason: judgment.reason,
      candidates: surface.candidates.map((candidate) => ({
        ...candidate,
        disposition: dispositions.find((entry) => candidateKey(entry) === candidateKey(candidate))?.disposition,
      })),
    });
  }
  for (const stalePath of byPath.keys()) errors.push(`${stalePath}: review names no current shippable surface`);
  if (errors.length > 0) throw new Error(["Substance gate review is incomplete:", ...errors.map((error) => `  ${error}`)].join("\n"));
  return result;
}

function collectCandidates(text) {
  const patterns = [
    ["absolute-path", /(?:~\/|\/(?:Users|home|var|tmp|etc)\/)[^\s"'`]+/g],
    ["port", /(?:\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0))?:\d{2,5}\b/g],
    ["count", /\b\d[\d,]*\s+(?:files?|seats?|rigs?|pods?|agents?|directories|tests?|lines?|tokens?|bytes?)\b/gi],
    ["date", /\b20\d{2}-\d{2}-\d{2}\b/g],
    ["provenance-marker", /\b(?:may not hold|measured|TELLS-[A-Za-z0-9_-]+|debt\.md|this instance|one instance)\b/gi],
    ["internal-name", /\brigx\b/gi],
  ];
  const candidates = [];
  for (const [lineIndex, line] of text.split("\n").entries()) {
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        candidates.push({ kind, line: lineIndex + 1, value: match[0] });
      }
    }
  }
  return candidates;
}

function classifyLeak(token, kind, rules) {
  if (kind === "path" || rules.path_prefixes?.includes(token) || rules.internal_path_globs?.includes(token)) return "internal-path";
  if (rules.seat_and_rig_patterns?.includes(token) || rules.charged_terms?.includes(token)) return "position-knowledge";
  return "instance-fact";
}

function declaresLoreTaxonomy(path, text) {
  let yaml;
  if (/\.ya?ml$/i.test(path)) yaml = text;
  else if (/\.(?:md|markdown)$/i.test(path)) yaml = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (yaml === undefined) return false;
  try {
    const parsed = parseYaml(yaml);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.taxonomy === "lore";
  } catch {
    return false;
  }
}

function candidateKey(candidate) {
  return `${candidate?.kind ?? ""}\u0000${candidate?.line ?? ""}\u0000${candidate?.value ?? ""}`;
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} file is not valid JSON: ${(error).message}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
