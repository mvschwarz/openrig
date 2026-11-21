import type { AccountRef, AccountRefProvider } from "./provider-account-refs.js";
import type { AppliedReference, AssignmentResultKind } from "./provider-account-assignments.js";
import type { AssignmentPlan, PlanRow } from "./assignment-plan.js";
import type { ProviderSwitchResult } from "./provider-service.js";

// #3625 slice 3: carrying out a plan the person has seen, one seat at a time, through the existing switch only. Each
// seat's result is one of six kinds. A failure on one seat doesn't stop the others; nothing is rolled back or retried.
// A Codex home switches once: the first seat on it switches, this rig's other seats on it restart in place, and seats in
// other rigs are reported with their restart command, never restarted. After an unknown on a home, its other seats are
// skipped.

/** A seat's in-place restart, as `rig seat restart --keep-conversation` reports it (the fields apply reads). */
export type PeerRestartResult =
  | { ok: true; outcome?: string; message: string; recoveryCommand?: string; remainingStep?: string }
  | { ok: false; code: string; message: string };

/** A move to a prepared home, as `rig provider switch --account-home` reports it (the fields apply reads). */
export type SuccessorResult =
  | { ok: true; changed: boolean; recoveryPending?: boolean; confirmation?: { note: string; at: string } }
  | { ok: false; code: string; message: string; guidance?: string; recoveryPending?: boolean };

export interface ApplySeatResult {
  seat: string;
  kind: AssignmentResultKind;
  detail: string;
  recovery?: string;
  /** What the seat was doing when it was switched (or when it was reached). */
  activity: string;
  at: string;
}

export interface AssignmentApplyReport {
  daemon: string;
  rig: string;
  provider: AccountRefProvider;
  account: { label: string; reference: string };
  digest: string;
  results: ApplySeatResult[];
  /** Codex seats in other rigs on a home this apply switched: reported, not restarted. */
  otherRigPeers: Array<{ seat: string; rig: string; home: string; command: string }>;
}

export interface ApplyDeps {
  switchSeat(seat: string): Promise<ProviderSwitchResult>;
  restartPeer(seat: string, reason: string): Promise<PeerRestartResult>;
  successor?(seat: string, accountHome: string): Promise<SuccessorResult>;
  /** The seat's activity now, read as it's reached. */
  activityOf(seat: string): string;
  /** Saves each result as it lands, with the reference a switched or pending-successor seat was given. */
  save(result: ApplySeatResult, applied: AppliedReference | undefined): void;
  now(): string;
}

const restartCommand = (seat: string) => `rig seat restart ${seat} --keep-conversation`;

