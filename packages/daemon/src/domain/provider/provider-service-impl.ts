// Slice-04 (OPR.0.5.0.4) C1 (resume) — the production ProviderService. getReadModel is fully
// wired over the collection seam (real codex-auth reader + node-inventory across rigs + clock).
// precheck composes the pure precheckSwitch gate (fails closed on unknown auth per BR-3). switch
// is precheck-gated and NEVER fabricates success — the switch-execution + BR-1 action-record path
// is the D seam; until it lands, switch returns an honest failed_safely with an operational reason.

import fs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import {
  AGENT_ACTIVITY_FRESHNESS_MS,
  type AgentActivityStore,
} from "../agent-activity-store.js";
import { getNodeInventory } from "../node-inventory.js";
import { RUNTIME_HOME_VAR, seatRuntimeHome, type HomeRuntime } from "../seat-runtime-home.js";
import { readClaudeSeatTokenRef } from "../claude-seat-token.js";
import { readCodexAuthMetadata, type CodexAuthMetadata } from "./codex-auth-reader.js";
import { collectFourBlockReadModel, type ProviderSeat } from "./provider-collect.js";
import { configuredSeatAccounts } from "./provider-seat-accounts.js";
import { precheckSwitch } from "./provider-policy.js";
import { collectReactiveEventSignals } from "./reactive-tap.js";
import type { CodexUsageWindows } from "./codex-usage-windows.js";
import type { ClaudeUsageWindows } from "./claude-usage-windows.js";
import type { UsageRefreshResult } from "./usage-windows.js";
import type {
  AssignmentApplyRequest, AssignmentApplyResult, AssignmentApplyTools, AssignmentPlanRequest,
  AssignmentPlanResult,
  ProviderService,
  ProviderPrecheckInput,
  ProviderSwitchInput,
  ProviderSwitchResult,
  SeatRestart,
  SeatSwitchReport,
  ClaudeCredentialPrecedence,
  ClaudeSeatRelaunch,
} from "./provider-service.js";
import { checkClaudeSeat, switchClaudeSeat } from "./claude-seat-switch.js";
import { shellArg } from "../../adapters/shell-quote.js";
import { RigRepository } from "../rig-repository.js";
import { SeatStatusService } from "../seat-status-service.js";
import { assignmentStanding, planAssignment, type AssignmentPlan, type PlanSeatFacts, type PlanCheck } from "./assignment-plan.js";
import { applyAssignment } from "./assignment-apply.js";
import { ProviderAccountAssignmentsRepository, type AssignmentResult } from "./provider-account-assignments.js";
import { accountRefProblem, ProviderAccountRefsRepository, type AccountRef, type AccountRefProvider } from "./provider-account-refs.js";
import type { AgentActivity } from "../types.js";
import type { FourBlockReadModel, PrecheckResult, ProviderSignal, SeatAccountConfiguration, SeatAssignment } from "./provider-types.js";
import { authList, authSave, authSwitch, resolveCodexHome } from "../codex-auth.js";
import type { PeerReport } from "../seat-restart-in-place.js";

/** The Codex logins saved in a home (`rig auth`'s file operations, which never return a token). */
export interface CodexHomeLogins {
  list(home: string): string[];
  /** Saves the home's active login under a new name; never replaces a saved login. */
  save(home: string, name: string): { ok: true; name: string } | { ok: false; reason: string };
  activate(home: string, name: string): { ok: true } | { ok: false; reason: string };
}

type SeatCheck =
  | { ok: false; verdict: Extract<PrecheckResult, { safe: false }> }
  | { ok: true; verdict: Extract<PrecheckResult, { safe: true }>; home: string; peers: PeerReport[] };

const codexHomeLogins: CodexHomeLogins = {
  list: (home) => authList(resolveCodexHome({ CODEX_HOME: home })),
  save: (home, name) => {
    const paths = resolveCodexHome({ CODEX_HOME: home });
    // An earlier switch's recovery copy stays its own, so its receipt's undo restores the bytes it saved.
    try {
      if (fs.lstatSync(nodePath.join(paths.profileDir, `${name}.json`), { throwIfNoEntry: false })) return { ok: false, reason: "name_taken" };
    } catch {
      return { ok: false, reason: "io_error" };
    }
    return authSave(paths, name);
  },
  activate: (home, name) => authSwitch(resolveCodexHome({ CODEX_HOME: home }), name),
};

/** One seat switch at a time per Codex home in this daemon: a switch's save, activation and restart finish before the
 *  next switch on that home starts, so each restart loads the login its receipt names. */
const switchesByHome = new Map<string, Promise<unknown>>();
/** #3625: the rigs an assignment is being applied to now. In memory, so a daemon restart can't leave a rig locked. */
const applying = new Set<string>();

/** #3625: the switches this daemon has made of each Codex home (keyed by its resolved path), and the seat that made the
 *  last. An apply uses it to tell that a home it switched was switched again while it restarted the home's other seats.
 *  In memory, and only this daemon's switches: a `rig auth switch` run by hand isn't counted. */
const homeSwitches = new Map<string, { count: number; seat: string }>();

/** The switches this daemon has made of a Codex home so far, and the seat that made the last; null for none. */
export function homeSwitchesOf(home: string): { count: number; seat: string } | null {
  return homeSwitches.get(resolvedHome(home)) ?? null;
}

/** A home's path with symlinks resolved, or its absolute path when it can't be resolved. */
function resolvedHome(home: string): string {
  try { return fs.realpathSync(home); } catch { return nodePath.resolve(home); }
}

function oneSwitchPerHome<T>(home: string, run: (waited: boolean) => Promise<T>): Promise<T> {
  let key = home;
  try { key = fs.realpathSync(home); } catch { /* an unresolvable home is keyed by its path */ }
  const ahead = switchesByHome.get(key);
  const next = (ahead ?? Promise.resolve()).then(() => run(ahead !== undefined));
  const settled = next.catch(() => undefined);
  switchesByHome.set(key, settled);
  void settled.then(() => { if (switchesByHome.get(key) === settled) switchesByHome.delete(key); });
  return next;
}

