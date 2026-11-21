import { createHash } from "node:crypto";
import type { ClaudeSeatTokenRef } from "../claude-seat-token.js";
import type { AssignmentIntent, AssignmentResultKind } from "./provider-account-assignments.js";
import type { AccountRef, AccountRefProvider } from "./provider-account-refs.js";
import type { SeatAccountConfiguration } from "./provider-types.js";

// #3625 slice 2: the plan for moving one rig's seats of one provider to an account this daemon knows by label. Computed
// from what the daemon already has: each seat's configured account and its own choices, the per-seat precheck (read
// only), the seat's activity, and the Codex home each Codex seat runs on. It changes nothing. Slice 3: it carries a digest
// of what it would do, which an apply must name, and shows the rig's stored assignment and each seat's last result.

/** What the daemon knows about one seat, on any rig (other rigs matter for Codex seats sharing a home). */
export interface PlanSeatFacts {
  session: string;
  rigName: string;
  runtime: string;
  /** The seat's configured account (`configuredSeatAccounts`): what its next launch uses, not proof of its login. */
  configured: SeatAccountConfiguration | null;
  /** A Claude seat's own token or API-key reference (`nodes.claude_token_ref`). */
  claudeRef: ClaudeSeatTokenRef | null;
  /** The seat's own runtime home: from its member env, its rig's env, or an account-home switch. */
  ownHome: { home: string; source: "member" | "rig" | "account-switch" } | null;
  /** A Codex seat's CODEX_HOME: its own, else the daemon's. Null for other runtimes. */
  codexHome: string | null;
  /** A Claude seat's process is running (it switches in place) or stopped (its next launch picks the account up). */
  running: boolean | null;
  activity: "running" | "needs_input" | "idle" | "unknown";
  /** The seat's configuration is still what an earlier apply gave it: it follows an assignment, so it isn't an override. */
  followsAssignment?: boolean;
  /** The seat's latest applied result. */
  lastResult?: { kind: AssignmentResultKind; label: string; detail: string; at: string } | null;
}

export interface AssignmentPlanInput {
  /** Where the plan applies: this daemon's host id. */
  daemon: string;
  rig: string;
  account: AccountRef;
  seats: PlanSeatFacts[];
  includeOverrides: boolean;
  /** A prepared home the person named: Codex seats move to it as fresh successors with a handover. */
  accountHome?: string;
  platform: NodeJS.Platform;
  /** How two homes are compared: resolved, so a trailing slash or a link to the same directory is the same home. */
  resolveHome?: (home: string) => string;
  /** The rig's stored assignment for this provider, if an apply has started one. */
  intent?: AssignmentIntent | null;
}

/** A seat's check before it changes: the existing per-seat precheck, or, for a fresh successor, the account-home dry run. */
export type PlanCheck = { safe: true } | { safe: false; reasons: string[]; message?: string };

export type PlanEffect = "change" | "unchanged" | "kept_override" | "not_affected";

export interface PlanRow {
  seat: string;
  runtime: string;
  /** The seat's configured account in words. */
  current: string;
  effect: PlanEffect;
  /** The seat's own choice for another account: shown, and kept unless --include-overrides. */
  override?: string;
  precheck?: { safe: boolean; reasons: string[]; message?: string };
  continuity?: string;
  activity: PlanSeatFacts["activity"];
  notes?: string[];
  /** The seat's latest applied result, from any earlier apply. */
  lastResult?: { kind: AssignmentResultKind; label: string; detail: string; at: string };
  /** Unchanged only as an apply of this label left its home: its configuration names no login, and the login active in
   *  that home isn't read, so a later change there isn't seen. */
  asApplied?: true;
}

export interface PlanHomePeer {
  seat: string;
  rig: string;
  effect: string;
}

export interface AssignmentPlan {
  daemon: string;
  rig: string;
  provider: AccountRefProvider;
  account: { label: string; kind: AccountRef["kind"]; reference: string };
  includeOverrides: boolean;
  accountHome?: string;
  rows: PlanRow[];
  /** Codex: one switch per home, with every seat on it, in this rig or not. */
  codexHomes: Array<{ home: string; seats: PlanHomePeer[] }>;
  /** The rig's stored assignment for this provider. */
  intent?: { label: string; reference: string; requestedBy: string | null; at: string };
  /** What the plan would do, hashed: `--apply --plan <digest>` acts only while it's the same. */
  digest: string;
  note: string;
}