export async function applyAssignment(plan: AssignmentPlan, account: AccountRef, deps: ApplyDeps): Promise<AssignmentApplyReport> {
  const results: ApplySeatResult[] = [];
  const reason = `rig provider assign ${plan.rig} --provider ${plan.provider} --account ${plan.account.label}`;
  const applied: AppliedReference = account.provider === "claude"
    ? { file: account.file, fileKind: account.kind === "claude_api_key_file" ? "api-key" : "token", codexHome: null, codexLogin: null }
    : plan.accountHome ? { file: null, fileKind: null, codexHome: plan.accountHome, codexLogin: null }
    : { file: null, fileKind: null, codexHome: account.codexHome, codexLogin: account.login };
  const record = (row: PlanRow, kind: AssignmentResultKind, detail: string, recovery?: string, activity = row.activity as string) => {
    const result: ApplySeatResult = { seat: row.seat, kind, detail, ...(recovery ? { recovery } : {}), activity, at: deps.now() };
    // A seat whose own switch failed before effect is reached again once another seat switches its home: the later
    // result replaces the earlier one.
    const earlier = results.findIndex((r) => r.seat === row.seat);
    if (earlier >= 0) results.splice(earlier, 1);
    results.push(result);
    deps.save(result, kind === "switched" || kind === "pending_successor" ? applied : undefined);
  };
  const notAttempted = (row: PlanRow) => `not attempted: its precheck was unsafe (${row.precheck!.reasons.join(", ")})`
    + (row.precheck!.message ? `: ${row.precheck!.message}` : "");
  const unsafe = (row: PlanRow) => row.precheck !== undefined && !row.precheck.safe;

  // Codex in place: the rig's seats on each switching home, in plan order.
  const onHome = new Map<string, string>();
  for (const group of plan.codexHomes) for (const s of group.seats) if (s.rig === plan.rig) onHome.set(s.seat, group.home);
  const homeRows = new Map<string, PlanRow[]>();
  for (const row of plan.rows) {
    const home = onHome.get(row.seat);
    if (home !== undefined) homeRows.set(home, [...(homeRows.get(home) ?? []), row]);
  }
  const doneOnHome = new Set<string>();

  for (const row of plan.rows) {
    if (row.effect === "not_affected" || doneOnHome.has(row.seat)) continue;
    const home = onHome.get(row.seat);
    if (home !== undefined) {
      await applyHome(home, homeRows.get(home)!);
      for (const r of homeRows.get(home)!) doneOnHome.add(r.seat);
      continue;
    }
    if (row.effect === "unchanged") { record(row, "unchanged", `already on ${plan.account.label}`); continue; }
    if (row.effect === "kept_override") { record(row, "unchanged", `kept (seat override): ${row.override}`); continue; }
    if (row.continuity?.startsWith("unsupported")) { record(row, "unsupported", row.continuity); continue; }
    if (unsafe(row)) { record(row, "failed_before_effect", notAttempted(row)); continue; }
    const activity = deps.activityOf(row.seat);
    if (plan.provider === "codex" && plan.accountHome) {
      if (!deps.successor) { record(row, "failed_before_effect", "not attempted: the move to a prepared home isn't available here", undefined, activity); continue; }
      const moved = await deps.successor(row.seat, plan.accountHome);
      const [kind, detail, recovery] = successorKind(row.seat, moved);
      record(row, kind, detail, recovery, activity);
      continue;
    }
    const switched = await deps.switchSeat(row.seat);
    const [kind, detail, recovery] = switchKind(row.seat, switched);
    record(row, kind, detail, recovery, activity);
  }

  /** One switch per home: the first seat that can switches it; the others restart on it, or are skipped after an unknown. */
  async function applyHome(home: string, rows: PlanRow[]): Promise<void> {
    let state: "untouched" | "switched" | "unknown" = "untouched";
    let switcher = "";
    const waiting: PlanRow[] = [];
    for (const row of rows) {
      if (state === "unknown") { record(row, "unknown", `skipped: home outcome unknown (${switcher} left ${home} in an unknown state)`, restartCommand(row.seat)); continue; }
      if (state === "switched") { await restartOnHome(row, home, switcher); continue; }
      // The home is untouched: a seat that would change and is safe switches it; any other waits until it's known.
      if (row.effect !== "change" || unsafe(row)) { waiting.push(row); continue; }
      const activity = deps.activityOf(row.seat);
      const result = await deps.switchSeat(row.seat);
      const [kind, detail, recovery] = switchKind(row.seat, result);
      record(row, kind, detail, recovery, activity);
      if (kind === "switched") { state = "switched"; switcher = row.seat; }
      else if (kind === "unknown") { state = "unknown"; switcher = row.seat; }
      // Failed before effect: the home is as it was, and the next seat that can switches it. This one waits for the outcome.
      else waiting.push({ ...row, notes: ["failed_before_effect"] });
    }
    for (const row of waiting) {
      const failedEarlier = row.notes?.includes("failed_before_effect") === true;
      if (state === "unknown") {
        record(row, "unknown", `skipped: home outcome unknown (${switcher} left ${home} in an unknown state)`, restartCommand(row.seat));
      } else if (state === "switched") {
        if (unsafe(row)) {
          record(row, "unknown", `${home} now uses "${plan.account.label}", switched by ${switcher}, but this seat wasn't restarted: ${notAttempted(row).replace(/^not attempted: /, "")}`,
            restartCommand(row.seat));
        } else await restartOnHome(row, home, switcher);
      } else if (!failedEarlier) {
        if (row.effect === "unchanged") record(row, "unchanged", `already on ${plan.account.label}; its home wasn't switched`);
        else if (row.effect === "kept_override") record(row, "unchanged", `kept (seat override): ${row.override}`);
        else record(row, "failed_before_effect", unsafe(row) ? notAttempted(row) : `not attempted: ${home} wasn't switched`);
      }
    }
  }

  async function restartOnHome(row: PlanRow, home: string, switcher: string): Promise<void> {
    const activity = deps.activityOf(row.seat);
    const restarted = await deps.restartPeer(row.seat, reason);
    if (restarted.ok && restarted.outcome === "restarted_account_unverified") {
      record(row, "switched", `restarted in place on ${home}, which ${switcher} switched to "${plan.account.label}"; the account isn't verified until a tool turn`, undefined, activity);
    } else if (restarted.ok) {
      record(row, "unknown", `${home} now uses "${plan.account.label}"; the restart didn't confirm (${restarted.outcome ?? "no outcome"}: ${restarted.message}). Not retried.`,
        restarted.recoveryCommand ?? restarted.remainingStep ?? restartCommand(row.seat), activity);
    } else {
      record(row, "unknown", `${home} now uses "${plan.account.label}", but this seat wasn't restarted (${restarted.code}: ${restarted.message})`, restartCommand(row.seat), activity);
    }
  }

  const otherRigPeers = plan.codexHomes.flatMap((group) => {
    const switched = results.some((r) => onHome.get(r.seat) === group.home && (r.kind === "switched" || r.kind === "unknown"));
    return switched ? group.seats.filter((s) => s.rig !== plan.rig).map((s) => ({ seat: s.seat, rig: s.rig, home: group.home, command: restartCommand(s.seat) })) : [];
  });
  return { daemon: plan.daemon, rig: plan.rig, provider: plan.provider, account: { label: plan.account.label, reference: plan.account.reference },
    digest: plan.digest, results, otherRigPeers };
}

