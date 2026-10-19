import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  buildInternalLeakMessage,
  scanInternalLeaks,
} from "./internal-leak-scanner.mjs";

// Each shipped skill has one editable home in this repo: its copy under
// packages/daemon/specs/agents/shared/skills/ when it has a spec edge, otherwise its copy under
// packages/daemon/assets/plugins/openrig-core/skills/. `npm run mirror-skills` regenerates every
// other declared copy (skills/_canonical/ and the plugin copies of spec skills) from that home, and
// `--check` fails when a copy differs from it. Hand-authored files at <repo-root>/skills/
// (README, CHANGELOG, LICENSE, plugin manifests) live alongside _canonical/
// and are NEVER touched by the mirror — strict-ownership lets us add new
// top-level files without coupling the script to the destination shape.

export const SOURCE_DIR = "packages/daemon/specs/agents/shared/skills/";
export const TARGET_DIR = "skills/_canonical/";

export const EXCLUDES = [
  "feedback.md",
  "evals/",
  ".DS_Store",
  "*.local.md",
];

function rsyncArgs({ dryRun }) {
  // --checksum compares file contents via hash instead of mtime+size.
  // Used in --check (dry-run) mode so the drift-detect is content-stable
  // — a `git checkout` or `cp` updating mtimes does NOT register as drift
  // when the bytes match. In apply mode we keep the default (mtime+size)
  // for speed; rsync's archive flag preserves mtime so subsequent checks
  // stay clean.
  return [
    "-a",
    "--delete",
    "--delete-excluded",
    "--itemize-changes",
    ...(dryRun ? ["-n", "--checksum"] : []),
    ...EXCLUDES.map((p) => `--exclude=${p}`),
    SOURCE_DIR,
    TARGET_DIR,
  ];
}

// Parse rsync --itemize-changes output for content or regular-file mode changes.
// First-column codes per rsync(1):
//   `<` / `>` — file transferred (content change)
//   `c`        — created entry (file/dir/symlink/device)
//   `h`        — hardlink redirected
//   `.`        — item exists with NO update OR metadata-only update; retain
//                only `.f...p.....` permission changes
//   `*`        — message line; we only care about `*deleting `
// In --check mode the script invokes rsync with `--checksum`, so a `.`
// leading line means the bytes match even if mtime drifts (e.g., after
// `git checkout` or `cp`); permission is the one metadata field the public
// mirror must preserve, while mtime-only drift stays ignored.
export function parseChanges(output) {
  const lines = output.split("\n").filter(Boolean);
  return [
    ...new Set(
      lines.filter(
        (line) =>
          /^[<>ch][fdLDS]/.test(line.slice(0, 2)) ||
          (line.startsWith(".f") && line[5] === "p") ||
          line.startsWith("*deleting "),
      ),
    ),
  ];
}

export function buildStaleMessage(changes) {
  return [
    "Skills mirror is stale at skills/_canonical/. Run: npm run mirror-skills",
    "Changes that would land:",
    ...changes.map((c) => `  ${c}`),
  ].join("\n");
}