/** What a seat restarted after a switch records as its reason; a login name has no quotes or spaces. */
function movedReason(account: string): string {
  return `--reason "its Codex home moved to ${account}"`;
}

/** A peer on the same home keeps its current login only until its next token refresh, then stops until it's restarted. */
function withRestartSteps(peers: PeerReport[], account: string): SeatSwitchReport["peers"] {
  return peers.map((peer) => peer.home === "same" && peer.sessionName
    ? { ...peer, step: `rig seat restart ${peer.sessionName} --keep-conversation ${movedReason(account)}` } : peer);
}

/** The per-seat precheck input for moving a seat to this account. */
function precheckFor(seat: string, account: AccountRef): ProviderPrecheckInput {
  if (account.provider === "codex") return { seat, toAccount: account.login! };
  return account.kind === "claude_api_key_file" ? { seat, toAccount: account.label, apiKeyFile: account.file! }
    : { seat, toAccount: account.label, tokenFile: account.file! };
}

export interface ProviderServiceImplDeps {
  db: Database.Database;
  /** The rig universe (rigRepo.listRigs()) — each rig's node-inventory contributes seats. */
  listRigs: () => Array<{ id: string }>;
  /** Slice-04 C3: the Claude statusline provider_usage signal source (undefined → signals []). */
  collectClaudeSignals?: () => ProviderSignal[];
  /** Slice-04 C4: the shipped structured activity detector. Undefined keeps the reactive lane empty. */
  agentActivityStore?: Pick<AgentActivityStore, "getLatestForNode">;
  /** #3625: a seat's activity as rig ps reads it (readCurrentSeatActivity: a live hook, else the cached pane reading),
   *  for the assignment plan's busy note and the activity each applied result stores. Undefined reads unknown. */
  seatActivity?: (sessionName: string) => AgentActivity | null;
  /** W2a tap: operator-visible disposition sink. Observability only; never a verification producer. */
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  /** Slice 01: Codex usage windows, served only while `enabled()` (provider.usage_windows) is true. */
  usageWindows?: { enabled: () => boolean; windows: CodexUsageWindows; claude?: ClaudeUsageWindows; claudeTokens?: import("./claude-token-usage.js").ClaudeTokenUsage };
  /** The logins saved in a Codex home; defaults to `rig auth`'s files. A seat switch acts on the home the seat runs on. */
  codexLogins?: CodexHomeLogins;
  /** What would outrank a Claude seat's own token; without it, Claude seats aren't moved. */
  claudePrecedence?: ClaudeCredentialPrecedence;
  /** Where a Codex seat can switch in place (Linux); tests pin it. */
  platform?: NodeJS.Platform;
}

/** The seat a session name reaches through a seat tool's lookup (`seatReachedBy`). */
type SeatReached = { nodeId: string; rigId: string; archived: boolean } | { ambiguous: true } | { none: true };

/** Why a seat whose session name doesn't reach it alone isn't moved. */
function unreachedSeat(session: string, r: SeatReached): string {
  const why = "ambiguous" in r ? `${session} is the session name of more than one active seat, and a switch or restart reaches a seat by that name`
    : "none" in r ? `${session} doesn't reach this seat by name: the switch's lookup finds no such seat`
    : `a switch finds a seat by its session name, and ${session} reaches the seat in rig ${r.rigId}${r.archived ? " (archived)" : ""}, not this one`;
  return `${why}. Nothing changes for this seat here${"ambiguous" in r ? "; archiving the other rig (rig archive) leaves it the only seat with that name" : ""}.`;
}

export class ProviderServiceImpl implements ProviderService {
  constructor(private readonly deps: ProviderServiceImplDeps) {}

  /** The daemon's own homes: the CODEX_HOME and Claude config dir a seat launches with when it declares none. */
  private homes() {
    const env = this.deps.env ?? process.env;
    return {
      codexHome: env.CODEX_HOME || nodePath.join(env.HOME ?? os.homedir(), ".codex"),
      claudeConfigDir: env.CLAUDE_CONFIG_DIR,
      home: env.HOME ?? os.homedir(),
    };
  }