const RUNTIME_OF: Record<AccountRefProvider, string> = { claude: "claude-code", codex: "codex" };
const NOTHING_CHANGED = "A plan only: nothing was changed. Apply exactly this plan with --apply --plan <digest>.";

/** The digest of what a plan would do. Left out, because they move on their own: each seat's activity, the notes (which
 *  carry the busy note), precheck messages, the last results and the stored assignment. */
export function planDigest(plan: Omit<AssignmentPlan, "digest">): string {
  const material = {
    daemon: plan.daemon, rig: plan.rig, provider: plan.provider, account: plan.account, includeOverrides: plan.includeOverrides,
    accountHome: plan.accountHome ?? null,
    rows: plan.rows.map((r) => [r.seat, r.runtime, r.current, r.effect, r.override ?? null,
      r.precheck ? [r.precheck.safe, [...r.precheck.reasons].sort()] : null, r.continuity ?? null]),
    codexHomes: plan.codexHomes.map((h) => [h.home, h.seats.map((s) => [s.seat, s.rig, s.effect])]),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12);
}

export function describeAccountRef(account: AccountRef): string {
  return account.kind === "codex_saved_login" ? `the login ${account.login} saved in ${account.codexHome}`
    : `the ${account.kind === "claude_api_key_file" ? "API-key" : "token"} file ${account.file}`;
}

function describeConfigured(c: SeatAccountConfiguration | null): string {
  if (!c) return "unknown";
  switch (c.source) {
    case "claude_token": return `${c.kind === "api-key" ? "API key" : "token"} "${c.label}"`;
    case "registry": return `saved login ${c.profileRef} (seat registry)`;
    case "default_login": return c.home ? `the login in ${c.home}` : "the default login";
    case "unknown": return `unknown (${c.reason})`;
  }
}

/** What comparing a seat with an account needs: the account, and how homes are compared. */
type Comparison = Pick<AssignmentPlanInput, "account" | "resolveHome">;

const sameHome = (input: Comparison, a: string | null, b: string | null): boolean =>
  a !== null && b !== null && (a === b || (input.resolveHome ? input.resolveHome(a) === input.resolveHome(b) : false));

/** The seat's own choice for another account, or null when it has none (or its choice is the target). */
function seatOverride(seat: PlanSeatFacts, input: Comparison): string | null {
  const { account } = input;
  if (seat.followsAssignment) return null;
  // A Claude seat's own token or API-key reference is what its launch uses, ahead of the login stored in its config dir:
  // when it has one, that's its choice, and its home is named only when it has none.
  if (account.provider === "claude" && seat.claudeRef) {
    return sameClaudeRef(seat.claudeRef, account) ? null
      : `its own ${seat.claudeRef.kind === "api-key" ? "API-key" : "token"} file ${seat.claudeRef.tokenFile} ("${seat.claudeRef.label}")`;
  }
  if (seat.ownHome && seat.ownHome.source !== "rig" && !sameHome(input, seat.ownHome.home, account.codexHome)) {
    return seat.ownHome.source === "account-switch" ? `its account home ${seat.ownHome.home}` : `its own home ${seat.ownHome.home} (member env)`;
  }
  if (account.provider === "codex" && seat.configured?.source === "registry" && seat.configured.profileRef !== account.login) {
    return `the saved login ${seat.configured.profileRef} (seat registry)`;
  }
  return null;
}

function sameClaudeRef(ref: ClaudeSeatTokenRef, account: AccountRef): boolean {
  return ref.tokenFile === account.file && (ref.kind === "api-key") === (account.kind === "claude_api_key_file");
}

function unchanged(seat: PlanSeatFacts, input: Comparison): boolean {
  const { account } = input;
  if (account.provider === "claude") return seat.claudeRef !== null && sameClaudeRef(seat.claudeRef, account);
  return seat.configured?.source === "registry" && seat.configured.profileRef === account.login && sameHome(input, seat.codexHome, account.codexHome);
}

/** The seat's configuration is still what an apply of this label gave it: its last result moved it there. */
function appliedThis(seat: PlanSeatFacts, label: string): boolean {
  const last = seat.lastResult;
  return !!seat.followsAssignment && last?.label === label && (last.kind === "switched" || last.kind === "pending_successor");
}

