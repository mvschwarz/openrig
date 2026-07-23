// OPR.0.4.4.19 FR-9 — scope approve: frontmatter sole-writer + append-only
// audit row (kills vibe-shuttled approval).
//
// Daemon-side by design (plan-review CONFIRMED; arch-lead interface-cell
// PASS): the stamp is a workspace frontmatter write, the audit row is a
// mission_control_actions insert, and the freeze-trigger interface cell
// (Packet 2) invokes the compose-and-freeze endpoint AFTER the stamp+audit
// commit — so the stamp+audit pair lives behind ONE daemon operation.
//
// Ordering (arch-lead PIN, 2026-07-04): frontmatter-first → audit-second →
// on audit failure LOUD-FAIL + byte-restore the prior frontmatter. The
// compensating-DELETE variant is REJECTED — no row is ever deleted from
// mission_control_actions; append-only stands.
//
// Two-regime role clarity (BR-6, ratified): approval is the freeze/LOCKED
// trigger and the regime-2 sign-off — it is NEVER the source of proven-green.
// Nothing here computes or stores "green".

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { MissionControlActionLog } from "../mission-control/mission-control-action-log.js";
import { derivePlanLockArtifacts } from "./plan-lock-artifacts.js";

export type ScopeTier = "slice" | "mission";
export type ApprovalScope = "spec" | "delivery";

export interface ScopeApproveInput {
  scopeTier: ScopeTier;
  /** Canonical missions-root-relative path (e.g.
   *  "release-0.4.4/slices/19-living-notes-signal-layer" or "release-0.4.4"). */
  scopePath: string;
  /** STAGED APPROVAL (founder un-deferred): `spec` = "the PRD matches my
   *  intent" (the first accept-point); `delivery` = the terminal sign-off
   *  (the freeze trigger). Omitted upstream ⇒ delivery (back-compat). */
  approvalScope: ApprovalScope;
  /** The REAL invoking session (honest provenance — never overwritten by
   *  delegation). */
  actorSession: string;
  /** DELEGATED APPROVAL: whose decision this stamp records when an agent
   *  invokes on the founder's behalf. Recorded in the audit notes only. */
  onBehalfOf?: string | null;
}

export interface ScopeApproveResult {
  scopeTier: ScopeTier;
  scopeId: string;
  scopePath: string;
  approvalScope: ApprovalScope;
  approvedBy: string;
  approvedAt: string;
  onBehalfOf: string | null;
  actionId: string;
  /** Packet-2 interface cell: only the DELIVERY stamp fires the freeze; the
   *  compose-and-freeze endpoint ships in Packet 2, so P1 always reports
   *  false. The stamp + audit row stand regardless of any render outcome. */
  freezeFired: false;
}

export class ScopeApproveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ScopeApproveError";
  }
}

/** The pinned audit_notes_json shape (spec-guard blocker 2): a stable,
 *  queryable scope-target identity + the approval scope + delegation
 *  provenance. The audit-browse read path filters on these keys — the pair
 *  is what makes Packet 2's one-query UNVERIFIED-stamp cross-check real. */
export interface ScopeApprovalAuditNotes extends Record<string, unknown> {
  kind: "scope-approval";
  scope_tier: ScopeTier;
  scope_id: string;
  scope_path: string;
  approval_scope: ApprovalScope;
  on_behalf_of: string | null;
}

const STAMP_FIELDS: Record<ApprovalScope, { by: string; at: string }> = {
  delivery: { by: "approved-by", at: "approved-at" },
  spec: { by: "approved-spec-by", at: "approved-spec-at" },
};

interface ScopeApproveDeps {
  /** Resolves the live missions root (SliceIndexer.slicesRoot), or null when
   *  the workspace is not configured. */
  missionsRoot: () => string | null;
  actionLog: MissionControlActionLog;
  now?: () => Date;
}

export class ScopeApproveService {
  private readonly deps: ScopeApproveDeps;

  constructor(deps: ScopeApproveDeps) {
    this.deps = deps;
  }

