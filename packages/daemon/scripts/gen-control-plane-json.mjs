#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const EDGE_NAMES = ["canonical", "plugin", "spec"];
const CATEGORIES = new Set(["core", "pm", "pods", "process", null]);
const REQUIRED_MEMBERSHIP_CATEGORIES = [
  "clean",
  "ship_after_fix",
  "ship_misses_add",
  "sanitize_borderlines_ship",
];
const REQUIRED_DENYLIST_ARRAYS = [
  "path_prefixes",
  "seat_and_rig_patterns",
  "host_patterns",
  "charged_terms",
  "frontmatter_drop_keys",
  "internal_path_globs",
  "allowed_context_substrings",
];

export async function generateControlPlaneJson({
  repoRoot,
  membershipPath,
  denylistPath,
  layoutPath,
  outputDir,
}) {
  const membership = readYaml(membershipPath);
  const denylist = readYaml(denylistPath);
  const layoutConfig = readYaml(layoutPath);

  validateMembership(membership, membershipPath);
  validateDenylist(denylist, denylistPath);
  const layout = await extractSkillEdgeLayout({
    repoRoot,
    sourcePath: layoutPath,
    config: layoutConfig,
  });
  const digests = buildEdgeDigests({ repoRoot, layout });

  mkdirSync(outputDir, { recursive: true });
  writeJson(join(outputDir, "product-public-skills.generated.json"), membership);
  writeJson(join(outputDir, "internal-tokens.generated.json"), denylist);
  writeJson(join(outputDir, "skill-edge-layout.generated.json"), layout);
  writeJson(join(outputDir, "skill-edge-digests.generated.json"), digests);
}

export async function extractSkillEdgeLayout({
  repoRoot,
  config,
  sourcePath = "skill-edge-layout.yaml",
}) {
  validateLayout(config, sourcePath);
  const skills = new Map();

  for (const [edge, edgeConfig] of Object.entries(config.edges).sort()) {
    const edgeRoot = join(repoRoot, edgeConfig.path);
    for (const skillFile of walkFiles(edgeRoot).filter((path) =>
      path.endsWith("SKILL.md"),
    )) {
      const rel = relative(edgeRoot, skillFile).replaceAll("\\", "/");
      const parts = rel.split("/");
      const skill =
        edgeConfig.layout === "flat" ? parts[0] : parts.at(-2);
      const category =
        edgeConfig.layout === "flat" ? null : parts.length >= 3 ? parts[0] : null;
      const current = skills.get(skill) ?? { edges: [], category };
      if (
        category !== null &&
        current.category !== null &&
        current.category !== category
      ) {
        throw new Error(
          `${sourcePath}: ${skill} has conflicting categories ${current.category} and ${category}`,
        );
      }
      current.category ??= category;
      current.edges.push(edge);
      skills.set(skill, current);
    }
  }

  for (const [skill, override] of Object.entries(
    config.forward_overrides ?? {},
  ).sort()) {
    validateOverride(skill, override, config.edges, sourcePath);
    if (override.edges.length === 0) {
      skills.delete(skill);
      continue;
    }
    const edges = new Set(override.edges);
    if (edges.has("spec")) {
      for (const [edge, edgeConfig] of Object.entries(config.edges)) {
        if (edgeConfig.layout === "mirror-of-spec") edges.add(edge);
      }
    }
    skills.set(skill, {
      edges: [...edges].sort(),
      category: override.category ?? null,
    });
  }

  return {
    version: config.version,
    owner: config.owner,
    edges: sortObject(config.edges),
    skills: Object.fromEntries(
      [...skills.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([skill, entry]) => [
          skill,
          {
            edges: [...new Set(entry.edges)].sort(),
            category: entry.category ?? null,
          },
        ]),
    ),
  };
}

// Exported for the disk-truth digest regen (scripts/regen-edge-digests.mjs): digests derive purely
// from the on-disk edge files + the (already-correct) in-repo layout — no founder authority YAMLs. This
// refreshes file-integrity hashes to match folded reality WITHOUT re-deriving membership/denylist/layout
// (those stay founder-gated). It hashes PRESENT files only; a layout-demanded file missing from disk is
// never given a digest here, so the staleness check stays loud about it (layout=authority, disk=reality).
export function buildEdgeDigests({ repoRoot, layout }) {
  return {
    version: 1,
    edges: Object.fromEntries(
      Object.entries(layout.edges)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([edge, config]) => {
          const root = join(repoRoot, config.path);
          return [
            edge,
            Object.fromEntries(
              walkFiles(root).map((path) => [
                relative(root, path).replaceAll("\\", "/"),
                sha256(readFileSync(path)),
              ]),
            ),
          ];
        }),
    ),
  };
}