/** A seat whose configuration names no login of its own: a Codex seat on its home's active login (not a home an account
 *  switch moved it to). That it's on an account rests only on the apply that switched its home. */
function homeOnly(seat: PlanSeatFacts): boolean {
  return seat.runtime === "codex" && seat.configured?.source === "default_login" && seat.configured.homeFrom !== "account-switch";
}

/** How a seat that's unchanged only as an apply left its home is worded, in the plan, the apply and status. */
export const asAppliedText = (label: string) => `still as the apply of ${label} left its home`;

/** Where a seat stands against its rig's assignment, by the plan's own rules: on the assigned account (configured as it, or
 *  still as the apply of this assignment left it), its own choice of another account, or not moved yet (no result, or its
 *  last result didn't move it). Configuration only: never proof of the login a running session uses. */
export function assignmentStanding(seat: PlanSeatFacts, account: AccountRef | null, intent: AssignmentIntent,
  resolveHome?: (home: string) => string): { state: "follows" | "override" | "not_applied"; override?: string; asApplied?: true } {
  if (!account) return { state: "not_applied" };
  const comparison: Comparison = { account, ...(resolveHome ? { resolveHome } : {}) };
  if (unchanged(seat, comparison)) return { state: "follows" };
  if (appliedThis(seat, intent.label)) return { state: "follows", ...(homeOnly(seat) ? { asApplied: true as const } : {}) };
  const override = seatOverride(seat, comparison);
  return override ? { state: "override", override } : { state: "not_applied" };
}

/** A Codex seat switches in place only on Linux, on the home the account's login is saved in, and not when it moves to a
 *  named account home instead. */
function codexInPlace(seat: PlanSeatFacts, input: AssignmentPlanInput): boolean {
  return !input.accountHome && input.platform === "linux" && sameHome(input, seat.codexHome, input.account.codexHome);
}

function continuity(seat: PlanSeatFacts, input: AssignmentPlanInput, check: PlanCheck): string {
  const { account } = input;
  if (account.provider === "claude") {
    if (!check.safe && check.reasons.includes("conversation_not_resumable")) {
      return "not resumable: the precheck found no conversation the seat's next launch would resume";
    }
    if (seat.running === null) return "unknown: the daemon can't tell whether the seat is running, so whether it keeps its conversation in place or at its next launch";
    return seat.running ? "in place: the seat is relaunched in its own pane and keeps its conversation"
      : "next launch: the reference is saved now, and the seat's next launch resumes its conversation on it";
  }
  if (input.accountHome) return `fresh successor with handover, on ${input.accountHome}`;
  if (!sameHome(input, seat.codexHome, account.codexHome)) return `unsupported in place: the seat runs on ${seat.codexHome}, and this login is saved in ${account.codexHome}`;
  if (input.platform !== "linux") return "unsupported in place: a Codex seat switches in place only on Linux (name a prepared home with --account-home for a fresh successor)";
  return "in place: the seat restarts on the same conversation";
}