  async getReadModel(): Promise<FourBlockReadModel> {
    const env = this.deps.env ?? process.env;
    const asOf = (this.deps.now ?? (() => new Date().toISOString()))();
    let auth: CodexAuthMetadata | undefined;
    let entries: ReturnType<ProviderServiceImpl["seatEntries"]> | undefined;
    let seats: ProviderSeat[] | undefined;
    const readAuth = () => auth ??= readCodexAuthMetadata(env);
    const listEntries = () => entries ??= this.seatEntries();
    const listSeats = () => seats ??= listEntries().map(({ seat }) => seat);
    const homes = this.homes();
    // Configuration only (names and references, no usage or samples), so it's computed on every read.
    let configuredList: SeatAccountConfiguration[] | undefined;
    const configuredOf = () => configuredList ??= configuredSeatAccounts({ seats: listSeats(), auth: readAuth(), usage: [], claudeSamples: null, ...homes })
      .map((seat) => seat.configured);
    // #3625: read from what applies stored; nothing is written.
    let statuses: Array<SeatAssignment | undefined> | undefined;
    const assignmentsOf = () => statuses ??= this.assignmentStatuses(listEntries(), configuredOf());
    const collectReactiveSignals = (): ProviderSignal[] => {
      if (!this.deps.agentActivityStore) return [];
      const result = collectReactiveEventSignals({
        seats: listSeats(),
        auth: readAuth(),
        activity: this.deps.agentActivityStore,
        now: asOf,
        freshnessMs: AGENT_ACTIVITY_FRESHNESS_MS,
      });
      const warn = this.deps.warn ?? ((message: string) => console.warn(message));
      for (const disposition of [...result.triggers, ...result.discards]) {
        warn(`[provider-reactive-tap] ${JSON.stringify(disposition)}`);
      }
      return result.signals;
    };
    const model = collectFourBlockReadModel({
      readCodexAuth: readAuth,
      listSeats,
      collectSignals: () => [
        ...(this.deps.collectClaudeSignals?.() ?? []),
        ...collectReactiveSignals(),
      ],
      configuredAccounts: () => configuredOf(),
      assignments: () => assignmentsOf(),
      now: () => asOf,
    });
    // Slice 01: memory only. A read never starts a native probe (the wake ladder reads this every tick).
    const usage = this.usageWindowsEnabled() ? this.deps.usageWindows!.windows.project(asOf) : null;
    if (!usage) return model;
    // The read covers only the login active in the daemon's CODEX_HOME: say so whenever saved rig auth
    // profiles exist, so a profile without a row never reads as fine.
    const profiles = model.accounts.filter((a) => a.provider === "codex").map((a) => a.accountId);
    const savedProfiles = profiles.length > 0
      ? { names: profiles, note: "saved rig auth profiles: not read (usage unknown); this reading is only the login active in the daemon's CODEX_HOME" }
      : null;
    const codexRows = savedProfiles ? usage.map((row) => ({ ...row, savedProfiles })) : usage;
    const allUsage = [...codexRows, ...(this.deps.usageWindows!.claude?.project(asOf) ?? []), ...(this.deps.usageWindows!.claudeTokens?.project(asOf) ?? [])];
    // Each seat's configured account, from the same seat universe and registry metadata (names only), never
    // linked to a usage row.
    const seatAccounts = configuredSeatAccounts({
      seats: listSeats(),
      auth: readAuth(),
      usage: allUsage,
      claudeSamples: this.deps.usageWindows!.claude?.seatSamples() ?? null,
      ...homes,
    }).map((row, i) => (assignmentsOf()[i] ? { ...row, assignment: assignmentsOf()[i]! } : row));
    return { ...model, usage: allUsage, seatAccounts };
  }

  async refreshUsage(provider: "codex" | "claude", token?: import("./claude-token-usage.js").ClaudeTokenSelection): Promise<UsageRefreshResult | { disabled: true } | { unavailable: true }> {
    if (!this.usageWindowsEnabled()) return { disabled: true };
    if (provider === "claude" && token) return this.deps.usageWindows!.claudeTokens?.refresh(token) ?? { unavailable: true };
    if (provider === "claude") return this.deps.usageWindows!.claude?.refresh() ?? { unavailable: true };
    return this.deps.usageWindows!.windows.refresh();
  }

  private usageWindowsEnabled(): boolean {
    if (!this.deps.usageWindows) return false;
    try {
      return this.deps.usageWindows.enabled();
    } catch {
      return false;
    }
  }

  private listSeats(): ProviderSeat[] {
    return this.seatEntries().map(({ seat }) => seat);
  }

  /** Every seat on this daemon with its node, as the read model lists them. */
  private seatEntries(): Array<{ nodeId: string; rigId: string; seat: ProviderSeat }> {
    const seats: Array<{ nodeId: string; rigId: string; seat: ProviderSeat }> = [];
    for (const rig of this.deps.listRigs()) {
      for (const entry of getNodeInventory(this.deps.db, rig.id)) {
        if (!entry.canonicalSessionName) continue;
        const runtime = entry.runtime ?? "unknown";
        const runtimeHome = Object.hasOwn(RUNTIME_HOME_VAR, runtime)
          ? seatRuntimeHome(this.deps.db, entry.nodeId, runtime as HomeRuntime)
          : {};
        // The launch's own reader says whether the seat has a token reference; #3148's resolver names its label.
        const tokenRef = runtime === "claude-code" ? readClaudeSeatTokenRef(this.deps.db, entry.nodeId) : null;
        seats.push({ nodeId: entry.nodeId, rigId: rig.id, seat: {
          seatSession: entry.canonicalSessionName,
          rigName: entry.rigName ?? "",
          runtime,
          lifecycleState: entry.lifecycleState,
          ...(runtimeHome.home || runtimeHome.ignored ? { runtimeHome } : {}),
          ...(tokenRef && entry.configuredAccount ? { claudeToken: { label: entry.configuredAccount, ...(tokenRef.kind ? { kind: tokenRef.kind } : {}) } } : {}),
        } });
      }
    }
    return seats;
  }

  /** #3625: the plan for moving a rig's seats of one provider to an account this daemon knows by label. Read only: the
   *  per-seat precheck it runs reads the seat (a Codex seat's restart plan stops nothing). */
  async assignmentPlan(input: AssignmentPlanRequest, seatRestart?: SeatRestart, claudeSeat?: ClaudeSeatRelaunch,
    successorCheck?: (seat: string, accountHome: string) => Promise<PlanCheck>): Promise<AssignmentPlanResult> {
    const rig = this.resolveRig(input.rig);
    if (!rig.ok) return rig;
    const planned = await this.planFor(input, rig, { seatRestart, claudeSeat, successorCheck });
    return planned.ok ? { ok: true, plan: planned.plan } : planned;
  }