function runRsync({ dryRun }, exec = execFileSync) {
  return exec("rsync", rsyncArgs({ dryRun }), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function ensureTargetExists() {
  if (!existsSync(TARGET_DIR)) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }
}

export function checkMode(exec = execFileSync) {
  ensureTargetExists();
  const output = runRsync({ dryRun: true }, exec);
  const changes = parseChanges(output);
  return { stale: changes.length > 0, changes, output };
}

export function checkModeAbsolute(sourceDir, targetDir, exec = execFileSync) {
  const output = exec(
    "rsync",
    rsyncAbsoluteArgs({ sourceDir, targetDir, dryRun: true }),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const changes = parseChanges(output);
  return { stale: changes.length > 0, changes, output };
}

// The product_public categories the mirror's ship set CONSUMES. Exported so the refs→membership
// chain gate (leg 2) can prove every oracle category is consumed — a category present in the oracle
// but absent here is silently accepted-and-dropped (the 0.4.8/864cea6b stranding: the PM's
// `restored_role_pm_selected` re-add landed in the oracle but this list never read it, so the 10
// pod/pm skills were never re-shipped despite being membership-selected).
export const SHIP_CATEGORIES = [
  "clean",
  "ship_after_fix",
  "ship_misses_add",
  "sanitize_borderlines_ship",
  "restored_role_pm_selected",
];

export function shipSetFromMembership(membership) {
  const productPublic = membership?.product_public ?? {};
  const excluded = new Set([
    ...Object.values(membership?.not_public ?? {}).flat(),
    ...(membership?.pending_author_public ?? []),
  ]);
  return [
    ...SHIP_CATEGORIES.flatMap((category) => productPublic[category] ?? []),
    ...(membership?.vendored_ship_with_provenance ?? []),
  ]
    .filter((skill) => !excluded.has(skill))
    .filter((skill, index, all) => all.indexOf(skill) === index)
    .sort();
}

// One editable home per shipped skill: its spec copy when the skill has a spec edge, otherwise its
// plugin copy. Every other declared edge is generated from that home.
export function authoringEdge(skillLayout) {
  if (skillLayout?.edges?.includes("spec")) return "spec";
  if (skillLayout?.edges?.includes("plugin")) return "plugin";
  return null;
}

// Plans every read and write before anything is staged or replaced. An edge that holds no home is
// replaced whole. On an edge that holds homes, only the generated skill folders are replaced, so
// authored skills and anything undeclared beside them stay where they are.
export function planSkillSources({ repoRoot, layout, shipping }) {
  const problems = [];
  const problem = (edge, path, reason, message) =>
    problems.push({ edge, path, reason, message });
  const skills = [];
  for (const skill of shipping) {
    const skillLayout = layout.skills[skill];
    if (!skillLayout?.edges?.length) {
      problem("-", skill, "layout-missing", `Missing shipping skill in edge layout: ${skill}`);
      continue;
    }
    const home = authoringEdge(skillLayout);
    if (!home) {
      problem("-", skill, "no-home", `Shipping skill ${skill} has no spec or plugin edge to author it in`);
      continue;
    }
    const paths = {};
    for (const edge of skillLayout.edges) {
      const path = skillPathOnEdge(layout, edge, skill);
      if (path) paths[edge] = path;
      else problem(edge, skill, "category-missing", `Missing category for shipping skill ${skill} on ${edge}`);
    }
    if (paths[home]) skills.push({ skill, home, paths });
  }

  const edgeRoot = (edge, path = "") => resolve(repoRoot, layout.edges[edge].path, path);
  const homeEdges = new Set(skills.map(({ home }) => home));
  const wholeEdges = Object.keys(layout.edges).sort().filter((edge) => !homeEdges.has(edge));
  const homes = skills.map(({ skill, home, paths }) => ({
    skill,
    edge: home,
    path: paths[home],
    root: edgeRoot(home, paths[home]),
  }));
  for (const home of homes) {
    if (!existsSync(home.root)) {
      problem(home.edge, home.path, "source-missing", `Missing shipping skill source: ${layout.edges[home.edge].path}/${home.path}`);
    }
  }
  const outputs = [
    ...wholeEdges.map((edge) => ({ edge, path: ".", root: edgeRoot(edge) })),
    ...skills.flatMap(({ home, paths }) =>
      Object.entries(paths)
        .filter(([edge]) => edge !== home && !wholeEdges.includes(edge))
        .map(([edge, path]) => ({ edge, path, root: edgeRoot(edge, path) })),
    ),
  ];
  for (const output of outputs) {
    for (const home of homes.filter(({ root }) => overlaps(output.root, root))) {
      problem(
        output.edge,
        output.path,
        "overlap",
        `Refusing to regenerate: the ${output.edge} output ${output.root} overlaps the source of ${home.skill} at ${home.root}`,
      );
    }
  }
  return { skills, wholeEdges, problems };
}

export async function stagePublicSkills({
  sourceFor,
  stagingRoot,
  membership,
  rules,
  scan = scanInternalLeaks,
}) {
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  for (const skill of shipSetFromMembership(membership)) {
    const sourceRoot = sourceFor(skill);
    if (!sourceRoot || !existsSync(sourceRoot) || isInternalPath(skill, rules)) continue;

    for (const sourcePath of walkFiles(sourceRoot)) {
      const skillRelative = relative(sourceRoot, sourcePath).replaceAll("\\", "/");
      const publicPath = `${skill}/${skillRelative}`;
      if (isExcludedPath(skillRelative)) continue;
      if (isInternalPath(publicPath, rules)) continue;

      let bytes = readFileSync(sourcePath);
      if (basename(sourcePath) === "SKILL.md") {
        const transformed = stripPublicSkill(
          bytes.toString("utf8"),
          publicPath,
          rules,
        );
        bytes = Buffer.from(transformed);
      } else if (/\.mdx?$/i.test(sourcePath)) {
        bytes = Buffer.from(
          stripInternalFences(
            bytes.toString("utf8"),
            publicPath,
            rules.section_fence,
          ),
        );
      }

      const findings = scan ? scan({ path: publicPath, bytes, rules }) : [];
      if (findings.length > 0) {
        throw new Error(buildInternalLeakMessage(findings));
      }

      const targetPath = join(stagingRoot, skillRelative === "." ? skill : publicPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes);
      // A create mode is masked by the umask; set the source's mode exactly.
      chmodSync(targetPath, lstatSync(sourcePath).mode & 0o777);
    }
  }
}

// External-canon-pending skills: listed in the layout ship set but not yet in THIS repo (a pending
// skill now lands as a reviewed PR that adds its source). Their layout-missing is
// tolerated here — but ONLY these named few,
// and ONLY while genuinely absent from disk. Any OTHER layout-demanded file missing from disk stays
// LOUD (a future accidental deletion is never silently blessed), and a name that reappears on disk is
// flagged `external-canon-allowlist-stale` so this list self-destructs. Same self-policing shape as the
// P6(A) chain gate. Layout = authority, disk = reality; the digest regen touches only reality.
// (Currently empty: oversight-team and retiring-and-inheriting-a-seat landed via the 2026-08-24
// mirror-apply, so their exemptions self-destructed.)
const EXTERNAL_CANON_PENDING = new Set([]);

export async function checkGeneratedEdges({
  repoRoot = process.cwd(),
  layout,
  digests,
  membership,
  rules,
  externalCanonPending = EXTERNAL_CANON_PENDING,
}) {
  validateGeneratedControls(layout, digests);
  if (!membership || !rules) {
    throw new Error("The check needs the membership and token rules to compare generated copies with their sources");
  }
  const changes = [];
  const onDiskSkills = new Set();

  for (const [edge, edgeConfig] of Object.entries(layout.edges).sort()) {
    const edgeRoot = join(repoRoot, edgeConfig.path);
    const expected = digests?.edges?.[edge] ?? {};
    const edgeFiles = walkFiles(edgeRoot);
    const actual = Object.fromEntries(
      edgeFiles.map((path) => [
        relative(edgeRoot, path).replaceAll("\\", "/"),
        sha256(readFileSync(path)),
      ]),
    );

    for (const path of Object.keys(expected).sort()) {
      if (!(path in actual)) {
        changes.push({ edge, path, reason: "missing" });
      } else if (actual[path] !== expected[path]) {
        changes.push({ edge, path, reason: "digest" });
      }
    }
    for (const path of Object.keys(actual).sort()) {
      if (!(path in expected)) {
        changes.push({ edge, path, reason: "unexpected" });
      }
    }

    const actualSkills = new Map(
      edgeFiles
        .filter((path) => basename(path) === "SKILL.md")
        .map((path) => {
          const rel = relative(edgeRoot, path).replaceAll("\\", "/");
          const parts = rel.split("/");
          const flat = edgeConfig.layout === "flat";
          return [
            flat ? parts[0] : parts.at(-2),
            { path: rel, category: flat ? null : parts[0] },
          ];
        }),
    );
    for (const [skill, actualEntry] of actualSkills) {
      const expectedEntry = layout.skills?.[skill];
      if (!expectedEntry?.edges?.includes(edge)) {
        changes.push({
          edge,
          path: actualEntry.path,
          reason: "layout-unexpected",
        });
      } else if (
        actualEntry.category !== null &&
        expectedEntry.category !== actualEntry.category
      ) {
        changes.push({
          edge,
          path: actualEntry.path,
          reason: "layout-category",
        });
      }
    }
    for (const skill of actualSkills.keys()) onDiskSkills.add(skill);
    for (const [skill, expectedEntry] of Object.entries(
      layout.skills ?? {},
    ).sort()) {
      if (expectedEntry.edges.includes(edge) && !actualSkills.has(skill)) {
        // Tolerate ONLY the named external-canon-pending skills; every other layout-demanded file
        // missing from disk stays loud.
        if (externalCanonPending.has(skill)) continue;
        changes.push({
          edge,
          path: skill,
          reason: "layout-missing",
        });
      }
    }
  }

  // Self-destruct guard: a name reappearing on disk must leave the allowlist. If an external-canon-pending
  // skill is now present, its exemption is stale — flag it LOUD so the list can never silently outlive
  // the gap it covered.
  for (const skill of externalCanonPending) {
    if (onDiskSkills.has(skill)) {
      changes.push({ edge: "-", path: skill, reason: "external-canon-allowlist-stale" });
    }
  }

  // Recorded digests can be re-pinned to anything on disk; this compares each copy with its source.
  changes.push(
    ...(await checkAuthoredSources({ repoRoot, layout, membership, rules, externalCanonPending })),
  );

  return { stale: changes.length > 0, changes };
}

// Compares each shipped skill's home with what its public copies must hold: the home must already be
// publishable (sanitizing it changes nothing), and every generated copy must equal the staged home.
// Membership, layout and the token rules come from the product JSON; nothing outside the repo is read.
export async function checkAuthoredSources({
  repoRoot,
  layout,
  membership,
  rules,
  externalCanonPending = EXTERNAL_CANON_PENDING,
}) {
  const shipping = shipSetFromMembership(membership).filter(
    (skill) => !externalCanonPending.has(skill),
  );
  const { skills, problems } = planSkillSources({ repoRoot, layout, shipping });
  const changes = problems.map(({ edge, path, reason }) => ({ edge, path, reason }));
  const temporaryRoot = mkdtempSync(join(tmpdir(), "openrig-skill-sources-"));
  try {
    const stagingRoot = join(temporaryRoot, "staging");
    await stageHomes({ repoRoot, layout, skills, stagingRoot, membership, rules, scan: null });
    for (const { skill, home, paths } of skills) {
      const sourceRoot = join(repoRoot, layout.edges[home].path, paths[home]);
      if (!existsSync(sourceRoot)) continue;
      const staged = join(stagingRoot, skill);
      for (const { path } of treeDifferences(staged, sourceRoot)) {
        changes.push({ edge: home, path: `${paths[home]}/${path}`, reason: "source-not-public" });
      }
      for (const [edge, path] of Object.entries(paths)) {
        if (edge === home) continue;
        for (const difference of treeDifferences(staged, join(repoRoot, layout.edges[edge].path, path))) {
          changes.push({ edge, path: `${path}/${difference.path}`, reason: `copy-${difference.kind}` });
        }
      }
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return changes;
}

export async function regeneratePublicSkills({
  repoRoot,
  membership,
  rules,
  layout,
  exec = execFileSync,
}) {
  validateAuthoringLayout(layout);
  const shipping = shipSetFromMembership(membership);
  const { skills, wholeEdges, problems } = planSkillSources({ repoRoot, layout, shipping });
  if (problems.length > 0) {
    throw new Error(problems.map(({ message }) => message).join("\n"));
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "openrig-public-skills-"));
  try {
    // Every home is read and staged before any output is replaced.
    const stagingRoot = join(temporaryRoot, "staging");
    await stageHomes({ repoRoot, layout, skills, stagingRoot, membership, rules });
    const notPublic = skills.flatMap(({ skill, home, paths }) =>
      treeDifferences(
        join(stagingRoot, skill),
        join(repoRoot, layout.edges[home].path, paths[home]),
      ).map(({ path }) => `${layout.edges[home].path}/${paths[home]}/${path}`),
    );
    if (notPublic.length > 0) {
      throw new Error(
        [
          "Skill sources hold text or files that their public copies would drop. Remove it from the source:",
          ...notPublic.map((path) => `  ${path}`),
        ].join("\n"),
      );
    }

    const changes = [];
    const undeclared = [];
    for (const [edge, edgeConfig] of Object.entries(layout.edges).sort()) {
      const outputs = skills.filter(({ home, paths }) => home !== edge && paths[edge]);
      const edgeRoot = join(repoRoot, edgeConfig.path);
      if (wholeEdges.includes(edge)) {
        const projectedRoot = join(temporaryRoot, `edge-${edge}`);
        mkdirSync(projectedRoot, { recursive: true });
        for (const { skill, paths } of outputs) {
          copyTree(join(stagingRoot, skill), join(projectedRoot, paths[edge]));
        }
        mkdirSync(edgeRoot, { recursive: true });
        changes.push(...syncTree(projectedRoot, edgeRoot, edge, "", exec));
        continue;
      }
      for (const { skill, paths } of outputs) {
        const staged = join(stagingRoot, skill);
        const target = join(edgeRoot, paths[edge]);
        mkdirSync(staged, { recursive: true });
        mkdirSync(target, { recursive: true });
        changes.push(...syncTree(staged, target, edge, paths[edge], exec));
      }
      undeclared.push(...undeclaredSkills(edgeRoot, edge, layout));
    }
    return { changes, undeclared };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function authoringApplyMode({
  generateControlPlaneJson = defaultGenerateControlPlaneJson,
  readAuthoringInputs = defaultReadAuthoringInputs,
  regeneratePublicSkills: regenerate = regeneratePublicSkills,
} = {}) {
  await generateControlPlaneJson();
  const inputs = readAuthoringInputs();
  const result = await regenerate(inputs);
  if (result.changes.length > 0) {
    await generateControlPlaneJson();
  }
  return result;
}

export function applyMode(exec = execFileSync) {
  ensureTargetExists();
  return runRsync({ dryRun: false }, exec);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const isCheck = argv.includes("--check");

  if (isCheck) {
    const verify = dependencies.checkGeneratedEdges ?? checkGeneratedEdges;
    const inputs =
      dependencies.checkInputs ??
      (dependencies.checkGeneratedEdges ? {} : readGeneratedCheckInputs());
    const { stale, changes } = await verify(inputs);
    if (stale) {
      console.error(buildGeneratedStaleMessage(changes));
      process.exitCode = 1;
    }
    return;
  }

  const apply = dependencies.authoringApplyMode ?? authoringApplyMode;
  const log = dependencies.log ?? console.log;
  const { changes, undeclared = [] } = await apply();
  if (changes.length === 0) {
    log("Public skill edges already in sync; no changes.");
  } else {
    log(`Public skill edge regeneration measured ${changes.length} change(s):`);
    for (const { edge, path, reason } of changes) {
      log(`  ${edge}: ${path} (${reason})`);
    }
  }
  if (undeclared.length > 0) {
    log(`Left in place, not in the layout (${undeclared.length}); npm run mirror-skills:check fails until it is declared or removed:`);
    for (const { edge, path } of undeclared) log(`  ${edge}: ${path}`);
  }
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  await main();
}

function readGeneratedCheckInputs() {
  const repoRoot = process.cwd();
  return {
    repoRoot,
    layout: readJson(join(repoRoot, "scripts/skill-edge-layout.generated.json")),
    digests: readJson(join(repoRoot, "scripts/skill-edge-digests.generated.json")),
    membership: readJson(join(repoRoot, "scripts/product-public-skills.generated.json")),
    rules: readJson(join(repoRoot, "scripts/internal-tokens.generated.json")),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultGenerateControlPlaneJson() {
  const repoRoot = process.cwd();
  // Membership, rules and layout come from the product JSON; old YAML selectors are ignored.
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "packages/daemon/scripts/gen-control-plane-json.mjs"),
      "--repo-root",
      repoRoot,
      "--output",
      join(repoRoot, "scripts"),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}

function defaultReadAuthoringInputs() {
  const repoRoot = process.cwd();
  if (process.env.OPENRIG_SKILL_CANON_ROOT) {
    console.warn(
      "OPENRIG_SKILL_CANON_ROOT is ignored: product skills regenerate from their sources in this repository. To bring in an outside skill change, edit the skill's source and open a pull request.",
    );
  }
  return {
    repoRoot,
    membership: readJson(
      join(repoRoot, "scripts/product-public-skills.generated.json"),
    ),
    rules: readJson(join(repoRoot, "scripts/internal-tokens.generated.json")),
    layout: readJson(
      join(repoRoot, "scripts/skill-edge-layout.generated.json"),
    ),
  };
}

function buildGeneratedStaleMessage(changes) {
  return [
    "Skill edges don't match their sources, layout or recorded digests. Fix the source, then run: npm run mirror-skills",
    ...changes.map(
      ({ edge, path, reason }) => `  ${edge}: ${path} (${reason})`,
    ),
  ].join("\n");
}

function stripPublicSkill(content, path, rules) {
  const withoutFences = stripInternalFences(content, path, rules.section_fence);
  const lines = withoutFences.split("\n");
  if (lines[0] !== "---") return withoutFences;

  const end = lines.indexOf("---", 1);
  if (end === -1) return withoutFences;

  const frontmatter = lines.slice(1, end);
  const kept = sanitizeFrontmatterEntries(frontmatter, 0, rules);

  return ["---", ...kept, "---", ...lines.slice(end + 1)].join("\n");
}

function sanitizeFrontmatterEntries(lines, indent, rules) {
  const kept = [];
  for (let index = 0; index < lines.length; ) {
    const match = frontmatterEntry(lines[index]);
    if (!match || match.indent !== indent) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }

    let next = index + 1;
    while (next < lines.length) {
      const candidate = frontmatterEntry(lines[next]);
      if (candidate && candidate.indent <= indent) break;
      next += 1;
    }
    const children = lines.slice(index + 1, next);
    const configured =
      match.key === "distribution_scope" ||
      (rules.frontmatter_drop_keys ?? []).includes(match.key);
    if (configured) {
      index = next;
      continue;
    }

    const childIndent = firstEntryIndent(children);
    if (match.value === "" && childIndent !== null) {
      const sanitized = sanitizeFrontmatterEntries(children, childIndent, rules);
      if (sanitized.some((line) => line.trim() !== "")) {
        kept.push(lines[index], ...sanitized);
      }
    } else {
      const entry = [lines[index], ...children];
      if (!containsInternalValue(entry.join("\n"), rules)) kept.push(...entry);
    }
    index = next;
  }
  return kept;
}

function frontmatterEntry(line) {
  const match = /^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
  return match
    ? { indent: match[1].length, key: match[2], value: match[3] ?? "" }
    : null;
}

function firstEntryIndent(lines) {
  for (const line of lines) {
    const entry = frontmatterEntry(line);
    if (entry) return entry.indent;
  }
  return null;
}

function stripInternalFences(content, path, fence) {
  if (!fence?.begin || !fence?.end) return content;

  const lines = content.split("\n");
  const kept = [];
  let openedAt = null;
  for (const [index, line] of lines.entries()) {
    if (line.includes(fence.begin)) {
      if (openedAt !== null) {
        throw new Error(`${path}: unmatched internal fence at line ${index + 1}`);
      }
      openedAt = index + 1;
      continue;
    }
    if (line.includes(fence.end)) {
      if (openedAt === null) {
        throw new Error(`${path}: unmatched internal fence at line ${index + 1}`);
      }
      openedAt = null;
      continue;
    }
    if (openedAt === null) kept.push(line);
  }
  if (openedAt !== null) {
    throw new Error(`${path}: unmatched internal fence at line ${openedAt}`);
  }
  return kept.join("\n");
}

function containsInternalValue(value, rules) {
  const lower = value.toLowerCase();
  return [
    ...(rules.path_prefixes ?? []),
    ...(rules.seat_and_rig_patterns ?? []),
    ...(rules.host_patterns ?? []),
    ...(rules.charged_terms ?? []),
  ].some((token) => lower.includes(token.toLowerCase()));
}

function isInternalPath(path, rules) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return (rules.internal_path_globs ?? []).some((glob) => {
    if (glob === "*.internal.*") {
      return parts.some((part) => part.includes(".internal."));
    }
    if (glob === "**/internal/**") {
      return parts.includes("internal");
    }
    if (glob === "*-internal/**") {
      return parts.some((part) => part.endsWith("-internal"));
    }
    return false;
  });
}

function isExcludedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const file = parts.at(-1);
  return EXCLUDES.some((pattern) => {
    if (pattern === "feedback.md") return file === pattern;
    if (pattern === "evals/") return parts.includes("evals");
    if (pattern === ".DS_Store") return file === pattern;
    if (pattern === "*.local.md") return file.endsWith(".local.md");
    return false;
  });
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

function copyTree(sourceRoot, targetRoot) {
  for (const sourcePath of walkFiles(sourceRoot)) {
    const targetPath = join(targetRoot, relative(sourceRoot, sourcePath));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, lstatSync(sourcePath).mode & 0o777);
  }
}

function skillPathOnEdge(layout, edge, skill) {
  if (layout.edges[edge].layout === "flat") return skill;
  const category = layout.skills[skill]?.category;
  return category ? `${category}/${skill}` : null;
}

function overlaps(left, right) {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}

async function stageHomes({ repoRoot, layout, skills, stagingRoot, membership, rules, scan }) {
  const sources = new Map(
    skills.map(({ skill, home, paths }) => [skill, join(repoRoot, layout.edges[home].path, paths[home])]),
  );
  await stagePublicSkills({ sourceFor: (skill) => sources.get(skill), stagingRoot, membership, rules, scan });
}

// Files that differ between two trees, by bytes and permission bits.
function treeDifferences(expectedRoot, actualRoot) {
  const files = (root) =>
    new Map(walkFiles(root).map((path) => [relative(root, path).replaceAll("\\", "/"), path]));
  const expected = files(expectedRoot);
  const actual = files(actualRoot);
  const differences = [];
  for (const [path, expectedPath] of expected) {
    const actualPath = actual.get(path);
    if (!actualPath) {
      differences.push({ path, kind: "missing" });
    } else if (
      !readFileSync(expectedPath).equals(readFileSync(actualPath)) ||
      (lstatSync(expectedPath).mode & 0o777) !== (lstatSync(actualPath).mode & 0o777)
    ) {
      differences.push({ path, kind: "diverged" });
    }
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) differences.push({ path, kind: "extra" });
  }
  return differences.sort((left, right) => left.path.localeCompare(right.path));
}

function syncTree(sourceRoot, targetRoot, edge, prefix, exec) {
  return parseChanges(runRsyncAbsolute(sourceRoot, targetRoot, exec)).map((line) => {
    const path = rsyncChangePath(line);
    return {
      edge,
      path: !prefix ? path : path === "./" || path === "." ? `${prefix}/` : `${prefix}/${path}`,
      reason: line.startsWith("*deleting ")
        ? "delete"
        : line.startsWith(".f") && line[5] === "p"
          ? "mode"
          : "write",
    };
  });
}

// Skill folders on an edge that the layout doesn't declare there. They're never deleted from an
// edge that holds homes; the check reports them until they're declared or removed.
function undeclaredSkills(edgeRoot, edge, layout) {
  const declared = new Set(
    Object.entries(layout.skills)
      .filter(([, entry]) => entry.edges.includes(edge))
      .map(([skill]) => skillPathOnEdge(layout, edge, skill)),
  );
  return walkFiles(edgeRoot)
    .filter((path) => basename(path) === "SKILL.md")
    .map((path) => relative(edgeRoot, dirname(path)).replaceAll("\\", "/"))
    .filter((path) => !declared.has(path))
    .map((path) => ({ edge, path }));
}

function runRsyncAbsolute(sourceRoot, targetRoot, exec) {
  return exec(
    "rsync",
    rsyncAbsoluteArgs({
      sourceDir: sourceRoot,
      targetDir: targetRoot,
      dryRun: false,
    }),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

function rsyncAbsoluteArgs({ sourceDir, targetDir, dryRun }) {
  return [
    "-a",
    "--delete",
    "--delete-excluded",
    "--itemize-changes",
    ...(dryRun ? ["-n"] : []),
    "--checksum",
    ...EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    sourceDir.endsWith("/") ? sourceDir : sourceDir + "/",
    targetDir.endsWith("/") ? targetDir : targetDir + "/",
  ];
}

function rsyncChangePath(line) {
  if (line.startsWith("*deleting ")) return line.slice("*deleting ".length);
  const separator = line.indexOf(" ");
  return separator === -1 ? line : line.slice(separator + 1).trim();
}

function validateGeneratedControls(layout, digests) {
  validateAuthoringLayout(layout);
  if (!isRecord(digests?.edges) || Object.keys(digests.edges).length === 0) {
    throw new Error("Digest control must contain edge inventories");
  }
  for (const edge of Object.keys(layout.edges)) {
    if (!isRecord(digests.edges[edge])) {
      throw new Error(`Digest control is missing edge ${edge}`);
    }
  }
}

function validateAuthoringLayout(layout) {
  if (!isRecord(layout?.edges) || Object.keys(layout.edges).length === 0) {
    throw new Error("Layout control must contain edges");
  }
  const edgeNames = Object.keys(layout.edges).sort();
  const requiredEdges = ["canonical", "plugin", "spec"];
  if (
    edgeNames.length !== requiredEdges.length ||
    edgeNames.some((edge, index) => edge !== requiredEdges[index])
  ) {
    throw new Error(
      "Layout control must contain exactly canonical, plugin, and spec edges",
    );
  }
  if (!isRecord(layout.skills) || Object.keys(layout.skills).length === 0) {
    throw new Error("Layout control must contain skills");
  }
  for (const [edge, config] of Object.entries(layout.edges)) {
    if (
      !isRecord(config) ||
      typeof config.path !== "string" ||
      config.path.length === 0 ||
      !["categorized", "mirror-of-spec", "flat"].includes(config.layout)
    ) {
      throw new Error(`Layout control has invalid edge ${edge}`);
    }
  }
  for (const [skill, config] of Object.entries(layout.skills)) {
    if (
      !isRecord(config) ||
      !Array.isArray(config.edges) ||
      config.edges.length === 0 ||
      config.edges.some((edge) => !Object.hasOwn(layout.edges, edge))
    ) {
      throw new Error(`Layout control has invalid skill ${skill}`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
