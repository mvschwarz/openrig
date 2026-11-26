import type Database from "better-sqlite3";
import type { AccountRefKind, AccountRefProvider } from "./provider-account-refs.js";

// #3625 slice 3: a rig's account assignment per provider, and each seat's latest applied result, on the daemon that runs
// the rig. References only, never credential bytes.

export const RESULT_KINDS = ["unchanged", "switched", "pending_successor", "unsupported", "failed_before_effect", "unknown"] as const;
export type AssignmentResultKind = (typeof RESULT_KINDS)[number];

export interface AssignmentIntent {
  rigId: string;
  provider: AccountRefProvider;
  label: string;
  /** The reference in words, as the plan showed it. */
  reference: string;
  requestedBy: string | null;
  at: string;
}

/** What an apply gave the seat: kept from its last switched or pending-successor result, so a later failure doesn't erase
 *  it. A seat whose configuration still matches it follows an assignment; it isn't a seat override. */
/** An account's reference as an apply used it, so a label later pointed elsewhere isn't taken for it. */
export interface AppliedAccount {
  kind: AccountRefKind;
  file: string | null;
  codexHome: string | null;
  login: string | null;
}

export interface AppliedReference {
  /** The label of the account it came from, as that apply named it (read back; the apply's own label when saved). */
  label?: string | null;
  /** That account's reference when the apply used it; null when it isn't known (an older result). */
  account?: AppliedAccount | null;
  file: string | null;
  fileKind: "token" | "api-key" | null;
  codexHome: string | null;
  codexLogin: string | null;
}

export interface AssignmentResult {
  rigId: string;
  provider: AccountRefProvider;
  nodeId: string;
  seat: string;
  label: string;
  kind: AssignmentResultKind;
  detail: string;
  recovery: string | null;
  /** The seat's activity when it was switched: a working seat loses commands it ran in the background. */
  activity: string;
  at: string;
  applied: AppliedReference | null;
}

type ResultRow = { rig_id: string; provider: AccountRefProvider; node_id: string; seat: string; label: string; kind: AssignmentResultKind;
  detail: string; recovery: string | null; activity: string; ref_file: string | null; ref_kind: "token" | "api-key" | null;
  codex_home: string | null; codex_login: string | null; applied_label: string | null; applied_account: string | null; applied_at: string };

function appliedAccountOf(json: string | null): AppliedAccount | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as Partial<AppliedAccount>;
    const text = (x: unknown) => (typeof x === "string" ? x : null);
    return typeof v.kind === "string" ? { kind: v.kind as AccountRefKind, file: text(v.file), codexHome: text(v.codexHome), login: text(v.login) } : null;
  } catch { return null; }
}

function fromRow(r: ResultRow): AssignmentResult {
  const applied = r.ref_file !== null || r.codex_home !== null || r.codex_login !== null
    ? { label: r.applied_label, account: appliedAccountOf(r.applied_account), file: r.ref_file, fileKind: r.ref_kind, codexHome: r.codex_home, codexLogin: r.codex_login } : null;
  return { rigId: r.rig_id, provider: r.provider, nodeId: r.node_id, seat: r.seat, label: r.label, kind: r.kind, detail: r.detail,
    recovery: r.recovery, activity: r.activity, at: r.applied_at, applied };
}

export class ProviderAccountAssignmentsRepository {
  constructor(private readonly db: Database.Database) {}

  intent(rigId: string, provider: AccountRefProvider): AssignmentIntent | null {
    const r = this.db.prepare("SELECT * FROM provider_account_assignments WHERE rig_id = ? AND provider = ?").get(rigId, provider) as
      { rig_id: string; provider: AccountRefProvider; label: string; reference: string; requested_by: string | null; created_at: string } | undefined;
    return r ? { rigId: r.rig_id, provider: r.provider, label: r.label, reference: r.reference, requestedBy: r.requested_by, at: r.created_at } : null;
  }