  /** #3625: the one rig a plan or apply is for: the rig with this id, else the one active rig with this name. A name two
   *  active rigs share is refused with their ids, as the other rig-name commands do: never the first match, never both. */
  private resolveRig(handle: string): { ok: true; id: string; name: string }
    | { ok: false; code: "unknown_rig"; message: string } | { ok: false; code: "rig_ambiguous"; message: string; candidates: string[] } {
    const byId = this.deps.db.prepare("SELECT id, name FROM rigs WHERE id = ?").get(handle) as { id: string; name: string } | undefined;
    if (byId) return { ok: true, ...byId };
    const named = this.deps.db.prepare("SELECT id, name FROM rigs WHERE name = ? AND archived_at IS NULL ORDER BY created_at")
      .all(handle) as Array<{ id: string; name: string }>;
    if (named.length === 1) return { ok: true, ...named[0]! };
    if (named.length > 1) {
      return { ok: false, code: "rig_ambiguous", candidates: named.map((r) => r.id),
        message: `'${handle}' matches ${named.length} rigs (${named.map((r) => r.id).join(", ")}). Nothing was done; pass one of these ids instead.` };
    }
    return { ok: false, code: "unknown_rig", message: `There's no rig named ${handle} with seats on this daemon (rig ps lists them).` };
  }

  /** #3625: the seat a seat tool reaches by this session name. An in-place switch and its precheck (pass `claudeSeat`) ask
   *  the Claude relaunch's own lookup first, for a seat of any runtime (every session row, archived rigs' and older ones
   *  included, the newest first): a seat it finds is the one they act on, so it must be this one. A Codex seat's restart,
   *  and the successor and its dry run (no `claudeSeat`), use the seat-ref resolver: active rigs only, refusing a name more
   *  than one seat has. */
  private seatReachedBy(session: string, runtime: string, claudeSeat?: ClaudeSeatRelaunch): SeatReached {
    const claude = claudeSeat?.seat(session);
    if (claude) {
      const archived = this.deps.db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(claude.rigId) as { archived_at: string | null } | undefined;
      return { nodeId: claude.nodeId, rigId: claude.rigId, archived: !!archived?.archived_at };
    }
    if (runtime === "claude-code" && claudeSeat) return { none: true };
    const status = new SeatStatusService({ rigRepo: new RigRepository(this.deps.db) }).getStatus(session);
    if (!status.ok) return status.code === "seat_ambiguous" ? { ambiguous: true } : { none: true };
    const node = this.deps.db.prepare("SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?").get(status.status.rig_id, status.status.logical_id) as { id: string } | undefined;
    return node ? { nodeId: node.id, rigId: status.status.rig_id, archived: false } : { none: true };
  }

  /** The plan command again, as the person copies it into a shell. */
  private reviewCommand(input: AssignmentPlanRequest): string {
    return `rig provider assign ${shellArg(input.rig)} --provider ${input.provider} --account ${shellArg(input.label)}`
      + `${input.includeOverrides ? " --include-overrides" : ""}${input.accountHome ? ` --account-home ${shellArg(input.accountHome)}` : ""}`;
  }

  /** #3625 slice 3: the plan again, and if its digest is the one the person saw, each seat through the existing switch.
   *  One apply per rig at a time; the assignment is stored with the first seat that's on the account or may be (switched,
   *  pending successor, unknown, or already on it), and each result as it lands. */
  async applyAssignment(input: AssignmentApplyRequest, tools: AssignmentApplyTools): Promise<AssignmentApplyResult> {
    // The rig is held before the plan is computed again: its prechecks wait, and an apply that ran meanwhile would leave
    // this one comparing the reviewed digest with seats read before that apply changed them.
    const rig = this.resolveRig(input.rig);
    if (!rig.ok) return rig;
    const rigKey = rig.id;
    if (applying.has(rigKey)) {
      return { ok: false, code: "apply_in_progress", message: `An assignment is already being applied to rig ${input.rig} on this daemon. Nothing changed; its results show in the plan as they land.` };
    }
    applying.add(rigKey);
    try {
      const planned = await this.planFor(input, rig, tools);
      if (!planned.ok) return planned;
      const { plan, account, rigId, nodeOf } = planned;
      if (plan.digest !== input.digest) {
        return { ok: false, code: "plan_changed", digest: plan.digest,
          message: `The plan for rig ${input.rig} changed since plan ${input.digest} was shown (it's ${plan.digest} now): a seat, its account, a precheck or a shared home is different. `
            + `Nothing changed. Review it again with ${this.reviewCommand(input)}.` };
      }
      // The label was read before the prechecks were awaited. If it was removed and added again meanwhile naming another
      // reference, the plan's digest is of the earlier one: refuse before any seat changes. Nothing is awaited from here to
      // the first seat's switch call. A label edited after that leaves the seats on the reference reviewed, which their
      // results record, so status and the next plan don't read them as on the label's new one.
      const current = new ProviderAccountRefsRepository(this.deps.db).get(input.provider, input.label);
      if (!current || current.kind !== account.kind || current.file !== account.file || current.codexHome !== account.codexHome || current.login !== account.login) {
        return { ok: false, code: "plan_changed",
          message: `The account ${input.label} ${current ? "names another reference" : "was removed"} since this apply computed its plan. Nothing changed. `
            + `Review it again with ${this.reviewCommand(input)}.` };
      }
      const assignments = new ProviderAccountAssignmentsRepository(this.deps.db);
      const now = () => (this.deps.now ?? (() => new Date().toISOString()))();
      // The rig's assignment is stored once a seat is on the account or may be: switched, pending successor, unknown, or
      // unchanged because it was already on it. An apply where every seat was refused, failed before effect or kept its
      // own override leaves the rig's earlier assignment as it was, so it doesn't hold that label against removal.
      let stored = false;
      const keptOverride = new Set(plan.rows.filter((r) => r.effect === "kept_override").map((r) => r.seat));
      const tookEffect = (kind: string, seat: string) => kind === "switched" || kind === "pending_successor" || kind === "unknown"
        || (kind === "unchanged" && !keptOverride.has(seat));
      // Checked again just before each effect, with the lookup that effect uses: the plan's check was awaited, and a session
      // registered since could give the name another seat.
      // Each effect is checked with its own lookup: the switch with the Claude relaunch's first, a restart or a successor
      // with the seat-ref resolver's.
      const elsewhere = (seat: string, inPlace = false): string | null => {
        const node = nodeOf.get(seat)!;
        const r = this.seatReachedBy(seat, node.runtime, inPlace ? tools.claudeSeat : undefined);
        return "nodeId" in r && r.nodeId === node.nodeId ? null : unreachedSeat(seat, r);
      };
      const report = await applyAssignment(plan, account, {
        switchSeat: async (seat) => {
          const why = elsewhere(seat, true);
          if (why) return { outcome: "failed_safely", reasons: ["seat_name_shared"], message: why };
          // The switch awaits its check and may wait for the shared home before it restarts the seat by name: the restart
          // carries the node selected here, so it never acts on a seat the name reaches by then.
          const nodeId = nodeOf.get(seat)!.nodeId;
          const pinned: SeatRestart | undefined = tools.seatRestart
            && { plan: (s) => tools.seatRestart!.plan(s, nodeId), run: (s, reason) => tools.seatRestart!.run(s, reason, nodeId) };
          return this.switchAccount({ ...precheckFor(seat, account), forceUnsafe: false }, pinned, tools.claudeSeat);
        },
        restartPeer: async (seat, reason) => {
          if (!tools.seatRestart) return { ok: false, code: "restart_unavailable", message: "The seat's restart isn't available here." };
          const why = elsewhere(seat);
          if (why) return { ok: false, code: "seat_name_shared", message: why };
          const r = await tools.seatRestart.run(seat, reason);
          return r.ok ? { ok: true, ...("outcome" in r && r.outcome ? { outcome: r.outcome } : {}), message: r.message,
            ...("recoveryCommand" in r && typeof r.recoveryCommand === "string" ? { recoveryCommand: r.recoveryCommand } : {}),
            ...("remainingStep" in r && typeof r.remainingStep === "string" ? { remainingStep: r.remainingStep } : {}) }
            : { ok: false, code: r.code, message: r.message };
        },
        ...(tools.successor ? { successor: async (seat: string, home: string) => {
          const why = elsewhere(seat);
          return why ? { ok: false as const, code: "seat_name_shared", message: why } : tools.successor!(seat, home);
        } } : {}),
        homeSwitches: homeSwitchesOf,
        activityOf: (seat) => this.activityOf(seat),
        save: (result, applied) => {
          if (!stored && tookEffect(result.kind, result.seat)) {
            assignments.setIntent({ rigId, provider: input.provider, label: input.label, reference: plan.account.reference, requestedBy: input.requestedBy, at: now() });
            stored = true;
          }
          assignments.saveResult({ rigId, provider: input.provider, nodeId: nodeOf.get(result.seat)!.nodeId, seat: result.seat,
          label: input.label, kind: result.kind, detail: result.detail, recovery: result.recovery ?? null, activity: result.activity, at: result.at,
          ...(applied ? { applied: { ...applied, account: { kind: account.kind, file: account.file, codexHome: account.codexHome, login: account.login } } } : {}) });
        },
        now,
      });
      return { ok: true, report };
    } finally {
      applying.delete(rigKey);
    }
  }

