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
import { readCodexAuthMetadata, type CodexAuthMetadata } from "./codex-auth-reader.js";
import { collectFourBlockReadModel, type ProviderSeat } from "./provider-collect.js";
import { configuredSeatAccounts } from "./provider-seat-accounts.js";
import { precheckSwitch } from "./provider-policy.js";
import { collectReactiveEventSignals } from "./reactive-tap.js";
import type { CodexUsageWindows } from "./codex-usage-windows.js";
import type { ClaudeUsageWindows } from "./claude-usage-windows.js";
import type { UsageRefreshResult } from "./usage-windows.js";
import type {
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
import type { FourBlockReadModel, PrecheckResult, ProviderSignal } from "./provider-types.js";
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

export interface ProviderServiceImplDeps {
  db: Database.Database;
  /** The rig universe (rigRepo.listRigs()) — each rig's node-inventory contributes seats. */
  listRigs: () => Array<{ id: string }>;
  /** Slice-04 C3: the Claude statusline provider_usage signal source (undefined → signals []). */
  collectClaudeSignals?: () => ProviderSignal[];
  /** Slice-04 C4: the shipped structured activity detector. Undefined keeps the reactive lane empty. */
  agentActivityStore?: Pick<AgentActivityStore, "getLatestForNode">;
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
}

export class ProviderServiceImpl implements ProviderService {
  constructor(private readonly deps: ProviderServiceImplDeps) {}

  async getReadModel(): Promise<FourBlockReadModel> {
    const env = this.deps.env ?? process.env;
    const asOf = (this.deps.now ?? (() => new Date().toISOString()))();
    let auth: CodexAuthMetadata | undefined;
    let seats: ProviderSeat[] | undefined;
    const readAuth = () => auth ??= readCodexAuthMetadata(env);
    const listSeats = () => seats ??= this.listSeats();
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
      codexHome: env.CODEX_HOME || nodePath.join(env.HOME ?? os.homedir(), ".codex"),
      claudeConfigDir: env.CLAUDE_CONFIG_DIR,
      home: env.HOME ?? os.homedir(),
    });
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
    const seats: ProviderSeat[] = [];
    for (const rig of this.deps.listRigs()) {
      for (const entry of getNodeInventory(this.deps.db, rig.id)) {
        if (!entry.canonicalSessionName) continue;
        const runtime = entry.runtime ?? "unknown";
        const runtimeHome = Object.hasOwn(RUNTIME_HOME_VAR, runtime)
          ? seatRuntimeHome(this.deps.db, entry.nodeId, runtime as HomeRuntime)
          : {};
        seats.push({
          seatSession: entry.canonicalSessionName,
          rigName: entry.rigName ?? "",
          runtime,
          lifecycleState: entry.lifecycleState,
          ...(runtimeHome.home || runtimeHome.ignored ? { runtimeHome } : {}),
        });
      }
    }
    return seats;
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
      return { ok: false, verdict: { safe: false, reasons: [plan.code === "not_codex" ? "rebind_unsupported_for_runtime" : "seat_restart_refused"],
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
    const restart = await seatRestart.run(input.seat, `rig provider switch --to-account ${input.toAccount}`);
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
