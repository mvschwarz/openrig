# Phase 4 Task Breakdown — AgentPackage Repo-First Projection

Pair: r01-dev1 (impl + qa)
Date: 2026-03-25
Status: DRAFT — needs architect sign-off
Revision: 1
Peer consultation: /tmp/rigged/phase4-consultation.md

---

## Conventions

- **Risk**: Standard or **HIGH**
- **Depends on**: task IDs that must be complete first
- **Test**: what proves the task is done
- **Files**: primary files created or modified
- Each task = pre-edit gate → TDD (RED/GREEN) → post-edit gate → commit

---

## Architecture Rules

- Domain logic is framework-agnostic (zero Hono imports in `domain/` or `adapters/`)
- Same db handle enforced across all domain services
- Phase 4 is **daemon domain layer + API routes only** — no browser UI
- Phase 4 projects **skills, guidance, agents** only — hooks/MCP parsed but deferred
- Phase 4 scope is **project_shared** only — no user_global writes
- Install protocol stages 1-4 + thin slices of 5, 6, 7 + full stage 8
- Three storage tables: `packages`, `package_installs`, `install_journal`

---

## Design Decisions

### What Phase 4 applies

| Export type | Phase 4 action |
|-------------|----------------|
| Skills | `safe_projection` — copy/symlink to install surface |
| Guidance (managed_block, append, prepend) | Deterministic `managed_merge` |
| Agents/subagents | `safe_projection` |
| Hooks | Parsed, classified, **deferred** |
| MCP | Parsed, classified, **deferred** |
| Requirements | Parsed, classified, **deferred** |

### What Phase 4 does NOT do

- No browser UI for package browsing/installing
- No user_global writes
- No external installs (CLI tools, system packages)
- No `replace` or `manual` merge strategies
- No runtime-specific effective-state verification
- No agent-mediated semantic merge (Phase 6)

### Install surfaces (project_shared, Phase 4)

| Export | Claude Code target | Codex target |
|--------|-------------------|--------------|
| Skills | `.claude/skills/<name>/` or `<project>/.claude/skills/` | `.agents/skills/<name>/` |
| Guidance (AGENTS.md) | N/A (Claude uses CLAUDE.md) | `AGENTS.md` managed block |
| Guidance (CLAUDE.md) | `CLAUDE.md` managed block | N/A (Codex uses AGENTS.md) |
| Agents | `.claude/agents/<name>.yaml` | `.agents/<name>.yaml` |

---

## Types

```typescript
// Package manifest (parsed from package.yaml)
interface PackageManifest {
  schemaVersion: number;
  name: string;
  version: string;
  summary: string;
  compatibility: { runtimes: string[] };
  exports: PackageExports;
  requirements?: PackageRequirements;
  installPolicy?: InstallPolicy;
  verification?: VerificationConfig;
}

interface PackageExports {
  skills?: SkillExport[];
  guidance?: GuidanceExport[];
  agents?: AgentExport[];
  hooks?: HookExport[];
  mcp?: McpExport[];
}

interface SkillExport {
  source: string;
  name: string;
  supportedScopes: string[];
  defaultScope: string;
}

interface GuidanceExport {
  source: string;
  kind: "agents_md" | "claude_md" | "generic_rules_overlay";
  supportedScopes: string[];
  defaultScope: string;
  mergeStrategy: "managed_block" | "append" | "prepend" | "replace" | "manual";
}

// Role resolution
interface RoleDefinition {
  name: string;
  description: string;
  skills: string[];
  guidance?: string[];
  hooks?: string[];
  context?: string[];
}

// Install planning
type ActionClassification =
  | "safe_projection"
  | "managed_merge"
  | "config_mutation"
  | "external_install"
  | "manual_only";

interface InstallPlanEntry {
  exportType: string;
  exportName: string;
  classification: ActionClassification;
  targetPath: string;
  sourcePath?: string;  // Absent for requirements (no source file)
  scope: string;
  conflict?: ConflictInfo;
  deferred: boolean;
  deferReason?: string;
}

interface ConflictInfo {
  existingPath: string;
  existingHash?: string;
  sourceHash?: string;
  reason: string;
}

interface InstallPlan {
  packageId?: string;  // Set on persistence — undefined during planning
  packageName: string;
  entries: InstallPlanEntry[];
  actionable: InstallPlanEntry[];     // safe_projection + allowed managed_merge
  deferred: InstallPlanEntry[];       // hooks, MCP, external, manual
  conflicts: InstallPlanEntry[];      // entries with conflicts
}

// Install outcome
type InstallOutcome =
  | { ok: true; result: InstallResult }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "conflict_blocked"; conflicts: ConflictInfo[] }
  | { ok: false; code: "apply_error"; message: string };

interface InstallResult {
  installId: string;
  packageName: string;
  packageVersion: string;
  applied: JournalEntry[];
  deferred: InstallPlanEntry[];
  conflicts: ConflictInfo[];
}
```

