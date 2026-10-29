import { shellQuote } from "../../adapters/shell-quote.js";
import { claudeSeatTokenFileProblem, claudeSeatTokenRefProblem, isClaudeSeatTokenFallback, type ClaudeSeatTokenRef } from "../claude-seat-token.js";
import type { ClaudeSwitchView, PrecheckReason, PrecheckResult } from "./provider-types.js";
import type { ClaudeCredentialPrecedence, ClaudeSeatRelaunch, ProviderPrecheckInput, ProviderSwitchInput, ProviderSwitchResult, SeatSwitchReport } from "./provider-service.js";

/** The account a Claude seat moves to when it goes back to its config dir's stored login (no token reference). */
export const STORED_LOGIN = "stored-login";

type ClaudeSeat = NonNullable<ReturnType<ClaudeSeatRelaunch["seat"]>>;
type NextLaunch = ClaudeSeatRelaunch["nextLaunch"];
type ClaudeCheck =
  | { ok: false; verdict: Extract<PrecheckResult, { safe: false }> }
  | { ok: true; verdict: Extract<PrecheckResult, { safe: true }>; ref: ClaudeSeatTokenRef | null; instead: string | null;
    next?: Extract<ReturnType<NextLaunch>, { resumes: true }> };

/** A Claude seat's checks, before anything changes: the reference it would get, that its file would give Claude the token,
 *  that nothing Claude Code ranks above the token is set, and for a stopped seat that its next launch resumes its
 *  conversation. A move back to the stored login also
 *  finds a `CLAUDE_CODE_OAUTH_TOKEN` the seat would still receive, and says it's what the seat will use. Managed settings (a
 *  file, MDM or the server) can't be read; the relaunched seat's /status covers them. */
export async function checkClaudeSeat(input: ProviderPrecheckInput, seat: ClaudeSeat, precedence: ClaudeCredentialPrecedence | undefined,
  nextLaunch?: NextLaunch): Promise<ClaudeCheck> {
  const refuse = (reason: PrecheckReason, message: string, claude?: ClaudeSwitchView): ClaudeCheck =>
    ({ ok: false, verdict: { safe: false, reasons: [reason], message, ...(claude ? { claude } : {}) } });
  if (!precedence) return refuse("rebind_unsupported_for_runtime", "This daemon can't check what would outrank a Claude seat's own token, so it doesn't move Claude seats.");
  if (input.apiKeyFile !== undefined && input.tokenFile !== undefined) return refuse("invalid_token_reference", "Choose --api-key-file or a subscription token/stored login, not both.");
  if (input.tokenFile === undefined && input.apiKeyFile === undefined) {
    return refuse("token_file_required", "A Claude seat moves to its own subscription token with --to-account <label> --token-file <absolute path to a 0600 "
      + "file holding the token>, or back to its config dir's stored login with --stored-login.");
  }
  const ref: ClaudeSeatTokenRef | null = input.apiKeyFile !== undefined
    ? { label: input.toAccount, tokenFile: input.apiKeyFile, kind: "api-key" }
    : input.tokenFile === null ? null : { label: input.toAccount, tokenFile: input.tokenFile! };
  if (ref) {
    const problem = claudeSeatTokenRefProblem(ref);
    if (problem) return refuse("invalid_token_reference", `${problem}.`);
    const fileProblem = claudeSeatTokenFileProblem(ref);
    if (fileProblem) return refuse("token_file_unusable", `${fileProblem}, so Claude would start without it. Nothing changed.`);
  }
  const found = await precedence(seat.nodeId, ref?.kind === "api-key" ? { apiKey: true } : ref ? {} : { storedLogin: true });
  const instead = found.instead?.length
    ? `the CLAUDE_CODE_OAUTH_TOKEN from ${found.instead.map((c) => `${c.source} (${c.remedy})`).join("; ")}` : null;
  const claude: ClaudeSwitchView = { ...(ref?.kind ? { credentialKind: ref.kind } : {}), label: ref?.label ?? STORED_LOGIN, tokenFile: ref?.tokenFile ?? null, checked: found.checked, notChecked: found.notChecked,
    ...(instead ? { instead } : {}) };
  if (found.conflicts.length) {
    return refuse("credential_outranks_token", "Claude Code would use these instead, so nothing changed: "
      + `${found.conflicts.map((c) => `${c.name} (${c.source}; ${c.remedy})`).join("; ")}.`, claude);
  }
  if (!seat.running && nextLaunch) {
    const next = nextLaunch(seat.rigId, seat.nodeId);
    if (!next.resumes) {
      return refuse("conversation_not_resumable", `${input.seat} isn't running, and ${next.snapshotId ? `snapshot ${next.snapshotId}, which its next launch uses,` : "its next launch"} `
        + `${next.why}, so it wouldn't resume its conversation. Nothing changed.`, claude);
    }
    return { ok: true, verdict: { safe: true, claude }, ref, instead, next };
  }
  return { ok: true, verdict: { safe: true, claude }, ref, instead };
}

