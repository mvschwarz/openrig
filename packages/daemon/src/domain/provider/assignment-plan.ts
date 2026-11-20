import type { ClaudeSeatTokenRef } from "../claude-seat-token.js";
import type { AccountRef, AccountRefProvider } from "./provider-account-refs.js";
import type { PrecheckResult, SeatAccountConfiguration } from "./provider-types.js";

// #3625 slice 2: the plan for moving one rig's seats of one provider to an account this daemon knows by label. Computed
// from what the daemon already has: each seat's configured account and its own choices, the per-seat precheck (read
// only), the seat's activity, and the Codex home each Codex seat runs on. It changes nothing: applying arrives later.

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
}

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
  note: string;
}

const RUNTIME_OF: Record<AccountRefProvider, string> = { claude: "claude-code", codex: "codex" };
const NOTHING_CHANGED = "A plan only: nothing was changed. Applying it arrives in a later change.";

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

/** The seat's own choice for another account, or null when it has none (or its choice is the target). */
function seatOverride(seat: PlanSeatFacts, account: AccountRef): string | null {
  if (seat.ownHome && seat.ownHome.source !== "rig" && seat.ownHome.home !== account.codexHome) {
    return seat.ownHome.source === "account-switch" ? `its account home ${seat.ownHome.home}` : `its own home ${seat.ownHome.home} (member env)`;
  }
  if (account.provider === "claude" && seat.claudeRef && !sameClaudeRef(seat.claudeRef, account)) {
    return `its own ${seat.claudeRef.kind === "api-key" ? "API-key" : "token"} file ${seat.claudeRef.tokenFile} ("${seat.claudeRef.label}")`;
  }
  if (account.provider === "codex" && seat.configured?.source === "registry" && seat.configured.profileRef !== account.login) {
    return `the saved login ${seat.configured.profileRef} (seat registry)`;
  }
  return null;
}

function sameClaudeRef(ref: ClaudeSeatTokenRef, account: AccountRef): boolean {
  return ref.tokenFile === account.file && (ref.kind === "api-key") === (account.kind === "claude_api_key_file");
}

function unchanged(seat: PlanSeatFacts, account: AccountRef): boolean {
  if (account.provider === "claude") return seat.claudeRef !== null && sameClaudeRef(seat.claudeRef, account);
  return seat.configured?.source === "registry" && seat.configured.profileRef === account.login && seat.codexHome === account.codexHome;
}

/** A Codex seat switches in place only on Linux, on the home the account's login is saved in, and not when it moves to a
 *  named account home instead. */
function codexInPlace(seat: PlanSeatFacts, input: AssignmentPlanInput): boolean {
  return !input.accountHome && input.platform === "linux" && seat.codexHome === input.account.codexHome;
}

function continuity(seat: PlanSeatFacts, input: AssignmentPlanInput): string {
  const { account } = input;
  if (account.provider === "claude") {
    if (seat.running === null) return "unknown: the daemon can't tell whether the seat is running, so whether it keeps its conversation in place or at its next launch";
    return seat.running ? "in place: the seat is relaunched in its own pane and keeps its conversation"
      : "next launch: the reference is saved now, and the seat's next launch resumes its conversation on it";
  }
  if (input.accountHome) return `fresh successor with handover, on ${input.accountHome}`;
  if (seat.codexHome !== account.codexHome) return `unsupported in place: the seat runs on ${seat.codexHome}, and this login is saved in ${account.codexHome}`;
  if (input.platform !== "linux") return "unsupported in place: a Codex seat switches in place only on Linux (name a prepared home with --account-home for a fresh successor)";
  return "in place: the seat restarts on the same conversation";
}

/** The plan. `precheck` is the existing per-seat check, read only; it runs only for seats the plan would change. */
export async function planAssignment(input: AssignmentPlanInput, precheck: (seat: PlanSeatFacts) => Promise<PrecheckResult>): Promise<AssignmentPlan> {
  const { account } = input;
  const runtime = RUNTIME_OF[account.provider];
  const rows: PlanRow[] = [];
  for (const seat of input.seats.filter((s) => s.rigName === input.rig)) {
    const base = { seat: seat.session, runtime: seat.runtime, current: describeConfigured(seat.configured), activity: seat.activity };
    if (seat.runtime !== runtime) {
      rows.push({ ...base, effect: "not_affected", notes: [seat.runtime === RUNTIME_OF[account.provider === "claude" ? "codex" : "claude"]
        ? `a ${seat.runtime} seat: a ${account.provider} assignment doesn't touch it` : `a ${seat.runtime} seat has no ${account.provider} account`] });
      continue;
    }
    if (unchanged(seat, account)) {
      rows.push({ ...base, effect: "unchanged" });
      continue;
    }
    const override = seatOverride(seat, account);
    if (override && !input.includeOverrides) {
      rows.push({ ...base, effect: "kept_override", override, notes: ["kept (seat override); --include-overrides moves it too"] });
      continue;
    }
    const verdict = await precheck(seat);
    const notes = seat.activity === "running" || seat.activity === "needs_input"
      ? [`busy (${seat.activity === "running" ? "working" : "waiting for input"}): a switch interrupts work in flight`] : [];
    rows.push({
      ...base, effect: "change", ...(override ? { override } : {}),
      precheck: verdict.safe ? { safe: true, reasons: [] } : { safe: false, reasons: verdict.reasons, ...(verdict.message ? { message: verdict.message } : {}) },
      continuity: continuity(seat, input),
      ...(notes.length ? { notes } : {}),
    });
  }

  // Codex: an in-place switch changes a home's active login, so every seat on that home moves with it. Only seats that
  // switch in place change a home: not on macOS, not a seat on another home, not a move to a named account home.
  const codexHomes: AssignmentPlan["codexHomes"] = [];
  if (account.provider === "codex") {
    const changing = new Set(rows.filter((r) => r.effect === "change").map((r) => r.seat));
    const homes = [...new Set(input.seats.filter((s) => s.rigName === input.rig && changing.has(s.session) && codexInPlace(s, input)).map((s) => s.codexHome!))];
    for (const home of homes.sort()) {
      codexHomes.push({ home, seats: input.seats.filter((s) => s.runtime === "codex" && s.codexHome === home).map((s) => ({
        seat: s.session, rig: s.rigName,
        effect: s.rigName === input.rig ? "would restart" : `not restarted; needs rig seat restart ${s.session}`,
      })) });
    }
  }

  return {
    daemon: input.daemon, rig: input.rig, provider: account.provider,
    account: { label: account.label, kind: account.kind, reference: describeAccountRef(account) },
    includeOverrides: input.includeOverrides, ...(input.accountHome ? { accountHome: input.accountHome } : {}),
    rows, codexHomes, note: NOTHING_CHANGED,
  };
}