  private activityOf(session: string): PlanSeatFacts["activity"] {
    return this.deps.seatActivity?.(session)?.state ?? "unknown";
  }

  /** #3625: what the plan and status know about each seat's account choices, one per entry. A seat whose configuration is
   *  still what an apply gave it follows its rig's assignment, so it isn't the seat's own override: this is the one
   *  definition both read. `resultOf` gives the seat's latest result where it counts. */
  private assignmentFacts(entries: Array<{ nodeId: string; rigId: string; seat: ProviderSeat }>, configured: Array<SeatAccountConfiguration | null | undefined>,
    resultOf: (nodeId: string, seat: ProviderSeat) => AssignmentResult | undefined): Array<Omit<PlanSeatFacts, "running" | "activity">> {
    const homes = this.homes();
    return entries.map(({ nodeId, rigId, seat }, index) => {
      const own = Object.hasOwn(RUNTIME_HOME_VAR, seat.runtime) ? seatRuntimeHome(this.deps.db, nodeId, seat.runtime as HomeRuntime) : {};
      const claudeRef = seat.runtime === "claude-code" ? readClaudeSeatTokenRef(this.deps.db, nodeId) : null;
      const seatConfigured = configured[index] ?? null;
      const ownHome = own.home && own.source ? { home: own.home, source: own.source } : null;
      const last = resultOf(nodeId, seat);
      const a = last?.applied;
      const follows = !!a && ((claudeRef !== null && a.file === claudeRef.tokenFile && (a.fileKind === "api-key") === (claudeRef.kind === "api-key"))
        || (ownHome?.source === "account-switch" && a.codexHome !== null && a.codexLogin === null && resolvedHome(a.codexHome) === resolvedHome(ownHome.home))
        // A saved login is a name within its Codex home: the same name in another home is another login.
        || (seatConfigured?.source === "registry" && a.codexLogin !== null && seatConfigured.profileRef === a.codexLogin
          && a.codexHome !== null && resolvedHome(own.home ?? homes.codexHome) === resolvedHome(a.codexHome))
        // A seat with no saved login of its own uses its home's active login, which the apply switched in place.
        || (seat.runtime === "codex" && seatConfigured?.source === "default_login" && a.codexLogin !== null && a.codexHome !== null
          && resolvedHome(own.home ?? homes.codexHome) === resolvedHome(a.codexHome)));
      return {
        session: seat.seatSession, rigId, rigName: seat.rigName, runtime: seat.runtime,
        configured: seatConfigured, claudeRef, ownHome,
        codexHome: seat.runtime === "codex" ? own.home ?? homes.codexHome : null,
        ...(follows ? { followsAssignment: true, ...(a?.label ? { appliedLabel: a.label } : {}), appliedAccount: a?.account ?? null } : {}),
        ...(last ? { lastResult: { kind: last.kind, label: last.label, detail: last.detail, at: last.at } } : {}),
      };
    });
  }