function validateMembership(value, sourcePath) {
  if (!isObject(value?.product_public)) {
    invalid(sourcePath, "product_public must be an object");
  }
  for (const category of REQUIRED_MEMBERSHIP_CATEGORIES) {
    if (!isStringArray(value.product_public[category])) {
      invalid(sourcePath, `product_public.${category} must be an array`);
    }
  }
  if (!isStringArray(value.vendored_ship_with_provenance)) {
    invalid(sourcePath, "vendored_ship_with_provenance must be an array");
  }
  if (!isObject(value.not_public)) {
    invalid(sourcePath, "not_public must be an object");
  }
  for (const [category, skills] of Object.entries(value.not_public)) {
    if (!isStringArray(skills)) {
      invalid(sourcePath, `not_public.${category} must be an array`);
    }
  }
  if (!isStringArray(value.pending_author_public)) {
    invalid(sourcePath, "pending_author_public must be an array");
  }
}

function validateDenylist(value, sourcePath) {
  if (!isObject(value)) invalid(sourcePath, "denylist must be an object");
  for (const field of REQUIRED_DENYLIST_ARRAYS) {
    if (Object.hasOwn(value, field) && !isStringArray(value[field])) {
      invalid(sourcePath, `${field} must be an array`);
    }
  }
  for (const field of REQUIRED_DENYLIST_ARRAYS) {
    if (!isStringArray(value[field])) {
      invalid(sourcePath, `${field} must be an array`);
    }
  }
  if (
    !isObject(value.section_fence) ||
    typeof value.section_fence.begin !== "string" ||
    typeof value.section_fence.end !== "string"
  ) {
    invalid(sourcePath, "section_fence.begin and section_fence.end are required");
  }
}

function validateLayout(value, sourcePath) {
  if (!isObject(value?.edges)) invalid(sourcePath, "edges must be an object");
  const edgeNames = Object.keys(value.edges).sort();
  if (
    edgeNames.length !== EDGE_NAMES.length ||
    edgeNames.some((edge, index) => edge !== EDGE_NAMES[index])
  ) {
    invalid(sourcePath, "edges must contain exactly canonical, plugin, and spec");
  }
  for (const edge of EDGE_NAMES) {
    const config = value.edges[edge];
    if (
      !isObject(config) ||
      typeof config.path !== "string" ||
      !["categorized", "mirror-of-spec", "flat"].includes(config.layout)
    ) {
      invalid(sourcePath, `${edge} edge path/layout is invalid`);
    }
  }
  if (value.extract_from_committed_trees !== true) {
    invalid(sourcePath, "extract_from_committed_trees must be true");
  }
  if (!isObject(value.forward_overrides)) {
    invalid(sourcePath, "forward_overrides must be an object");
  }
  for (const [skill, override] of Object.entries(value.forward_overrides)) {
    validateOverride(skill, override, value.edges, sourcePath);
  }
}

function validateOverride(skill, override, edges, sourcePath) {
  if (
    !isObject(override) ||
    !isStringArray(override.edges) ||
    override.edges.some(
      (edge) =>
        !Object.hasOwn(edges, edge) || !["plugin", "spec"].includes(edge),
    )
  ) {
    invalid(sourcePath, `${skill} edges are invalid`);
  }
  if (!CATEGORIES.has(override.category ?? null)) {
    invalid(sourcePath, `${skill} category is invalid`);
  }
}

function readYaml(path) {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(root) {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) {
    throw new Error(`${root}: symlink entries are not allowed`);
  }
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) {
    throw new Error(`${root}: unsupported filesystem entry`);
  }
  return readdirSync(root)
    .sort()
    .flatMap((entry) => walkFiles(join(root, entry)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalid(path, reason) {
  throw new Error(`${path}: ${reason}`);
}

function cliOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    values[key.slice(2)] = resolve(value);
  }
  const required = ["repo-root", "membership", "denylist", "layout", "output"];
  for (const key of required) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  return {
    repoRoot: values["repo-root"],
    membershipPath: values.membership,
    denylistPath: values.denylist,
    layoutPath: values.layout,
    outputDir: values.output,
  };
}

const scriptPath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1]) === scriptPath) {
  try {
    await generateControlPlaneJson(cliOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