---

## Layer 0: Schema

### P4-T00 — Package storage schema

| Field | Value |
|---|---|
| Risk | **HIGH** — foundational for all install operations |
| Depends on | Phase 3 complete |
| Files | `src/db/migrations/008_packages.ts`, `src/db/migrations/009_install_journal.ts`, `test/schema-packages.test.ts` |
| Test | See test plan below |

**Schema:**

```sql
-- Package identity / manifest snapshot
CREATE TABLE packages (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  source_kind     TEXT NOT NULL,       -- 'local_path', 'github'
  source_ref      TEXT NOT NULL,       -- path or repo URL
  manifest_hash   TEXT NOT NULL,
  summary         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, version)
);

-- One install attempt into one target context
CREATE TABLE package_installs (
  id              TEXT PRIMARY KEY,
  package_id      TEXT NOT NULL REFERENCES packages(id),
  target_root     TEXT NOT NULL,       -- repo root path
  scope           TEXT NOT NULL,       -- 'project_shared' for Phase 4
  status          TEXT NOT NULL DEFAULT 'planned',
  risk_tier       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at      TEXT,
  rolled_back_at  TEXT
);

CREATE INDEX idx_installs_package ON package_installs(package_id);

-- Append-only action log per install
CREATE TABLE install_journal (
  id              TEXT PRIMARY KEY,
  install_id      TEXT NOT NULL REFERENCES package_installs(id),
  action          TEXT NOT NULL,       -- 'copy', 'merge_block', 'append', 'backup', 'rollback'
  export_type     TEXT NOT NULL,       -- 'skill', 'guidance', 'agent'
  classification  TEXT NOT NULL,       -- ActionClassification
  target_path     TEXT NOT NULL,
  backup_path     TEXT,
  before_hash     TEXT,
  after_hash      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_journal_install ON install_journal(install_id);
```

**TEST PLAN (8 tests):**
1. packages table created with correct columns
2. package_installs table created with FK to packages
3. install_journal table created with FK to package_installs
4. Insert package → query by name+version
5. Insert install → query by package_id
6. Insert journal entry → query by install_id
7. UNIQUE constraint on packages(name, version)
8. Package delete does NOT cascade to installs (installs are audit trail)

---

## Layer 1: Parser / Validator

### P4-T01 — AgentPackage manifest parser + validator

| Field | Value |
|---|---|
| Risk | **HIGH** — package format is the portability contract |
| Depends on | P4-T00 |
| Files | `src/domain/package-manifest.ts`, `test/package-manifest.test.ts` |
| Test | See test plan below |

**APPROACH:**

Two-phase parse (same pattern as RigSpecCodec + RigSpecSchema):
- `parseManifest(yamlString: string): unknown` — pure YAML parse
- `validateManifest(raw: unknown): ValidationResult` — schema validation
- `normalizeManifest(raw: unknown): PackageManifest` — apply defaults, produce typed object

**Validation rules:**
- schema_version must be 1
- name required, non-empty
- version required, semver-like
- compatibility.runtimes required, non-empty, known values (claude-code, codex)
- Each skill export: source required, name required, supported_scopes valid
- Each guidance export: source, kind, merge_strategy all required and valid
- Export source paths must not escape package root (no `../`)
- Roles: if present, all referenced skills/guidance must exist in exports

**TEST PLAN (12 tests):**
1. Valid manifest → passes validation
2. Missing name → error
3. Missing version → error
4. Unknown runtime → error
5. Unknown guidance kind → error
6. Unknown merge strategy → error
7. Export source with path traversal (`../`) → error
8. Role references nonexistent skill → error
9. Multiple errors reported (not short-circuit)
10. normalize applies defaults (defaultScope, schemaVersion)
11. Hooks and MCP parsed correctly (not rejected)
12. Round-trip: parse → validate → normalize → serialize

### P4-T02 — Package source resolver + repository