  /** #3625: each seat against its rig's assignment for its provider, for status: read only, from what applies stored. */
  private assignmentStatuses(entries: Array<{ nodeId: string; rigId: string; seat: ProviderSeat }>,
    configured: Array<SeatAccountConfiguration | null | undefined>): Array<SeatAssignment | undefined> {
    const providerOf = (runtime: string): AccountRefProvider | null => (runtime === "claude-code" ? "claude" : runtime === "codex" ? "codex" : null);
    const assignments = new ProviderAccountAssignmentsRepository(this.deps.db);
    const intents = new Map(assignments.allIntents().map((i) => [`${i.rigId}\0${i.provider}`, i]));
    const results = new Map(assignments.allResults().map((r) => [`${r.nodeId}\0${r.provider}`, r]));
    const resultOf = (nodeId: string, seat: ProviderSeat) => { const p = providerOf(seat.runtime); return p ? results.get(`${nodeId}\0${p}`) : undefined; };
    // Only a seat whose rig has an assignment for its provider is compared with it: the read model runs every tick, so the
    // others read "no assignment" (with any result they have) without reading their homes.
    const compared = entries.flatMap((e, index) => {
      const p = providerOf(e.seat.runtime);
      return p && intents.has(`${e.rigId}\0${p}`) ? [index] : [];
    });
    const comparedFacts = this.assignmentFacts(compared.map((i) => entries[i]!), compared.map((i) => configured[i]), resultOf);
    const facts = new Map(compared.map((entryIndex, k) => [entryIndex, comparedFacts[k]!]));
    const refs = new ProviderAccountRefsRepository(this.deps.db);
    const accounts = new Map<string, AccountRef | null>();
    const accountOf = (provider: AccountRefProvider, label: string) => {
      const key = `${provider}\0${label}`;
      if (!accounts.has(key)) accounts.set(key, refs.get(provider, label));
      return accounts.get(key)!;
    };
    return entries.map(({ nodeId, rigId, seat }, index): SeatAssignment | undefined => {
      const provider = providerOf(seat.runtime);
      if (!provider) return undefined;
      const last = resultOf(nodeId, seat);
      const applied = last ? { kind: last.kind, label: last.label, detail: last.detail, at: last.at, ...(last.recovery ? { recovery: last.recovery } : {}),
        ...(last.activity ? { activity: last.activity } : {}) } : null;
      const intent = intents.get(`${rigId}\0${provider}`);
      if (!intent) return { provider, state: "no_assignment", intended: null, applied };
      const intended = { label: intent.label, reference: intent.reference, requestedBy: intent.requestedBy, at: intent.at };
      const account = accountOf(provider, intent.label);
      const standing = assignmentStanding({ ...facts.get(index)!, running: null, activity: "unknown" }, account, intent, resolvedHome);
      return { provider, state: standing.state, intended, applied, ...(standing.override ? { override: standing.override } : {}),
        ...(standing.asApplied ? { asApplied: true as const } : {}), ...(account ? {} : { referenceMissing: true as const }) };
    });
  }

  private async planFor(input: AssignmentPlanRequest, rig: { id: string; name: string }, tools: AssignmentApplyTools): Promise<
    | { ok: true; plan: AssignmentPlan; account: AccountRef; rigId: string; nodeOf: Map<string, { nodeId: string; runtime: string }> }
    | { ok: false; code: "unknown_account" | "unknown_rig" | "reference_unusable"; message: string }> {
    const { seatRestart, claudeSeat, successorCheck } = tools;
    const account = new ProviderAccountRefsRepository(this.deps.db).get(input.provider, input.label);
    if (!account) {
      return { ok: false, code: "unknown_account", message: `There's no ${input.provider} account labelled ${input.label} on this daemon (rig provider account list --provider ${input.provider} lists them).` };
    }
    // Checked again now, not only when it was added: a file may have changed or gone, or a link may point elsewhere.
    const problem = accountRefProblem(account.provider === "codex"
      ? { provider: "codex", label: account.label, codexHome: account.codexHome!, login: account.login! }
      : account.kind === "claude_api_key_file" ? { provider: "claude", label: account.label, apiKeyFile: account.file! }
      : { provider: "claude", label: account.label, tokenFile: account.file! });
    if (problem) return { ok: false, code: "reference_unusable", message: `${input.label}'s reference no longer checks out: ${problem.message.replace(/ Nothing was stored\.$/, "")}` };
    const entries = this.seatEntries();
    // The rig is the one resolved by id: another rig with the same name is another rig, whose seats are outside peers.
    const rigId = rig.id;
    if (!entries.some((e) => e.rigId === rigId)) {
      return { ok: false, code: "unknown_rig", message: `There's no rig named ${input.rig} with seats on this daemon (rig ps lists them).` };
    }
    const assignments = new ProviderAccountAssignmentsRepository(this.deps.db);
    const results = new Map(assignments.results(rigId, input.provider).map((r) => [r.nodeId, r]));
    const configured = configuredSeatAccounts({ seats: entries.map(({ seat }) => seat), auth: readCodexAuthMetadata(this.deps.env ?? process.env),
      usage: [], claudeSamples: null, ...this.homes() }).map((c) => c.configured);
    const nodeOf = new Map<string, { nodeId: string; runtime: string }>();
    for (const { nodeId, rigId: seatRig, seat } of entries) if (seatRig === rigId) nodeOf.set(seat.seatSession, { nodeId, runtime: seat.runtime });
    const facts = this.assignmentFacts(entries, configured, (nodeId) => results.get(nodeId));
    // Every tool that reads or changes a seat finds it by its session name: two rigs with the same name and member, or an
    // archived or older generation of one, can give that name another seat. So each seat is checked against the lookup its
    // switch or restart uses, and one that doesn't reach it alone isn't read and is refused before any effect.
    // A move to a prepared home goes through the successor, whose dry run and run use the seat-ref resolver; an in-place
    // switch and its precheck ask the Claude relaunch's lookup first.
    const moves = !!input.accountHome && account.provider === "codex";
    const reached = new Map(entries.filter((e) => e.rigId === rigId).map((e) =>
      [e.nodeId, this.seatReachedBy(e.seat.seatSession, e.seat.runtime, moves ? undefined : claudeSeat)]));
    const notReached = (nodeId: string, session: string): PlanCheck | null => {
      const r = reached.get(nodeId);
      return !r || ("nodeId" in r && r.nodeId === nodeId) ? null : { safe: false, reasons: ["seat_name_shared"], message: unreachedSeat(session, r) };
    };
    const seats = entries.map(({ nodeId, rigId: seatRig, seat }, index): PlanSeatFacts => {
      // Only this rig's seats are read, and only those their session name reaches.
      const readable = seatRig === rigId && notReached(nodeId, seat.seatSession) === null;
      return { ...facts[index]!,
        running: seat.runtime === "claude-code" && readable ? claudeSeat?.seat(seat.seatSession)?.running ?? null : null,
        activity: readable ? this.activityOf(seat.seatSession) : "unknown" };
    });
    const plan = await planAssignment({ daemon: input.daemon, rig: rig.name, rigId, account, seats, includeOverrides: input.includeOverrides,
      ...(input.accountHome ? { accountHome: input.accountHome } : {}), platform: this.deps.platform ?? process.platform,
      resolveHome: resolvedHome,
      intent: assignments.intent(rigId, input.provider),
      // The restart command's own resolver decides whether a printed `rig seat restart <name>` reaches a seat.
      restartReaches: (session, seatRig) => { const r = this.seatReachedBy(session, "codex"); return "rigId" in r && r.rigId === seatRig; } },
    async (seat) => notReached(nodeOf.get(seat.session)!.nodeId, seat.session) ?? (input.accountHome && account.provider === "codex"
      // A move to a prepared home isn't an in-place switch: it's checked by the account-home dry run, not the switch's precheck.
      ? successorCheck ? successorCheck(seat.session, input.accountHome)
        : Promise.resolve({ safe: false, reasons: ["successor_not_checked"], message: "The account-home dry run isn't available here, so the move wasn't checked." })
      : this.precheck(precheckFor(seat.session, account), seatRestart, claudeSeat)));
    return { ok: true, plan, account, rigId, nodeOf };
  }