/** The existing switch's outcome, as one of the six kinds, with its detail and any recovery command. */
export function switchKind(seat: string, r: ProviderSwitchResult): [AssignmentResultKind, string, string | undefined] {
  const message = r.message ?? "";
  switch (r.outcome) {
    case "succeeded":
    case "rebind_in_progress": {
      const warning = r.seat?.tokenApplied === false ? " The token didn't take effect yet; see the message." : "";
      return ["switched", `${message}${warning}`.trim() || r.outcome, undefined];
    }
    case "failed_safely":
      // The home's login changed and the seat wasn't restarted: that has an effect, so it isn't failed before effect.
      if (r.reasons.includes("login_changed_seat_not_restarted")) {
        return ["unknown", `the home's login changed, and the seat wasn't restarted: ${message}`, restartCommand(seat)];
      }
      return ["failed_before_effect", `${r.reasons.join(", ")}${message ? `: ${message}` : ""}`, undefined];
    case "unknown":
      return ["unknown", `${r.reasons.join(", ")}: ${message}`,
        r.seat?.restart?.recoveryCommand ?? r.seat?.restart?.remainingStep ?? (r.seat?.home ? restartCommand(seat) : undefined)];
  }
}

/** A move to a prepared home, as one of the six kinds. */
export function successorKind(seat: string, r: SuccessorResult): [AssignmentResultKind, string, string | undefined] {
  const recover = `rig seat set-runtime ${seat} --recover`;
  if (r.ok) {
    if (!r.changed) return ["unchanged", "already on the prepared home", undefined];
    if (r.recoveryPending) return ["unknown", "the successor took the seat, but finishing the switch needs recovery", recover];
    return ["pending_successor", `a fresh successor took the seat with a handover${r.confirmation ? `: "${r.confirmation.note}"` : ""}`, undefined];
  }
  if (r.recoveryPending) return ["unknown", `${r.code}: ${r.message}`, r.guidance ?? recover];
  return ["failed_before_effect", `${r.code}: ${r.message}`, undefined];
}