| Field | Value |
|---|---|
| Risk | **HIGH** — source resolution is the trust boundary |
| Depends on | P4-T00, P4-T01 |
| Files | `src/domain/package-resolver.ts`, `src/domain/package-repository.ts`, `test/package-resolver.test.ts`, `test/package-repository.test.ts` |
| Test | See test plan below |

**APPROACH:**

PackageResolver:
- `resolve(sourceRef: string): ResolvedPackage` — find package root, read manifest, hash it
- Supports: local path (absolute or relative to cwd)
- Future: github refs (Phase 5+)

PackageRepository (DB):
- `createPackage(...)` → persist resolved package
- `getPackage(id)` → retrieve
- `findByNameVersion(name, version)` → lookup
- `listPackages()` → all installed

**TEST PLAN (8 tests):**
1. Resolve local path → finds package.yaml, parses manifest
2. Resolve path without package.yaml → error
3. Resolve path with invalid manifest → validation error
4. Manifest hash is deterministic (same content → same hash)
5. createPackage persists and returns typed Package
6. findByNameVersion returns correct package
7. Duplicate name+version → unique constraint error
8. listPackages returns all

### P4-T03 — Role resolution + export filter

| Field | Value |
|---|---|
| Risk | Standard |
| Depends on | P4-T01 |
| Files | `src/domain/role-resolver.ts`, `test/role-resolver.test.ts` |
| Test | See test plan below |

**APPROACH:**

RoleResolver:
- `resolveRole(manifest: PackageManifest, roleName: string): ResolvedExports`
- Expands role → concrete skill/guidance/hook references
- Filters to Phase 4-safe surfaces (skills, guidance, agents)
- Marks hooks/MCP as deferred with reason

**TEST PLAN (6 tests):**
1. Role with skills only → all skills in output
2. Role with hooks → hooks marked deferred, skills still output
3. Role references nonexistent skill → error
4. No role specified → full package exports used
5. Deferred items include reason string
6. Mixed role (skills + guidance + hooks) → correct split

---

## Layer 2: Planning

### P4-T04 — Repo-first discovery + install planner

| Field | Value |
|---|---|
| Risk | **HIGH** — the planning engine drives everything downstream |
| Depends on | P4-T01, P4-T02, P4-T03 |
| Files | `src/domain/install-planner.ts`, `test/install-planner.test.ts` |
| Test | See test plan below |

**APPROACH:**

InstallPlanner:
- `plan(resolvedPackage, targetRoot, options): InstallPlan`
- Discovers current repo state (what skills/guidance/agents already exist)
- Computes desired projection state from package exports
- Produces structured plan with per-entry classification

**TEST PLAN (10 tests):**
1. Clean repo → all entries classified as safe_projection
2. Existing skill with same name → conflict detected
3. Existing AGENTS.md → guidance classified as managed_merge
4. No existing AGENTS.md → guidance classified as safe_projection (new file)
5. Hook export → classified as deferred
6. MCP export → classified as deferred
7. Plan includes target paths for each export
8. Plan separates actionable vs deferred vs conflicts
9. Multiple exports planned correctly
10. Role-filtered exports produce correct plan subset

### P4-T05 — Conflict detector + classification engine

| Field | Value |
|---|---|
| Risk | **HIGH** — wrong classification = silent clobbering or blocked installs |
| Depends on | P4-T04 |
| Files | `src/domain/conflict-detector.ts`, `test/conflict-detector.test.ts` |
| Test | See test plan below |

**Classification rules:**

| Scenario | Classification |
|----------|---------------|
| Skill target doesn't exist | `safe_projection` |
| Skill target exists, different content | Conflict → `safe_projection` with overwrite warning |
| Skill target exists, same content | No-op (skip) |
| Guidance target doesn't exist | `safe_projection` (new file) |
| Guidance target exists, no managed block | `managed_merge` |
| Guidance target exists, has managed block | `managed_merge` (update block) |
| Hook export | `config_mutation` → deferred |
| MCP export | `config_mutation` → deferred |
| Requirement | `external_install` → deferred |

**TEST PLAN (10 tests):**
1. New skill → safe_projection
2. Existing skill, different content → conflict with overwrite info
3. Existing skill, same content → no-op
4. New guidance file → safe_projection
5. Existing guidance, no managed block → managed_merge
6. Existing guidance, has managed block → managed_merge (update)
7. Hook → config_mutation, deferred
8. MCP → config_mutation, deferred
9. Requirement → external_install, deferred
10. Multiple conflicts reported together

