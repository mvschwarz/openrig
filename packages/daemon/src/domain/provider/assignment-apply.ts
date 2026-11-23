import { shellArg } from "../../adapters/shell-quote.js";
import type { AccountRef, AccountRefProvider } from "./provider-account-refs.js";
import type { AppliedReference, AssignmentResultKind } from "./provider-account-assignments.js";
import { asAppliedText, type AssignmentPlan, type PlanRow } from "./assignment-plan.js";
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
  /** Codex seats in other rigs on a home this apply switched: reported, not restarted. `command` restarts one by name; it's
   *  left out, with `why`, when that name reaches more than one seat. */
  otherRigPeers: Array<{ seat: string; rig: string; home: string; command?: string; why?: string }>;
}

export interface ApplyDeps {
  switchSeat(seat: string): Promise<ProviderSwitchResult>;
  restartPeer(seat: string, reason: string): Promise<PeerRestartResult>;
  successor?(seat: string, accountHome: string): Promise<SuccessorResult>;
  /** The seat's activity now, read as it's reached. */
  activityOf(seat: string): string;
  /** The switches this daemon has made of a Codex home: how many, and the seat that made the last. A peer restarted on a
   *  home some other switch changed after this apply's isn't recorded as on the account. Without it, nothing is checked. */
  homeSwitches?(home: string): { count: number; seat: string } | null;
  /** Saves each result as it lands, with the reference a switched or pending-successor seat was given. */
  save(result: ApplySeatResult, applied: AppliedReference | undefined): void;
  now(): string;
}

const restartCommand = (seat: string) => `rig seat restart ${shellArg(seat)} --keep-conversation`;

/** Why no restart command is given for a seat whose session name another seat has. */
const NO_NAME = "It has no restart command: a restart reaches a seat by its session name, and another seat has this one";