  approve(input: ScopeApproveInput): ScopeApproveResult {
    const missionsRoot = this.deps.missionsRoot();
    if (!missionsRoot) {
      throw new ScopeApproveError(
        "workspace_not_configured",
        "The daemon has no missions root configured; scope approve needs the workspace primitive.",
      );
    }

    // Path containment: the scope path must resolve INSIDE the missions root
    // (content-surfaces discipline — no ../ escapes).
    const resolved = path.resolve(missionsRoot, input.scopePath);
    if (resolved !== missionsRoot && !resolved.startsWith(missionsRoot + path.sep)) {
      throw new ScopeApproveError(
        "scope_path_escape",
        `scopePath '${input.scopePath}' resolves outside the missions root.`,
        { scopePath: input.scopePath },
      );
    }
    const readmePath = path.join(resolved, "README.md");
    if (!fs.existsSync(readmePath)) {
      throw new ScopeApproveError(
        "scope_not_found",
        `No README.md at ${input.scopePath} under the missions root — not a declared ${input.scopeTier}.`,
        { scopePath: input.scopePath, scopeTier: input.scopeTier },
      );
    }

    const originalBytes = fs.readFileSync(readmePath, "utf8");
    const frontmatter = parseFrontmatter(originalBytes);

    const scopeId = typeof frontmatter["id"] === "string" && frontmatter["id"].trim().length > 0
      ? (frontmatter["id"] as string)
      : null;
    if (!scopeId) {
      throw new ScopeApproveError(
        "scope_id_missing",
        `${input.scopePath} has no frontmatter id (dot-ID) — the audit target contract requires a stable scope_id.`,
        { scopePath: input.scopePath, action: "Run: rig scope " + input.scopeTier + " reconcile <path> to mint the id, then re-approve." },
      );
    }

    // Re-stamp at the SAME scope fails loudly naming the existing stamp
    // (no silent re-stamp; un-approve/re-approve is out of scope v1). A
    // spec stamp followed by a delivery stamp is the normal staged sequence.
    const fields = STAMP_FIELDS[input.approvalScope];
    const existingBy = frontmatter[fields.by];
    if (typeof existingBy === "string" && existingBy.trim().length > 0) {
      throw new ScopeApproveError(
        "already_approved",
        `${input.scopePath} already carries a ${input.approvalScope} approval stamp: ${fields.by}: ${existingBy}, ${fields.at}: ${String(frontmatter[fields.at] ?? "?")}. Re-approval after un-approval is out of scope v1.`,
        { scopePath: input.scopePath, approvalScope: input.approvalScope, existingBy, existingAt: frontmatter[fields.at] ?? null },
      );
    }

    const approvedAt = (this.deps.now?.() ?? new Date()).toISOString();

    // Stage-3 Lever A — plan-lock snapshot: ONLY a slice SPEC approval derives +
    // co-serializes the `locked-artifacts` set (mission/delivery NEVER create it;
    // a delivery merge preserves an existing list). PRD read fails open to null.
    const isPlanLock = input.scopeTier === "slice" && input.approvalScope === "spec";
    const lockedArtifacts = isPlanLock
      ? derivePlanLockArtifacts(originalBytes, tryReadPRD(resolved))
      : undefined;

    // 1. Frontmatter FIRST (the arch-pinned ordering). The stamp AND the
    // co-serialized `locked-artifacts` land in ONE writeFrontmatterFields +
    // writeFileSync — so a later audit failure restores a clean verbatim README.
    const updated = writeFrontmatterFields(originalBytes, {
      [fields.by]: input.actorSession,
      [fields.at]: approvedAt,
      ...(isPlanLock ? { "locked-artifacts": lockedArtifacts } : {}),
    });
    fs.writeFileSync(readmePath, updated, "utf8");

    // 2. Audit SECOND. On failure: byte-restore the prior frontmatter and
    // fail loudly — a failed audit write can never leave a trusted half-stamp
    // (QA plan-review guardrail), and no audit row is ever deleted.
    const scopePathCanonical = path.relative(missionsRoot, resolved).split(path.sep).join("/");
    const auditNotes: ScopeApprovalAuditNotes = {
      kind: "scope-approval",
      scope_tier: input.scopeTier,
      scope_id: scopeId,
      scope_path: scopePathCanonical,
      approval_scope: input.approvalScope,
      on_behalf_of: input.onBehalfOf ?? null,
    };
    let actionId: string;
    try {
      const entry = this.deps.actionLog.record({
        actionVerb: "approve",
        qitemId: null, // scope approvals are NOT qitem actions
        actorSession: input.actorSession,
        actedAt: approvedAt,
        reason: input.onBehalfOf
          ? `scope-approval (${input.approvalScope}) on behalf of ${input.onBehalfOf}`
          : `scope-approval (${input.approvalScope})`,
        auditNotes,
      });
      actionId = entry.actionId;
    } catch (err) {
      fs.writeFileSync(readmePath, originalBytes, "utf8");
      throw new ScopeApproveError(
        "audit_write_failed",
        `The approval audit row could not be written; the frontmatter stamp was restored to its prior state (no half-stamp). Cause: ${err instanceof Error ? err.message : String(err)}`,
        { scopePath: input.scopePath, approvalScope: input.approvalScope },
      );
    }

    // 3. Freeze-trigger interface cell (Packet 2): the DELIVERY stamp will
    // synchronously invoke the ONE compose-and-freeze endpoint AFTER this
    // point. The endpoint does not exist at P1; when it lands, a failed
    // render never un-approves and never half-stamps — the stamp + audit
    // row above stand regardless of the render outcome.

    return {
      scopeTier: input.scopeTier,
      scopeId,
      scopePath: scopePathCanonical,
      approvalScope: input.approvalScope,
      approvedBy: input.actorSession,
      approvedAt,
      onBehalfOf: input.onBehalfOf ?? null,
      actionId,
      freezeFired: false,
    };
  }
}

// ——— frontmatter helpers (daemon-side mirror of the CLI scope-fs shape:
// hand-rolled split + YAML.parse, safe-by-default per PRD §4 leg 2) ———

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1]!) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Reads the slice IMPLEMENTATION-PRD.md; returns null on ANY missing/unreadable
 *  error (never throws) — the plan-lock derivation fails open to a PRD-only set. */
function tryReadPRD(sliceDir: string): string | null {
  try {
    return fs.readFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "utf8");
  } catch {
    return null;
  }
}

function writeFrontmatterFields(content: string, fields: Record<string, unknown>): string {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (match) {
    const existing = parseFrontmatter(content);
    const merged = { ...existing, ...fields };
    const yaml = YAML.stringify(merged).trimEnd();
    return content.replace(/^---\s*\n[\s\S]*?\n---/, `---\n${yaml}\n---`);
  }
  const yaml = YAML.stringify(fields).trimEnd();
  return `---\n${yaml}\n---\n\n${content}`;
}