---

## Layer 3: Apply + Rollback

### P4-T06 — Approval policy boundary

| Field | Value |
|---|---|
| Risk | Standard |
| Depends on | P4-T05 |
| Files | `src/domain/install-policy.ts`, `test/install-policy.test.ts` |
| Test | See test plan below |

**APPROACH:**

Thin policy gate:
- `safe_projection` → auto-approve
- `managed_merge` (managed_block, append, prepend) → requires explicit `allowMerge: true` flag
- `config_mutation`, `external_install`, `manual_only` → reject with reason (Phase 5+)

**TEST PLAN (5 tests):**
1. safe_projection → approved
2. managed_merge without flag → rejected with reason
3. managed_merge with allowMerge: true → approved
4. config_mutation → rejected with "deferred to Phase 5"
5. Mixed plan → correct split of approved/rejected

### P4-T07 — Journaled apply engine + backups + rollback

| Field | Value |
|---|---|
| Risk | **HIGH** — the transactional heart of Phase 4 |
| Depends on | P4-T04, P4-T05, P4-T06, P4-T00 |
| Files | `src/domain/install-engine.ts`, `src/domain/install-repository.ts`, `test/install-engine.test.ts`, `test/install-repository.test.ts` |
| Test | See test plan below |

**APPROACH:**

InstallEngine:
- `apply(plan: InstallPlan, options): InstallResult`
  1. Create package_install record (status: planned)
  2. For each approved entry:
     a. Backup existing file (if any) to `.rigged-backups/<installId>/`
     b. Apply: copy skill, merge guidance block, copy agent
     c. Write journal entry with before/after hashes
  3. Update package_install status to applied
  4. Return result with applied + deferred + conflicts

- `rollback(installId: string): RollbackResult`
  1. Read journal entries for install
  2. Restore each backed-up file (or delete if no backup existed)
  3. Update package_install status to rolled_back
  4. Return result

InstallRepository (DB):
- CRUD for package_installs and install_journal

**Managed block merge:**
```
<!-- BEGIN RIGGED MANAGED BLOCK: package-name -->
... guidance content ...
<!-- END RIGGED MANAGED BLOCK: package-name -->
```

**TEST PLAN (14 tests):**
1. Clean install: skills copied to target paths
2. Clean install: guidance file created with managed block markers
3. Clean install: journal entries written with correct hashes
4. Clean install: package_install status = applied
5. Existing guidance: managed block inserted without clobbering surrounding content
6. Existing managed block: updated in place
7. Backup created before overwrite
8. Rollback restores original files from backup
9. Rollback of new file → file deleted
10. Rollback updates package_install status
11. Failed mid-apply → partial rollback (compensating)
12. Journal entries track before/after hashes
13. Install into nonexistent target directory → directory created
14. listInstalls returns correct records with status

---

## Layer 4: Verification

### P4-T08 — Deterministic post-apply verification

| Field | Value |
|---|---|
| Risk | Standard |
| Depends on | P4-T07 |
| Files | `src/domain/install-verifier.ts`, `test/install-verifier.test.ts` |
| Test | See test plan below |

**APPROACH:**

InstallVerifier:
- `verify(installId: string): VerificationResult`
  1. Read journal entries for install
  2. For each applied entry:
     - Target file exists
     - Content hash matches after_hash from journal
     - Managed block markers present (for guidance)
  3. Backup files exist and match before_hash
  4. Install status is consistent

**TEST PLAN (6 tests):**
1. Clean install → all checks pass
2. Missing target file → verification failure
3. Modified target (hash mismatch) → verification failure
4. Missing managed block markers → verification failure
5. Backup integrity check passes
6. Verification result includes per-entry status

---

## Layer 5: API Routes

### P4-T09 — Package install API routes + app wiring

| Field | Value |
|---|---|
| Risk | **HIGH** — user-facing install trigger |
| Depends on | P4-T07, P4-T08 |
| Files | `src/routes/packages.ts`, `src/server.ts` (extend), `src/startup.ts` (wire), `test/packages-routes.test.ts`, `test/server.test.ts` |
| Test | See test plan below |