export async function applyAssignment(plan: AssignmentPlan, account: AccountRef, deps: ApplyDeps): Promise<AssignmentApplyReport> {
  const results: ApplySeatResult[] = [];
  const reason = `rig provider assign ${plan.rig} --provider ${plan.provider} --account ${plan.account.label}`;
  // The account's own reference: its token or API-key file, or its saved login in the home it's saved in.
  const own: AppliedReference = account.provider === "claude"
    ? { file: account.file, fileKind: account.kind === "claude_api_key_file" ? "api-key" : "token", codexHome: null, codexLogin: null }
    : { file: null, fileKind: null, codexHome: account.codexHome, codexLogin: account.login };
  // What a switch or a move gives a seat: the account's reference, or the prepared home it moves to, on that home's login.
  const applied: AppliedReference = account.provider === "codex" && plan.accountHome
    ? { file: null, fileKind: null, codexHome: plan.accountHome, codexLogin: null } : own;
  // A seat refused because its session name doesn't reach it alone, or one sharing its name with another seat on a home:
  // a restart by that name could reach the other seat, so no command is given for it.
  // A switch or move refused for it when it runs adds it too.
  const unnamed = new Set([...plan.rows.filter((r) => r.precheck?.reasons.includes("seat_name_shared")).map((r) => r.seat),
    ...plan.codexHomes.flatMap((g) => g.seats.filter((s) => s.sharedName).map((s) => s.seat))]);
  const refusedByName = (row: PlanRow, r: ProviderSwitchResult | SuccessorResult) => {
    if ("outcome" in r ? (r.outcome === "failed_safely" || r.outcome === "unknown") && r.reasons.includes("seat_name_shared") : !r.ok && r.code === "seat_name_shared") unnamed.add(row.seat);
  };
  const recoveryOf = (seat: string) => (unnamed.has(seat) ? undefined : restartCommand(seat));
  const record = (row: PlanRow, kind: AssignmentResultKind, detail: string, recovery?: string, activity = row.activity as string) => {
    if (kind === "unknown" && unnamed.has(row.seat)) detail = `${detail.replace(/\.$/, "")}. ${NO_NAME}.`;
    const result: ApplySeatResult = { seat: row.seat, kind, detail, ...(recovery ? { recovery } : {}), activity, at: deps.now() };
    // A seat whose own switch failed before effect is recorded again, as unknown, once another seat changes its home:
    // the later result, which names the earlier failure, replaces it in the report.
    const earlier = results.findIndex((r) => r.seat === row.seat);
    if (earlier >= 0) results.splice(earlier, 1);
    results.push(result);
    // A seat the person brought in with --include-overrides that's already on the account records it too, as a switch
    // would: it follows the rig's assignment from now on, rather than reading as its own choice again at the next one. It
    // wasn't moved, so it records the reference it has: configured on the account, the account's own, whatever prepared
    // home this plan names; still as an earlier apply left its home, nothing new, so that apply's record stands.
    const reference = kind === "switched" || kind === "pending_successor" ? applied
      : kind === "unchanged" && row.effect === "unchanged" && plan.includeOverrides && !row.asApplied ? own : undefined;
    deps.save(result, reference);
  };
  const notAttempted = (row: PlanRow) => `not attempted: its precheck was unsafe (${row.precheck!.reasons.join(", ")})`
    + (row.precheck!.message ? `: ${row.precheck!.message}` : "");
  const unsafe = (row: PlanRow) => row.precheck !== undefined && !row.precheck.safe;

  // Codex in place: the rig's seats on each switching home, in plan order.
  const onHome = new Map<string, string>();
  for (const group of plan.codexHomes) for (const s of group.seats) if (s.rigId === plan.rigId) onHome.set(s.seat, group.home);
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
    if (row.effect === "unchanged") { record(row, "unchanged", row.asApplied ? asAppliedText(plan.account.label) : `already on ${plan.account.label}`); continue; }
    if (row.effect === "kept_override") { record(row, "unchanged", `kept (seat override): ${row.override}`); continue; }
    if (row.continuity?.startsWith("unsupported")) { record(row, "unsupported", row.continuity); continue; }
    if (unsafe(row)) { record(row, "failed_before_effect", notAttempted(row)); continue; }
    const activity = deps.activityOf(row.seat);
    if (plan.provider === "codex" && plan.accountHome) {
      if (!deps.successor) { record(row, "failed_before_effect", "not attempted: the move to a prepared home isn't available here", undefined, activity); continue; }
      const moved = await deps.successor(row.seat, plan.accountHome);
      refusedByName(row, moved);
      const [kind, detail, recovery] = successorKind(row.seat, moved);
      // The successor uses whatever login is active in the prepared home: the result names the account the person chose, not
      // a login it checked.
      record(row, kind, kind === "pending_successor" || kind === "unchanged"
        ? `${detail}; not checked: whether ${plan.accountHome} is signed in as ${plan.account.label}` : detail, recovery, activity);
      continue;
    }
    const switched = await deps.switchSeat(row.seat);
    refusedByName(row, switched);
    const [kind, detail, recovery] = switchKind(row.seat, switched);
    record(row, kind, detail, recovery, activity);
  }

  /** One switch per home: the first seat that can switches it, and this rig's other seats on it restart on its new login.
   *  A seat that isn't safe to restart, or whose own switch was just refused, is never restarted: once its home changed
   *  under it, it's unknown, with its restart command. After an unknown on the home, its other seats are skipped. */
  async function applyHome(home: string, rows: PlanRow[]): Promise<void> {
    let state: "untouched" | "switched" | "unknown" = "untouched";
    let switcher = "";
    /** The home's switch count as this apply's switch left it; null when it isn't known. */
    let mine: number | null = null;
    /** The seat whose switch changed the home after this apply's, or null. */
    const switchedSince = (): string | null => {
      if (!deps.homeSwitches) return null;
      const now = deps.homeSwitches(home);
      return now && now.count !== mine ? now.seat : null;
    };
    /** Seats whose own switch failed before effect, with why: kept as they are, whatever the home does next. */
    const refused = new Map<string, string>();
    const waiting: PlanRow[] = [];
    const skipped = (row: PlanRow) => record(row, "unknown", `skipped: home outcome unknown (${switcher} left ${home} in an unknown state)`, recoveryOf(row.seat));
    const notRestarted = (row: PlanRow, why: string) => record(row, "unknown",
      `${home} now uses "${plan.account.label}" (switched by ${switcher}), and this seat wasn't restarted: ${why}`, recoveryOf(row.seat));
    const onSwitchedHome = async (row: PlanRow) => {
      if (unsafe(row)) notRestarted(row, notAttempted(row).replace(/^not attempted: /, ""));
      else await restartOnHome(row, home, switcher, switchedSince);
    };
    for (const row of rows) {
      if (state === "unknown") { skipped(row); continue; }
      if (state === "switched") { await onSwitchedHome(row); continue; }
      // The home is untouched: a seat that would change and is safe switches it; any other waits until it's known.
      if (row.effect !== "change" || unsafe(row)) { waiting.push(row); continue; }
      const activity = deps.activityOf(row.seat);
      const result = await deps.switchSeat(row.seat);
      refusedByName(row, result);
      const [kind, detail, recovery] = switchKind(row.seat, result);
      record(row, kind, detail, recovery, activity);
      if (kind === "switched") {
        state = "switched"; switcher = row.seat;
        const after = deps.homeSwitches?.(home);
        // The last switch of the home is this one: its count is the one peers must restart under.
        mine = after && after.seat === row.seat ? after.count : -1;
      }
      else if (kind === "unknown") { state = "unknown"; switcher = row.seat; }
      // Failed before effect: the home is as it was, and the next seat that can switches it. This seat isn't tried again.
      else refused.set(row.seat, detail);
    }
    for (const row of waiting) {
      if (state === "unknown") skipped(row);
      else if (state === "switched") await onSwitchedHome(row);
      else if (row.effect === "unchanged") record(row, "unchanged", `${row.asApplied ? asAppliedText(plan.account.label) : `already on ${plan.account.label}`}; its home wasn't switched`);
      else if (row.effect === "kept_override") record(row, "unchanged", `kept (seat override): ${row.override}`);
      else record(row, "failed_before_effect", unsafe(row) ? notAttempted(row) : `not attempted: ${home} wasn't switched`);
    }
    // A seat whose own switch was refused keeps that result unless its home's login then changed under it.
    for (const [seat, why] of refused) {
      const row = rows.find((r) => r.seat === seat)!;
      if (state === "switched") notRestarted(row, `its own switch failed before effect (${why})`);
      else if (state === "unknown") record(row, "unknown", `its own switch failed before effect (${why}), then ${switcher} left ${home} in an unknown state`, recoveryOf(seat));
    }
  }

  async function restartOnHome(row: PlanRow, home: string, switcher: string, switchedSince: () => string | null): Promise<void> {
    const activity = deps.activityOf(row.seat);
    // Another switch of this home (another rig's apply, or rig provider switch) after this apply's: its login is that one's now.
    const before = switchedSince();
    if (before) {
      record(row, "unknown", `${home} was switched again by ${before} after ${switcher} switched it to "${plan.account.label}", so this seat wasn't restarted`,
        recoveryOf(row.seat), activity);
      return;
    }
    const restarted = await deps.restartPeer(row.seat, reason);
    const during = switchedSince();
    if (restarted.ok && during) {
      record(row, "unknown", `restarted in place on ${home}, but ${during} switched it again meanwhile: it may be on that login, not "${plan.account.label}"`,
        recoveryOf(row.seat), activity);
    } else if (restarted.ok && restarted.outcome === "restarted_account_unverified") {
      record(row, "switched", `restarted in place on ${home}, which ${switcher} switched to "${plan.account.label}"; the account isn't verified until a tool turn`, undefined, activity);
    } else if (restarted.ok) {
      record(row, "unknown", `${home} now uses "${plan.account.label}"; the restart didn't confirm (${restarted.outcome ?? "no outcome"}: ${restarted.message}). Not retried.`,
        restarted.recoveryCommand ?? restarted.remainingStep ?? recoveryOf(row.seat), activity);
    } else {
      record(row, "unknown", `${home} now uses "${plan.account.label}", but this seat wasn't restarted (${restarted.code}: ${restarted.message})`,
        restarted.code === "seat_name_shared" ? undefined : recoveryOf(row.seat), activity);
    }
  }

  const otherRigPeers = plan.codexHomes.flatMap((group) => {
    const switched = results.some((r) => onHome.get(r.seat) === group.home && (r.kind === "switched" || r.kind === "unknown"));
    return switched ? group.seats.filter((s) => s.rigId !== plan.rigId).map((s) => ({ seat: s.seat, rig: s.rig, home: group.home,
      ...(unnamed.has(s.seat) ? { why: NO_NAME } : { command: restartCommand(s.seat) }) })) : [];
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
      // A seat its name no longer reaches gets no command by that name.
      if (r.reasons.includes("seat_name_shared")) return ["unknown", `${r.reasons.join(", ")}: ${message}`, undefined];
      return ["unknown", `${r.reasons.join(", ")}: ${message}`,
        r.seat?.restart?.recoveryCommand ?? r.seat?.restart?.remainingStep ?? (r.seat?.home ? restartCommand(seat) : undefined)];
  }
}

/** A move to a prepared home, as one of the six kinds. */
export function successorKind(seat: string, r: SuccessorResult): [AssignmentResultKind, string, string | undefined] {
  const recover = `rig seat set-runtime ${shellArg(seat)} --recover`;
  if (r.ok) {
    if (!r.changed) return ["unchanged", "already on the prepared home", undefined];
    if (r.recoveryPending) return ["unknown", "the successor took the seat, but finishing the switch needs recovery", recover];
    return ["pending_successor", `a fresh successor took the seat with a handover${r.confirmation ? `: "${r.confirmation.note}"` : ""}`, undefined];
  }
  if (r.recoveryPending) return ["unknown", `${r.code}: ${r.message}`, r.guidance ?? recover];
  return ["failed_before_effect", `${r.code}: ${r.message}`, undefined];
}
