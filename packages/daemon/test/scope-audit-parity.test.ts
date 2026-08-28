import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  classifyScopeItem as daemonClassifier,
  type ScopeAuditInput,
} from "../src/domain/scope/scope-audit.js";
import {
  NODE_FILE_PRECEDENCE,
  NOTES_FILE_PRECEDENCE,
  resolveNotesFile as resolveDaemonNotesFile,
} from "../src/domain/scope/node-file.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TRACE_TO_ROOT = path.join(
  REPO_ROOT,
  "packages/daemon/assets/plugins/openrig-core/skills/refocusing/scripts/trace-to-root.py",
);

const PRODUCTION_CODE_ROOTS = [
  "packages/cli/src",
  "packages/daemon/src",
  "packages/daemon/assets/plugins",
] as const;
const NOTES_RESOLVER_FILES = new Set([
  "packages/cli/src/lib/scope/scope-fs.ts",
  "packages/daemon/src/domain/scope/node-file.ts",
]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py"]);

function enumerateCodeFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...enumerateCodeFiles(candidate));
    else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) files.push(candidate);
  }
  return files;
}

function privateNotesReaderLines(content: string): string[] {
  return content.split("\n").filter((line) =>
    /missionNotes(?:Current|Legacy|Exists)/.test(line)
    || (
      /\b(?:NOTES|MISSION_NOTES)\.md\b/.test(line)
      && /(?:existsSync|accessSync|statSync|readFileSync|createReadStream|\.is_file\(|\.exists\(|\.stat\(|\.read_text\(|\bopen\()/.test(line)
    ),
  );
}

const CLASSIFIER_FILES = [
  { cli: "packages/cli/src/lib/scope/scope-audit.ts", daemon: "packages/daemon/src/domain/scope/scope-audit.ts" },
  { cli: "packages/cli/src/lib/scope/dot-id.ts", daemon: "packages/daemon/src/domain/scope/dot-id.ts" },
  { cli: "packages/cli/src/lib/scope/types.ts", daemon: "packages/daemon/src/domain/scope/types.ts" },
  // release-0.4.7 intent-stage: the shared scaffold-placeholder grammar twin
  // (arch AR-1 ruling — one grammar, twin-pinned; see the module header).
  { cli: "packages/cli/src/lib/scope/scaffold-placeholder.ts", daemon: "packages/daemon/src/domain/scope/scaffold-placeholder.ts" },
  // KI-5.3-2: the shared logical-checkbox item grammar twin — one grammar for
  // the review composer, the slice-detail projector, and `rig proof add`, so a
  // byIndex evidence ref names the same promise everywhere (see module header).
  { cli: "packages/cli/src/lib/scope/logical-checkbox.ts", daemon: "packages/daemon/src/domain/scope/logical-checkbox.ts" },
];

const SHARED_FIXTURES: Array<{ label: string; input: ScopeAuditInput }> = [
  {
    label: "present: valid id + PROGRESS.md",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.4.0", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "missing: no PROGRESS.md, no marker",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.4.0", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "malformed: YAML parse error + id line (ghost)",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: OPR.0.4.0.1\nbad: {{yaml", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "malformed: YAML parse error without id line",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "broken: {{yaml", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "readme-only: marker set, no PROGRESS.md",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: OPR.0.4.0.2\nprogress_rail: readme-only", progressFileExists: false, readmeOnlyMarker: true, isActiveRelease: true, level: "slice" },
  },
  {
    label: "missing-id: frontmatter parses but no id",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "title: Some slice\nstatus: active", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "id-convention-violation: bad mission id",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: not-a-dot-id", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "id-convention-violation: bad slice id",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: not-valid", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: false, level: "slice" },
  },
  {
    label: "no frontmatter (null): emits missing_id",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: null, progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "historical severity: missing progress LOW",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.3.4", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: false, level: "mission" },
  },
];

describe("scope-audit CLI/daemon parity (CI-FAILING)", () => {
  describe("byte-equivalence", () => {
    for (const pair of CLASSIFIER_FILES) {
      it(`${path.basename(pair.cli)} is byte-equivalent across CLI and daemon`, () => {
        const cliContent = fs.readFileSync(path.join(REPO_ROOT, pair.cli), "utf-8");
        const daemonContent = fs.readFileSync(path.join(REPO_ROOT, pair.daemon), "utf-8");
        expect(daemonContent).toBe(cliContent);
      });
    }

    it("retires the per-commit PROGRESS classifier and its CLI-only inputs everywhere", () => {
      const files = [
        "packages/cli/src/lib/scope/scope-audit.ts",
        "packages/daemon/src/domain/scope/scope-audit.ts",
        "packages/cli/src/commands/scope.ts",
        "packages/daemon/src/routes/scope-audit.ts",
      ];
      for (const file of files) {
        const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
        expect(content, file).not.toContain("progress_not_updated_on_commit");
        expect(content, file).not.toContain("sliceTouchedByRecentCommit");
        expect(content, file).not.toContain("progressTouchedByRecentCommit");
      }
    });

    it("keeps private notes readers out of recursively enumerated production code", () => {
      const files = PRODUCTION_CODE_ROOTS.flatMap((root) =>
        enumerateCodeFiles(path.join(REPO_ROOT, root)),
      );
      const relativeFiles = new Set(files.map((file) => path.relative(REPO_ROOT, file)));
      for (const resolver of NOTES_RESOLVER_FILES) expect(relativeFiles.has(resolver), resolver).toBe(true);

      const violations = files.flatMap((file) => {
        const relative = path.relative(REPO_ROOT, file);
        if (NOTES_RESOLVER_FILES.has(relative)) return [];
        return privateNotesReaderLines(fs.readFileSync(file, "utf8"))
          .map((line) => `${relative}: ${line.trim()}`);
      });
      expect(violations).toEqual([]);
    });
  });

  describe("shared-fixture output parity", () => {
    let cliClassifier: typeof daemonClassifier;

    it("loads CLI classifier", async () => {
      const mod = await import(
        path.join(REPO_ROOT, "packages/cli/src/lib/scope/scope-audit.ts")
      );
      cliClassifier = mod.classifyScopeItem;
      expect(typeof cliClassifier).toBe("function");
    });

    for (const fixture of SHARED_FIXTURES) {
      it(`fixture: ${fixture.label}`, () => {
        if (!cliClassifier) throw new Error("CLI classifier not loaded");
        const cliResult = cliClassifier(fixture.input);
        const daemonResult = daemonClassifier(fixture.input);
        expect(daemonResult).toEqual(cliResult);
      });
    }
  });
});

describe("mission notes resolver parity", () => {
  it("runs the same current/legacy precedence matrix through both twins", async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "scope-notes-parity-"));
    const cli = await import(path.join(REPO_ROOT, "packages/cli/src/lib/scope/scope-fs.ts"));
    try {
      expect(NODE_FILE_PRECEDENCE).toEqual(["SPEC.md", "README.md"]);
      expect(cli.NODE_FILE_PRECEDENCE).toEqual(NODE_FILE_PRECEDENCE);
      expect(NOTES_FILE_PRECEDENCE).toEqual(["NOTES.md", "MISSION_NOTES.md"]);
      expect(cli.NOTES_FILE_PRECEDENCE).toEqual(NOTES_FILE_PRECEDENCE);
      const fixtures = [
        { name: "current", files: ["NOTES.md"], bound: "NOTES.md" },
        { name: "legacy", files: ["MISSION_NOTES.md"], bound: "MISSION_NOTES.md" },
        { name: "both", files: ["NOTES.md", "MISSION_NOTES.md"], bound: "NOTES.md" },
        { name: "neither", files: [], bound: null },
      ] as const;
      for (const fixture of fixtures) {
        const dir = path.join(root, fixture.name);
        fs.mkdirSync(dir, { recursive: true });
        for (const file of fixture.files) fs.writeFileSync(path.join(dir, file), file, "utf8");
        const cliResolution = cli.resolveNotesFile(dir);
        const daemonResolution = resolveDaemonNotesFile(dir);
        expect(cliResolution, fixture.name).toEqual(daemonResolution);
        expect(cliResolution?.name ?? null, fixture.name).toBe(fixture.bound);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shipped refocus notes resolution", () => {
  it("uses the real CLI resolver for every locked outcome and reports command failure honestly", () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "scope-notes-refocus-"));
    const workNode = path.join(root, "work-node");
    const bin = path.join(root, "bin");
    const rig = path.join(bin, "rig");
    const currentPath = path.join(workNode, "NOTES.md");
    const legacyPath = path.join(workNode, "MISSION_NOTES.md");
    fs.mkdirSync(workNode, { recursive: true });
    const resolvedWorkNode = fs.realpathSync(workNode);
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(workNode, "SPEC.md"), "---\nintent: Exercise resolution\n---\n", "utf8");
    const launcher = path.join(root, "scope-launcher.mjs");
    fs.writeFileSync(launcher, `import { pathToFileURL } from "node:url";
const { scopeCommand } = await import(pathToFileURL(process.env.OPENRIG_TEST_SCOPE_COMMAND));
await scopeCommand().parseAsync(process.argv);
`, "utf8");
    fs.writeFileSync(rig, `#!/bin/sh
if [ "\${OPENRIG_TEST_SCOPE_RESOLVE_FAIL:-}" = "1" ] && [ "$1" = "scope" ] && [ "$2" = "resolve-notes" ]; then
  printf '%s\n' 'forced resolver failure' >&2
  exit 23
fi
if [ "$1" = "scope" ]; then shift; fi
exec "$OPENRIG_TEST_NODE" --import tsx "$OPENRIG_TEST_SCOPE_LAUNCHER" "$@"
`, "utf8");
    fs.chmodSync(rig, 0o755);
    const baseEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ""}`,
      OPENRIG_TEST_NODE: process.execPath,
      OPENRIG_TEST_SCOPE_COMMAND: path.join(REPO_ROOT, "packages/cli/src/commands/scope.ts"),
      OPENRIG_TEST_SCOPE_LAUNCHER: launcher,
      OPENRIG_WORKSPACE_ROOT: workNode,
    } as NodeJS.ProcessEnv;

    try {
      const fixtures = [
        { label: "resolved current", current: true, legacy: false, unreadableCurrent: false, expected: "current notes", absent: "legacy notes" },
        { label: "resolved legacy", current: false, legacy: true, unreadableCurrent: false, expected: "legacy notes", absent: "current notes" },
        { label: "both prefer current", current: true, legacy: true, unreadableCurrent: false, expected: "current notes", absent: "legacy notes" },
        { label: "unreadable current falls through", current: true, legacy: true, unreadableCurrent: true, expected: "legacy notes", absent: "current notes" },
      ];
      for (const fixture of fixtures) {
        fs.rmSync(currentPath, { force: true });
        fs.rmSync(legacyPath, { force: true });
        if (fixture.current) fs.writeFileSync(currentPath, "current notes\n", "utf8");
        if (fixture.legacy) fs.writeFileSync(legacyPath, "legacy notes\n", "utf8");
        if (fixture.unreadableCurrent) fs.chmodSync(currentPath, 0o000);
        const result = spawnSync("python3", [
          TRACE_TO_ROOT,
          "--trees", "work",
          "--depth", "full",
          "--work-start", workNode,
        ], { cwd: REPO_ROOT, encoding: "utf8", env: baseEnv });
        if (fixture.unreadableCurrent) fs.chmodSync(currentPath, 0o600);
        expect(result.status, fixture.label).toBe(0);
        expect(result.stdout, fixture.label).toContain(fixture.expected);
        expect(result.stdout, fixture.label).not.toContain(fixture.absent);
      }

      fs.rmSync(currentPath, { force: true });
      fs.rmSync(legacyPath, { force: true });
      const missing = spawnSync("python3", [
        TRACE_TO_ROOT,
        "--trees", "work",
        "--depth", "full",
        "--work-start", workNode,
      ], { cwd: REPO_ROOT, encoding: "utf8", env: baseEnv });
      expect(missing.status).toBe(0);
      expect(missing.stdout).toContain(`NOTES GAP — no readable mission notes at ${resolvedWorkNode}`);

      const failed = spawnSync("python3", [
        TRACE_TO_ROOT,
        "--trees", "work",
        "--depth", "full",
        "--work-start", workNode,
      ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...baseEnv, OPENRIG_TEST_SCOPE_RESOLVE_FAIL: "1" },
      });
      expect(failed.status).toBe(0);
      expect(failed.stdout).toContain("NOTES RESOLUTION GAP — resolver command exited 23");
      expect(failed.stdout).not.toContain("NOTES GAP — no readable mission notes");
    } finally {
      if (fs.existsSync(currentPath)) fs.chmodSync(currentPath, 0o600);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// OPR.0.4.4.19 FR-10 — classifier-level backstop tests (run against the
// daemon copy; the parity test above guarantees the CLI copy is identical).
import { describe as describeFr10, it as itFr10, expect as expectFr10 } from "vitest";
import { classifyScopeItem } from "../src/domain/scope/scope-audit.js";

describeFr10("FR-10 backstops (OPR.0.4.4.19)", () => {
  const base = {
    id: null,
    path: "/w/missions/release-x/slices/19-signal-layer",
    readmeFrontmatterRaw: "id: OPR.X.19\nstatus: building",
    progressFileExists: true,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "slice" as const,
  };

  itFr10("C1: a headerless proof artifact yields a finding naming the file, the missing fields, and the fix", () => {
    const result = classifyScopeItem({
      ...base,
      implementationPrdExists: true,
      proofArtifacts: [{ path: "/w/.../proof/rogue.md", frontmatterRaw: null }],
    });
    const finding = result.findings.find((f) => f.kind === "proof_artifact_c1_invalid");
    expectFr10(finding).toBeDefined();
    expectFr10(finding!.path).toBe("/w/.../proof/rogue.md");
    expectFr10(finding!.message).toContain("slice, candidate_sha, artifact_type, verdict, money_evidence");
    expectFr10(finding!.remediation).toContain("rig proof add");
  });

  itFr10("C1: out-of-set values are flagged naming the closed sets; valid headers are clean", () => {
    const bad = classifyScopeItem({
      ...base,
      implementationPrdExists: true,
      proofArtifacts: [{
        path: "/w/.../proof/bad.md",
        frontmatterRaw: "slice: OPR.X.19\ncandidate_sha: abc\nartifact_type: designer\nverdict: SHIP-IT\nmoney_evidence: m",
      }],
    });
    const finding = bad.findings.find((f) => f.kind === "proof_artifact_c1_invalid");
    expectFr10(finding).toBeDefined();
    expectFr10(finding!.message).toContain("designer");
    expectFr10(finding!.message).toContain("SHIP-IT");

    const good = classifyScopeItem({
      ...base,
      implementationPrdExists: true,
      proofArtifacts: [{
        path: "/w/.../proof/good.md",
        frontmatterRaw: "slice: OPR.X.19\ncandidate_sha: abc\nartifact_type: qa\nverdict: CLEAR\nmoney_evidence: the walk shows the decision",
      }],
    });
    expectFr10(good.findings.some((f) => f.kind === "proof_artifact_c1_invalid")).toBe(false);
  });

  itFr10("C7 retired: a current authored node never requires IMPLEMENTATION-PRD.md", () => {
    const result = classifyScopeItem({ ...base, implementationPrdExists: false });
    expectFr10(result.findings.some((f) => f.kind === "missing_impl_prd")).toBe(false);
  });

  itFr10("C7 NEGATIVE: shaping (pre-spec) status with no PRD yields NO missing-spec finding (status-gated)", () => {
    const result = classifyScopeItem({
      ...base,
      readmeFrontmatterRaw: "id: OPR.X.19\nstatus: shaping",
      implementationPrdExists: false,
    });
    expectFr10(result.findings.some((f) => f.kind === "missing_impl_prd")).toBe(false);
  });

  itFr10("inert without caller context: undefined proofArtifacts/implementationPrdExists produce no FR-10 findings", () => {
    const result = classifyScopeItem(base);
    expectFr10(result.findings.some((f) => f.kind === "proof_artifact_c1_invalid" || f.kind === "missing_impl_prd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1 (qitem-20260720015700-630eef64) — the per-section selection
// must land in BOTH twins identically (byte-parity above already pins the
// classifier + scaffold-placeholder twin files; this pins the VERDICT).
// ---------------------------------------------------------------------------

import { describe as describeDf, it as itDf, expect as expectDf } from "vitest";

describeDf("PM dogfood #1 — twin verdict parity: authored README vs pristine PRD", () => {
  const AUTHORED_README = "# S\n## Intent\nauthored intent\n## Mini-requirements\n1. first authored requirement\n## Proof contract\n- [ ] authored deliverable one — captured\n";
  const PRISTINE_PRD = [
    "# PRD",
    "## Intent",
    "[The recorded intent, verbatim — kept in sync with the slice README.]",
    "## Mini-requirements",
    "1. [The concise one-glance requirement tier — this is where approval starts.]",
    "## Proof contract",
    "- [ ] [One promised deliverable, written as an observable outcome — captured.]",
  ].join("\n");

  const input: ScopeAuditInput = {
    id: null,
    path: "/fix/dogfood/slices/01-placeholder-conventions",
    readmeFrontmatterRaw: "id: OPR.99.0.2.1\nstatus: placeholder",
    progressFileExists: true,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "slice",
    readmeContent: AUTHORED_README,
    implementationPrdContent: PRISTINE_PRD,
  };

  itDf("both twins agree AND neither emits a convention finding for the authored-README/pristine-PRD fixture", async () => {
    const mod = await import(path.join(REPO_ROOT, "packages/cli/src/lib/scope/scope-audit.ts"));
    const cliResult = (mod.classifyScopeItem as typeof daemonClassifier)(input);
    const daemonResult = daemonClassifier(input);
    expectDf(daemonResult).toEqual(cliResult); // twin parity, verdict-for-verdict
    const conventionKinds = daemonResult.findings
      .filter((f) => f.kind === "mini_requirements_missing_or_malformed" || f.kind === "proof_contract_missing_or_malformed")
      .map((f) => f.kind);
    expectDf(conventionKinds).toEqual([]); // RED pre-fix: both findings fire
  });
});