**ROUTES:**
- `POST /api/packages/validate` → parse + validate manifest from body
- `POST /api/packages/plan` → resolve + plan install (dry run)
- `POST /api/packages/install` → resolve + plan + apply
- `POST /api/packages/:installId/rollback` → rollback install
- `GET /api/packages` → list installed packages
- `GET /api/packages/:packageId/installs` → list installs for package
- `GET /api/packages/installs/:installId/journal` → journal for install

**Route → status mapping:**
- ok: true → 200/201
- validation_failed → 400
- conflict_blocked → 409
- apply_error → 500

**TEST PLAN (12 tests):**
1. POST /validate valid manifest → 200 + validation result
2. POST /validate invalid manifest → 400 + errors
3. POST /plan → 200 + install plan with classified entries
4. POST /install clean repo → 201 + install result
5. POST /install with conflicts → 409 + conflict info
6. POST /install with allowMerge → 201 + merged guidance
7. POST /:installId/rollback → 200 + rollback result
8. GET /packages → list
9. GET /:packageId/installs → install history
10. GET /installs/:installId/journal → journal entries
11. Same-db-handle assertions for new deps
12. Startup wires all Phase 4 deps

---

---

## Layer 6: CLI Commands

### P4-T10 — Package management CLI commands

| Field | Value |
|---|---|
| Risk | Standard |
| Depends on | P4-T09 |
| Files | `packages/cli/src/commands/package.ts`, `packages/cli/test/package.test.ts` |
| Test | See test plan below |

**COMMANDS:**
- `rigged package validate <path>` — POST /api/packages/validate with manifest from path
- `rigged package plan <path> [--role <name>]` — POST /api/packages/plan, print classified entries
- `rigged package install <path> [--role <name>] [--allow-merge]` — POST /api/packages/install
- `rigged package rollback <installId>` — POST /api/packages/:installId/rollback
- `rigged package list` — GET /api/packages, formatted table

**Output design (agent-friendly):**
- Structured, parseable output — agents will read this
- Plan output shows each entry with classification, target path, and conflict info
- Install output shows applied + deferred + conflicts
- Rollback output confirms what was restored
- Exit codes: 0 success, 1 validation/conflict error, 2 apply error

**TEST PLAN (8 tests):**
1. validate valid package → prints "Valid" + summary
2. validate invalid package → prints errors, exit 1
3. plan clean repo → prints classified entries
4. plan with conflicts → prints conflict info
5. install clean → prints applied entries + deferred items
6. install with --allow-merge → prints merged guidance
7. rollback → prints restored files
8. list → formatted table of installed packages

---

## Dependency Graph

```
P4-T00 ─── P4-T01 ─── P4-T02
             │          │
             └── P4-T03 │
                  │      │
             P4-T04 ────┘
                  │
             P4-T05
                  │
             P4-T06
                  │
             P4-T07 ─── P4-T08 ─── P4-T09 ─── P4-T10
```

## Recommended Execution Order

| Order | Task | Rationale |
|---|---|---|
| 1 | P4-T00 | Schema — unblocks everything |
| 2 | P4-T01 | Manifest parser — everything depends on the package model |
| 3 | P4-T02, P4-T03 | **Parallel** — resolver and role resolution are independent |
| 4 | P4-T04 | Install planner (needs resolver + roles) |
| 5 | P4-T05 | Conflict detector (needs planner) |
| 6 | P4-T06 | Policy boundary (needs classifier) |
| 7 | P4-T07 | Apply engine (needs everything above) |
| 8 | P4-T08 | Verification (needs engine) |
| 9 | P4-T09 | API routes + wiring |
| 10 | P4-T10 | CLI commands (needs routes) |

## Definition of Done

- [ ] All 11 tasks complete with passing tests
- [ ] `npm test` passes from root (all packages)
- [ ] Can validate a package.yaml manifest via API
- [ ] Can preview an install plan with classifications
- [ ] Can install skills + guidance + agents into a clean repo
- [ ] Can detect conflicts with existing repo assets
- [ ] Guidance merge uses managed block markers (no clobbering)
- [ ] Can rollback an install to pre-apply state
- [ ] Hooks and MCP parsed but explicitly deferred
- [ ] Roles resolve to concrete export sets
- [ ] Install journal records all actions with hashes
- [ ] Post-apply verification checks file existence + content integrity
- [ ] Same-db-handle invariants for all new deps
- [ ] CLI commands work end-to-end (validate, plan, install, rollback, list)
- [ ] CLI output is agent-friendly (structured, parseable, correct exit codes)
- [ ] Zero Hono imports in `domain/`