  async precheck(input: ProviderPrecheckInput, seatRestart?: SeatRestart, claudeSeat?: ClaudeSeatRelaunch): Promise<PrecheckResult> {
    const claude = claudeSeat?.seat(input.seat);
    if (claude) return (await checkClaudeSeat(input, claude, this.deps.claudePrecedence, (rigId, nodeId) => claudeSeat!.nextLaunch(rigId, nodeId))).verdict;
    if (seatRestart) return (await this.seatPrecheck(input, seatRestart)).verdict;
    const model = await this.getReadModel();
    const target = model.accounts.find((a) => a.accountId === input.toAccount);
    // Validate-at-use: an unknown target OR unknown auth fails closed (BR-3 — disk presence never
    // asserts active). Live-conversation state is not yet wired (the C2 activity seam), so assume
    // live — the conservative direction never strands a conversation silently. This is the MANUAL
    // precheck variant (no triggeringSignal; that's for automated policy-driven switches).
    return precheckSwitch({
      targetProvider: target?.provider ?? "codex",
      targetAuthState: target?.authState ?? "unknown",
      seatHasLiveConversation: true,
    });
  }

  async switchAccount(input: ProviderSwitchInput, seatRestart?: SeatRestart, claudeSeat?: ClaudeSeatRelaunch): Promise<ProviderSwitchResult> {
    const claude = claudeSeat?.seat(input.seat);
    if (claudeSeat && claude) return switchClaudeSeat(input, claudeSeat, claude, this.deps.claudePrecedence);
    if (seatRestart) return this.switchSeat(input, seatRestart);
    // Precheck-gate: never switch past an unsafe verdict unless explicitly forced.
    const verdict = await this.precheck({ seat: input.seat, toAccount: input.toAccount });
    if (verdict.safe === false && !input.forceUnsafe) {
      const reasons = verdict.reasons.length > 0 ? verdict.reasons : ["precheck_unsafe"];
      return { outcome: "failed_safely", reasons: reasons as [string, ...string[]] };
    }
    // D seam (compose the rig-auth codex switch + BR-1 durable action record) is NOT yet wired.
    // Honest operational failure — never fabricate a succeeded/rebind_in_progress outcome.
    return { outcome: "failed_safely", reasons: ["switch_execution_not_yet_wired"] };
  }

  /** A seat's precheck reads the seat: its in-place restart plan (every gate, nothing stopped) names the Codex home the
   *  running seat uses, and the login must be saved there. Every saved login's sign-in state reads unknown, so an
   *  authorized move isn't refused for that; the restart's uptake evidence settles it. */
  private async seatPrecheck(input: ProviderPrecheckInput, seatRestart: SeatRestart): Promise<SeatCheck> {
    if (input.apiKeyFile !== undefined) return { ok: false, verdict: { safe: false, reasons: ["invalid_token_reference"],
      message: "Codex uses a saved API-key login in its existing home. Import/save that native login with rig auth, then select its name with --to-account; --api-key-file is for Claude." } };
    const plan = await seatRestart.plan(input.seat);
    if (!plan.ok) {
      return { ok: false, verdict: { safe: false, reasons: [plan.code === "not_codex" ? "rebind_unsupported_for_runtime" : plan.code === "seat_name_shared" ? "seat_name_shared" : "seat_restart_refused"],
        message: `${plan.code}: ${plan.message}` } };
    }
    const seat = { home: plan.codexHome, activity: plan.activity.state, peers: plan.peers };
    if (!this.codexLogins().list(plan.codexHome).includes(input.toAccount)) {
      return { ok: false, verdict: { safe: false, reasons: ["target_not_in_seat_home"], seat,
        message: `No login named "${input.toAccount}" is saved in ${plan.codexHome}, the Codex home this seat runs on. List them with: rig auth list --codex-home ${plan.codexHome}` } };
    }
    return { ok: true, verdict: { safe: true, seat }, home: plan.codexHome, peers: plan.peers };
  }