/** Move one Claude seat in its own pane, by restore's own resume path: under the seat's lifecycle lease, a snapshot taken
 *  now that resumes the seat, its token reference set, then only that seat relaunched from that snapshot in its pane (its
 *  process ended in place, the pane and its scrollback kept), which reruns `claude --resume <its conversation>` with the
 *  seat's token step. Only a refusal before the seat's process was touched reads as unchanged; anything after it that
 *  doesn't report a resumed conversation reads `unknown`, with the snapshot's recovery, and is never retried. A stopped seat
 *  isn't relaunched: its reference is set for its next launch, only when that launch resumes its conversation. */
export async function switchClaudeSeat(input: ProviderSwitchInput, relaunch: ClaudeSeatRelaunch, seat: ClaudeSeat,
  precedence: ClaudeCredentialPrecedence | undefined): Promise<ProviderSwitchResult> {
  let touched = false;
  try {
    return await relaunch.exclusive<ProviderSwitchResult>(seat.nodeId, async () => {
      // A switch that waited for the seat goes on with the seat as it is now.
      const current = relaunch.seat(input.seat);
      if (!current || current.nodeId !== seat.nodeId) {
        return { outcome: "failed_safely", reasons: ["seat_changed"], message: `${input.seat} changed while this switch waited for it. Nothing changed.` };
      }
      return await switchHeld(input, relaunch, current, precedence, () => { touched = true; });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!touched) {
      const code = (err as { code?: unknown }).code;
      return { outcome: "failed_safely", reasons: [typeof code === "string" ? code : "seat_unavailable"],
        message: `${input.seat} couldn't be switched (${message}). Nothing changed.` };
    }
    // Its reference was set before the error; what the seat runs isn't known.
    return { outcome: "unknown", reasons: ["relaunch_threw"],
      seat: { seat: input.seat, account: input.tokenFile === null ? STORED_LOGIN : input.toAccount, ...(input.apiKeyFile ? { credentialKind: "api-key", tokenFile: input.apiKeyFile } : {}), loginChanged: true, peers: [], undo: null },
      message: `${input.seat}'s relaunch stopped with an error after its process may have been ended (${message}). Check the pane with rig capture ${input.seat}. Not retried.` };
  }
}

async function switchHeld(input: ProviderSwitchInput, relaunch: ClaudeSeatRelaunch, seat: ClaudeSeat,
  precedence: ClaudeCredentialPrecedence | undefined, touching: () => void): Promise<ProviderSwitchResult> {
  const checked = await checkClaudeSeat(input, seat, precedence, (rigId, nodeId) => relaunch.nextLaunch(rigId, nodeId));
  if (!checked.ok) {
    const { reasons, message } = checked.verdict;
    return { outcome: "failed_safely", reasons: reasons as [string, ...string[]], ...(message ? { message } : {}) };
  }
  const { nodeId, rigId, rigName, logicalId } = seat;
  const before = relaunch.tokenRef(nodeId);
  const account = checked.ref?.label ?? STORED_LOGIN;
  const reportFor = (conversation: string | null): SeatSwitchReport => ({ seat: input.seat, account, ...(checked.ref?.kind ? { credentialKind: checked.ref.kind } : {}),
    ...(checked.ref ? { tokenFile: checked.ref.tokenFile } : {}), conversation, loginChanged: false, peers: [],
    // The label's characters are limited; a path can hold any but a newline, so it's quoted.
    undo: before
      ? `rig provider switch --seat ${input.seat} --to-account ${before.label} ${before.kind === "api-key" ? "--api-key-file" : "--token-file"} ${shellQuote(before.tokenFile)}`
      : `rig provider switch --seat ${input.seat} --stored-login` });
  if (!seat.running) {
    // Nothing to relaunch: the reference is saved for the seat's next launch, which the check found resumes its
    // conversation. No snapshot is taken, so the one checked is the one `rig launch` selects.
    const next = checked.next;
    if (!next) return { outcome: "failed_safely", reasons: ["conversation_not_resumable"], message: `${input.seat} isn't running, and its next launch couldn't be checked. Nothing changed.` };
    relaunch.setTokenRef(nodeId, checked.ref);
    const report = reportFor(next.conversation);
    report.loginChanged = true;
    // A resume through restore's automatic periodic carry needs the plain launch: naming the snapshot turns the carry off.
    const launch = `rig launch ${rigName} ${logicalId}${next.automatic ? "" : ` --snapshot-id ${next.snapshotId}`}`;
    const uses = checked.ref ? `its token reference "${account}"`
      : checked.instead ? `${checked.instead}, which Claude Code ranks above its config dir's stored login` : "its config dir's stored login";
    report.next = `${launch} resumes conversation ${next.conversation ?? "(not recorded in the snapshot)"} with ${uses}`
      + `${next.automatic ? ` (it selects the latest usable snapshot, ${next.snapshotId} now, and resumes through its periodic carry)` : ""}. `
      + (checked.instead ? "After a turn with a tool call, its /status shows the token it uses (CLAUDE_CODE_OAUTH_TOKEN), not the stored login."
        : "Check its /status after a turn with a tool call.");
    return { outcome: "succeeded", seat: report,
      message: `${input.seat} isn't running, so nothing was relaunched. Its next launch uses ${uses}: ${launch}.` };
  }
  if (!seat.pane) {
    return { outcome: "failed_safely", reasons: ["no_bound_pane"], message: `${input.seat} has no bound tmux pane to relaunch it in. Nothing changed.` };
  }
  const snapshot = relaunch.snapshot(rigId, nodeId);
  if (!snapshot.resumes) {
    return { outcome: "failed_safely", reasons: ["conversation_not_resumable"],
      message: `Snapshot ${snapshot.snapshotId} ${snapshot.why}, so relaunching ${input.seat} wouldn't resume its conversation. Nothing changed.` };
  }
  const report = reportFor(snapshot.conversation);
  touching();
  relaunch.setTokenRef(nodeId, checked.ref);
  let relaunched: Awaited<ReturnType<ClaudeSeatRelaunch["relaunchInPane"]>>;
  try { relaunched = await relaunch.relaunchInPane(rigId, logicalId, snapshot.snapshotId); }
  catch (err) { relaunched = { ok: false, effect: "unknown", code: "relaunch_threw", message: err instanceof Error ? err.message : String(err) }; }
  if (!relaunched.ok && relaunched.effect === "none") {
    relaunch.setTokenRef(nodeId, before);
    return { outcome: "failed_safely", reasons: [`relaunch_${relaunched.code.replace(/-/g, "_")}`], seat: report,
      message: `${input.seat} wasn't relaunched (${relaunched.code}: ${relaunched.message}) and wasn't touched, so it keeps running as it was, with its token reference as it was.` };
  }
  report.loginChanged = true;
  if (!relaunched.ok) {
    const recoveryCommand = `rig launch ${rigName} ${logicalId} --snapshot-id ${snapshot.snapshotId}`;
    report.restart = { outcome: relaunched.code, message: relaunched.message, recoveryCommand,
      remainingStep: `Inspect the pane (rig capture ${input.seat}). If a leftover shell/session remains without a running Claude, stop it first (rig seat stop ${input.seat} --reason "<why>"). `
        + `If the session is already absent, run the recovery command directly; it resumes the conversation from snapshot ${snapshot.snapshotId} with the new reference. The way back works once the seat runs.` };
    return { outcome: "unknown", reasons: [relaunched.code === "relaunch_threw" ? "relaunch_threw" : `relaunch_${relaunched.code.replace(/-/g, "_")}`], seat: report,
      message: `${input.seat}'s relaunch in its pane from snapshot ${snapshot.snapshotId} didn't report a resumed conversation (${relaunched.code}: ${relaunched.message}). `
        + "Its process may have been ended. Not retried." };
  }
  const fallback = relaunched.warnings.filter(isClaudeSeatTokenFallback);
  report.warnings = relaunched.warnings;
  report.restart = { outcome: "resumed", message: `Resumed conversation ${snapshot.conversation ?? "(not recorded in the snapshot)"} in the seat's own pane.` };
  if (checked.ref?.kind === "api-key") {
    report.tokenApplied = fallback.length === 0;
    report.next = "After a real tool turn, check the seat's /status for API-key authentication. The label is operator-supplied; OpenRig does not verify the billing account or enforce a budget.";
    return { outcome: "rebind_in_progress", seat: report,
      message: `Relaunched ${input.seat} on its selected API-key file, resuming conversation ${snapshot.conversation ?? "from the snapshot"} in its own pane. Work in flight when it stopped didn't carry over.` };
  }
  if (checked.ref) {
    report.tokenApplied = fallback.length === 0;
    report.next = report.tokenApplied
      ? `After the seat completes a turn with a tool call, its /status shows the auth method it uses: the token (CLAUDE_CODE_OAUTH_TOKEN), with no account email. "${account}" is your label for it; Claude doesn't name the account.`
      : `Fix the token file, then relaunch the seat (or switch it again); until then its /status shows the login it uses instead.`;
    return { outcome: "rebind_in_progress", seat: report, message: report.tokenApplied
      ? `Relaunched ${input.seat} in its own pane on its own token ("${account}"), resuming its conversation. Work in flight when it stopped didn't carry over.`
      : `Relaunched ${input.seat} in its own pane, resuming its conversation, and saved its token reference ("${account}"), but the token didn't take effect: ${fallback.join(" ")}` };
  }
  report.next = checked.instead
    ? `After the seat completes a turn with a tool call, its /status shows the token it uses (CLAUDE_CODE_OAUTH_TOKEN), not the stored login.`
    : `After the seat completes a turn with a tool call, its /status shows the auth method it uses: its config dir's stored login, unless its pane shell exports a token.`;
  return { outcome: "rebind_in_progress", seat: report, message: checked.instead
    ? `Relaunched ${input.seat} in its own pane without its own token, resuming its conversation. It uses ${checked.instead}, which Claude Code ranks above its config dir's stored login.`
    : `Relaunched ${input.seat} in its own pane on its config dir's stored login, resuming its conversation. Work in flight when it stopped didn't carry over.` };
}