/** The plan. `check` is the seat's check before it changes, read only; it runs only for seats the plan would change. */
export async function planAssignment(input: AssignmentPlanInput, check: (seat: PlanSeatFacts) => Promise<PlanCheck>): Promise<AssignmentPlan> {
  const { account } = input;
  const runtime = RUNTIME_OF[account.provider];
  const inRig = input.seats.filter((s) => s.rigName === input.rig);

  // First what each seat would do, then which Codex homes switch in place: a seat on a switching home moves with it,
  // whatever its own choice, because the switch changes that home's active login.
  type Decision = { seat: PlanSeatFacts; effect: PlanEffect; override?: string; notes?: string[]; asApplied?: true };
  const decisions: Decision[] = inRig.map((seat) => {
    if (seat.runtime !== runtime) {
      return { seat, effect: "not_affected", notes: [seat.runtime === RUNTIME_OF[account.provider === "claude" ? "codex" : "claude"]
        ? `a ${seat.runtime} seat: a ${account.provider} assignment doesn't touch it` : `a ${seat.runtime} seat has no ${account.provider} account`] };
    }
    if (unchanged(seat, input)) return { seat, effect: "unchanged" };
    // Still as an apply of this label left it: nothing to do, so a re-apply doesn't restart it (or its Codex home) again.
    // With --account-home, only when that's the home it was moved to.
    if (appliedThis(seat, account.label) && (!input.accountHome
      || (seat.ownHome?.source === "account-switch" && sameHome(input, seat.ownHome.home, input.accountHome)))) {
      return { seat, effect: "unchanged", ...(homeOnly(seat) ? { asApplied: true as const } : {}) };
    }
    const override = seatOverride(seat, input) ?? undefined;
    if (override && !input.includeOverrides) return { seat, effect: "kept_override", override, notes: ["kept (seat override); --include-overrides moves it too"] };
    return { seat, effect: "change", ...(override ? { override } : {}) };
  });
  const switching = account.provider === "codex"
    ? decisions.filter((d) => d.effect === "change" && codexInPlace(d.seat, input)).map((d) => d.seat.codexHome!) : [];
  const onSwitching = (seat: PlanSeatFacts) => seat.runtime === "codex" && switching.some((home) => sameHome(input, home, seat.codexHome));
  for (const d of decisions) {
    if (!onSwitching(d.seat)) continue;
    const moves = `moves with its home: the switch makes ${account.login} the active login of ${d.seat.codexHome}, which this seat runs on`;
    if (d.effect === "kept_override") { d.effect = "change"; d.notes = [`${moves}, so its own choice can't be kept`]; }
    else if (d.effect === "unchanged") d.notes = [`${d.asApplied ? asAppliedText(account.label) : `already on ${account.label}`}; ${moves}, so it restarts with it`];
  }

  const rows: PlanRow[] = [];
  for (const d of decisions) {
    const { seat } = d;
    const base = { seat: seat.session, runtime: seat.runtime, current: describeConfigured(seat.configured), activity: seat.activity,
      ...(seat.lastResult ? { lastResult: seat.lastResult } : {}) };
    if (d.effect !== "change") {
      rows.push({ ...base, effect: d.effect, ...(d.override ? { override: d.override } : {}), ...(d.notes ? { notes: d.notes } : {}),
        ...(d.asApplied ? { asApplied: true as const } : {}) });
      continue;
    }
    const verdict = await check(seat);
    const notes = [...(d.notes ?? []), ...(seat.activity === "running" || seat.activity === "needs_input"
      ? [`busy (${seat.activity === "running" ? "working" : "waiting for input"}): a switch interrupts work in flight`] : [])];
    if (input.accountHome && account.provider === "codex") {
      notes.push(`not checked: whether ${input.accountHome} is signed in as ${account.label}; the successor uses the login active in that home`);
    }
    rows.push({
      ...base, effect: "change", ...(d.override ? { override: d.override } : {}),
      precheck: verdict.safe ? { safe: true, reasons: [] } : { safe: false, reasons: verdict.reasons, ...(verdict.message ? { message: verdict.message } : {}) },
      continuity: continuity(seat, input, verdict),
      ...(notes.length ? { notes } : {}),
    });
  }

  // Codex: one in-place switch per home, listing every seat on it, in this rig or not.
  const codexHomes: AssignmentPlan["codexHomes"] = [];
  const keys = new Map<string, string>();
  for (const home of switching) { const key = input.resolveHome?.(home) ?? home; if (!keys.has(key)) keys.set(key, home); }
  for (const [key, home] of [...keys].sort(([a], [b]) => a.localeCompare(b))) {
    codexHomes.push({ home, seats: input.seats.filter((s) => s.runtime === "codex" && s.codexHome !== null && (input.resolveHome?.(s.codexHome) ?? s.codexHome) === key)
      .map((s) => ({ seat: s.session, rig: s.rigName,
        effect: s.rigName === input.rig ? "would restart" : `not restarted; needs rig seat restart ${s.session}` })) });
  }

  const plan: Omit<AssignmentPlan, "digest"> = {
    daemon: input.daemon, rig: input.rig, provider: account.provider,
    account: { label: account.label, kind: account.kind, reference: describeAccountRef(account) },
    includeOverrides: input.includeOverrides, ...(input.accountHome ? { accountHome: input.accountHome } : {}),
    rows, codexHomes,
    ...(input.intent ? { intent: { label: input.intent.label, reference: input.intent.reference, requestedBy: input.intent.requestedBy, at: input.intent.at } } : {}),
    note: NOTHING_CHANGED,
  };
  return { ...plan, digest: planDigest(plan) };
}