  /** Move one seat: keep the home's outgoing login, activate the chosen one, restart the seat in place (same conversation,
   *  pane and launch settings), and report. A seat refusal can't be forced: there'd be nothing safe to restart, or no
   *  such login. Nothing changes unless the outgoing login was saved first (or the home had none). Never retried: a
   *  restart whose result isn't confirmed is reported with its recovery command. */
  private async switchSeat(input: ProviderSwitchInput, seatRestart: SeatRestart): Promise<ProviderSwitchResult> {
    const checked = await this.seatPrecheck(input, seatRestart);
    if (!checked.ok) {
      const { reasons, message } = checked.verdict;
      return { outcome: "failed_safely", reasons: reasons as [string, ...string[]], ...(message ? { message } : {}) };
    }
    return oneSwitchPerHome(checked.home, async (waited): Promise<ProviderSwitchResult> => {
      if (!waited) return this.switchOnHome(input, seatRestart, checked.home, checked.peers);
      // It waited behind another switch on this home, so the seat may have changed meanwhile: check it again first.
      const now = await this.seatPrecheck(input, seatRestart);
      const nowHome = now.ok ? now.home : now.verdict.seat?.home;
      if (nowHome !== undefined && nowHome !== checked.home) {
        return { outcome: "failed_safely", reasons: ["seat_home_changed"],
          message: `${input.seat} now runs on ${nowHome}, not ${checked.home}, the home this switch waited on. Nothing changed; run the switch again for its current home.` };
      }
      if (!now.ok) {
        const { reasons, message } = now.verdict;
        return { outcome: "failed_safely", reasons: reasons as [string, ...string[]], ...(message ? { message } : {}) };
      }
      return this.switchOnHome(input, seatRestart, now.home, now.peers);
    });
  }

  private async switchOnHome(input: ProviderSwitchInput, seatRestart: SeatRestart, home: string, peers: PeerReport[]): Promise<ProviderSwitchResult> {
    const logins = this.codexLogins();
    const stamp = (this.deps.now ?? (() => new Date().toISOString()))().replace(/[-:]/g, "");
    const saved = logins.save(home, `before-switch-${stamp}`);
    if (!saved.ok && saved.reason !== "not_configured") {
      return { outcome: "failed_safely", reasons: ["outgoing_login_not_saved"],
        message: `The login active in ${home} couldn't be saved first (${saved.reason}), so nothing changed: no login was activated and the seat wasn't restarted.` };
    }
    const savedBefore = saved.ok ? saved.name : null;
    const report: SeatSwitchReport = { seat: input.seat, home, account: input.toAccount, loginChanged: false, savedBefore,
      undo: savedBefore ? `rig auth switch --codex-home ${home} ${savedBefore}` : null, peers: withRestartSteps(peers, input.toAccount) };
    const activated = logins.activate(home, input.toAccount);
    if (!activated.ok) {
      return { outcome: "failed_safely", reasons: ["login_not_activated"], seat: report,
        message: `The login "${input.toAccount}" couldn't be activated in ${home} (${activated.reason}); nothing was restarted.` };
    }
    report.loginChanged = true;
    const key = resolvedHome(home);
    homeSwitches.set(key, { count: (homeSwitches.get(key)?.count ?? 0) + 1, seat: input.seat });
    const restart = await seatRestart.run(input.seat, `rig provider switch --to-account ${input.toAccount}`);
    // The seat's name now reaches another seat (only a caller that selected it by node gets this): nothing was restarted,
    // and a restart by that name would reach the other seat, so none is offered.
    if (!restart.ok && restart.code === "seat_name_shared") {
      return { outcome: "unknown", reasons: ["seat_name_shared"], seat: report,
        message: `${home} now uses "${input.toAccount}", but ${restart.message} It and every other seat on this home keep their current login only until their next token refresh.${report.undo ? ` To switch the home back: ${report.undo}` : ""}` };
    }
    if (!restart.ok) {
      return { outcome: "failed_safely", reasons: ["login_changed_seat_not_restarted"], seat: report,
        message: `${home} now uses "${input.toAccount}", but ${input.seat} wasn't restarted (${restart.code}: ${restart.message}). It and every other seat on this home keep their current login only until their next token refresh, when Codex stops them with "signed in to another account" until they're restarted: rig seat restart ${input.seat} --keep-conversation ${movedReason(input.toAccount)}.${report.undo ? ` To switch the home back: ${report.undo}` : ""}` };
    }
    const outcome = restart.outcome ?? "native_unknown";
    report.restart = { outcome, message: restart.message,
      ...(restart.recoveryCommand ? { recoveryCommand: restart.recoveryCommand } : {}), ...(restart.remainingStep ? { remainingStep: restart.remainingStep } : {}) };
    report.peers = withRestartSteps(restart.peers, input.toAccount);
    if (outcome === "restarted_account_unverified") {
      report.next = `After the seat completes a turn with a tool call: rig seat restart ${input.seat} --keep-conversation --verify --expect-account <text its /status shows for "${input.toAccount}">`;
      return { outcome: "rebind_in_progress", seat: report,
        message: `Restarted ${input.seat} in place on "${input.toAccount}" in ${home}; the account isn't verified until a tool turn and its account line are seen.` };
    }
    return { outcome: "unknown", reasons: [`restart_${outcome}`], seat: report, message: `${restart.message} Not retried.` };
  }

  private codexLogins(): CodexHomeLogins {
    return this.deps.codexLogins ?? codexHomeLogins;
  }
}