  setIntent(intent: AssignmentIntent): void {
    this.db.prepare(`INSERT INTO provider_account_assignments (rig_id, provider, label, reference, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (rig_id, provider) DO UPDATE SET label = excluded.label, reference = excluded.reference,
        requested_by = excluded.requested_by, created_at = excluded.created_at`)
      .run(intent.rigId, intent.provider, intent.label, intent.reference, intent.requestedBy, intent.at);
  }

  results(rigId: string, provider: AccountRefProvider): AssignmentResult[] {
    return (this.db.prepare("SELECT * FROM provider_assignment_results WHERE rig_id = ? AND provider = ? ORDER BY seat").all(rigId, provider) as ResultRow[]).map(fromRow);
  }

  /** Saves a seat's result as it lands. The applied reference changes only with a switched or pending-successor result. */
  saveResult(result: Omit<AssignmentResult, "applied"> & { applied?: AppliedReference }): void {
    // The apply passes the account a result put the seat on (a switch, or a seat it brought in that was already on it). A
    // result without one keeps the seat's earlier applied account, and the label it came from.
    const a = result.applied;
    const took = a !== undefined;
    this.db.prepare(`INSERT INTO provider_assignment_results (rig_id, provider, node_id, seat, label, kind, detail, recovery, activity,
        ref_file, ref_kind, codex_home, codex_login, applied_label, applied_account, applied_at) VALUES (@rig, @provider, @node, @seat, @label, @kind, @detail, @recovery, @activity,
        @file, @fileKind, @home, @login, @appliedLabel, @appliedAccount, @at)
      ON CONFLICT (rig_id, provider, node_id) DO UPDATE SET seat = excluded.seat, label = excluded.label, kind = excluded.kind,
        detail = excluded.detail, recovery = excluded.recovery, activity = excluded.activity, applied_at = excluded.applied_at,
        ref_file = CASE WHEN @took THEN excluded.ref_file ELSE ref_file END, ref_kind = CASE WHEN @took THEN excluded.ref_kind ELSE ref_kind END,
        codex_home = CASE WHEN @took THEN excluded.codex_home ELSE codex_home END, codex_login = CASE WHEN @took THEN excluded.codex_login ELSE codex_login END,
        applied_label = CASE WHEN @took THEN excluded.applied_label ELSE applied_label END,
        applied_account = CASE WHEN @took THEN excluded.applied_account ELSE applied_account END`)
      .run({ rig: result.rigId, provider: result.provider, node: result.nodeId, seat: result.seat, label: result.label, kind: result.kind,
        detail: result.detail, recovery: result.recovery, activity: result.activity, at: result.at, took: took ? 1 : 0,
        file: a?.file ?? null, fileKind: a?.fileKind ?? null, home: a?.codexHome ?? null, login: a?.codexLogin ?? null, appliedLabel: took ? result.label : null,
        appliedAccount: a?.account ? JSON.stringify({ kind: a.account.kind, file: a.account.file, codexHome: a.account.codexHome, login: a.account.login }) : null });
  }

  /** Every rig's assignment, for status. */
  allIntents(): AssignmentIntent[] {
    return (this.db.prepare("SELECT * FROM provider_account_assignments").all() as Array<{ rig_id: string; provider: AccountRefProvider; label: string;
      reference: string; requested_by: string | null; created_at: string }>)
      .map((r) => ({ rigId: r.rig_id, provider: r.provider, label: r.label, reference: r.reference, requestedBy: r.requested_by, at: r.created_at }));
  }

  /** Every seat's latest result, for status. */
  allResults(): AssignmentResult[] {
    return (this.db.prepare("SELECT * FROM provider_assignment_results").all() as ResultRow[]).map(fromRow);
  }

  /** The rigs whose assignment names this label, named when the label is removed. */
  rigsUsing(provider: AccountRefProvider, label: string): string[] {
    return (this.db.prepare(`SELECT r.name FROM provider_account_assignments a JOIN rigs r ON r.id = a.rig_id
      WHERE a.provider = ? AND a.label = ? ORDER BY r.name`).all(provider, label) as Array<{ name: string }>).map((r) => r.name);
  }
}
