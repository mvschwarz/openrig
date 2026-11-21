import { accountHomePlanMatches } from "../lib/account-home-switch.js";
import fs from "node:fs";
import { Command } from "commander";
import { DaemonClient, DaemonTimeoutError } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { localSelfHostId, originFor, runOnSshHost, type RunOnHostDeps } from "../lib/run-on-host.js";

// Slice-04 (OPR.0.5.0.4) — the `rig provider` CLI verb surface (packet 3ffa3c22 §3), grammar per
// the auth.ts precedent (conventions/cli-read-command-grammar). Daemon-backed: reads/precheck go
// through the DaemonClient to the daemon's four-block read model + precheck; switch POSTs the
// orchestration route. NOTE: this CLI seam does NOT itself compose `rig auth` — it only calls the
// route; the real precheck-gated switch + rig-auth codex composition + durable action record live
// in the daemon routes/service (seams B/C/D), where seam D resolves the CLI-local auth
// composition/package boundary. Every verb is --json-stable for agents.

// The daemon answers the view across hosts within its own 15 s deadline, whatever the registry's size (hosts it hasn't
// heard from by then are listed as such). 15 s + 5 s for its own read model and the transfer = 20 s.
export const USAGE_ACROSS_HOSTS_READ_TIMEOUT_MS = 20_000;
// The refresh answers after its slowest leg (Codex 50 s; all legs run at once), with the same view by its 15 s
// deadline: 50 s + 15 s + a 10 s margin = 75 s.
export const USAGE_ACROSS_HOSTS_REFRESH_TIMEOUT_MS = 75_000;

type Peer = { logicalId: string; sessionName: string | null; home?: "same" | "different" | "unknown"; effect: string; step?: string };
type SeatView = { home?: string; activity?: string; peers: Peer[] };
type SwitchReport = { credentialKind?: "api-key"; home?: string; account: string; tokenFile?: string; conversation?: string | null; loginChanged: boolean; undo: string | null; peers: Peer[];
  restart?: { recoveryCommand?: string; remainingStep?: string }; next?: string; warnings?: string[]; tokenApplied?: boolean; effort?: string };

const VALID_ACCOUNT_PROVIDERS: readonly string[] = ["claude", "codex"];

// A switch waits as long as `rig seat restart` does: the seat's in-place restart runs inside it.
const SWITCH_TIMEOUT_MS = 120_000;

function printSeat(seat: SeatView): void {
  if (seat.home) console.log(`home: ${seat.home}`);
  if (seat.activity) console.log(`seat activity: ${seat.activity}`);
  for (const peer of seat.peers) {
    const where = peer.home === "same" ? "peer on this home" : peer.home === "different" ? "seat on another home" : "seat, home unknown";
    console.log(`${where}: ${peer.sessionName ?? peer.logicalId}: ${peer.effect}`);
    if (peer.step) console.log(`  then: ${peer.step}`);
  }
}

type AccountOpts = { toAccount?: string; tokenFile?: string; apiKeyFile?: string; storedLogin?: boolean };

/** The account a switch names: a Codex login's saved name, a Claude token's label with its file, or a Claude seat's stored
 *  login. Null when neither --to-account nor --stored-login was given. */
function targetAccount(opts: AccountOpts): { toAccount: string; tokenFile?: string | null; apiKeyFile?: string } | null {
  if (opts.apiKeyFile !== undefined && (opts.tokenFile !== undefined || opts.storedLogin)) return null;
  if (opts.storedLogin) return { toAccount: "stored-login", tokenFile: null };
  if (!opts.toAccount) return null;
  return { toAccount: opts.toAccount, ...(opts.tokenFile !== undefined ? { tokenFile: opts.tokenFile } : {}), ...(opts.apiKeyFile !== undefined ? { apiKeyFile: opts.apiKeyFile } : {}) };
}

function printClaude(claude: { credentialKind?: "api-key"; label: string; tokenFile: string | null; checked: string[]; notChecked: string[]; instead?: string }): void {
  console.log(`Claude ${claude.credentialKind === "api-key" ? "API key" : "token"}: ${claude.tokenFile ? `"${claude.label}", read from ${claude.tokenFile} when Claude starts` : "none (the config dir's stored login)"}`);
  if (claude.instead) console.log(`instead of the stored login, the seat would use ${claude.instead}`);
  if (claude.checked.length) console.log(`checked for anything that outranks it: ${claude.checked.join("; ")}`);
  if (claude.notChecked.length) console.log(`not checked (the seat's /status shows what it uses): ${claude.notChecked.join("; ")}`);
}

/** Build provider views and account switches; an isolated-home switch first requires the daemon to acknowledge its plan. */
export function providerCommand(depsOverride?: StatusDeps, remote: { host?: RunOnHostDeps; env?: NodeJS.ProcessEnv } = {}): Command {
  const cmd = new Command("provider").description(
    "Provider accounts and usage signals, and moving seats to another account: one seat with switch, a whole rig with assign",
  );
  const getDeps = (): StatusDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // Consistent HTTP error handling: print the daemon error payload, exit 1 for 4xx / 2 for 5xx.
  // A 4xx (e.g. 404 unknown provider / 400 invalid target) is an ERROR, never a success.
  function handleHttpError(res: { status: number; data: unknown }, label: string): boolean {
    if (res.status < 400) return false;
    const p = (res.data ?? {}) as { error?: unknown; errors?: unknown; message?: unknown };
    // Preserve the daemon's actionable explanation instead of showing only its error code.
    if (typeof p.message === "string" && p.message.trim()) console.error(p.message);
    else console.error(p.errors ?? p.error ?? `${label} failed (HTTP ${res.status})`);
    process.exitCode = res.status >= 500 ? 2 : 1;
    return true;
  }

  function minutesAgo(asOf: string, now: string): string {
    const delta = Date.parse(now) - Date.parse(asOf);
    if (Number.isNaN(delta)) return "unknown age";
    return `${Math.max(0, Math.round(delta / 60000))}m ago`;
  }

  // The locked §3 human `provider status` projection: account rows, first-class binding anomaly
  // flags, and a freshest-signal/asOf summary. --json stays verbatim (handled by the action).
  function renderStatusHuman(m: Record<string, unknown>): void {
    const accounts = (m["accounts"] as Array<Record<string, unknown>>) ?? [];
    const bindings = (m["bindings"] as Array<Record<string, unknown>>) ?? [];
    const signals = (m["signals"] as Array<Record<string, unknown>>) ?? [];
    const readAsOf = (m["asOf"] as string) ?? "";

    console.log("ACCOUNTS");
    for (const a of accounts) {
      const managed = a["profileRef"] ? `profile=${a["profileRef"]}` : "unmanaged";
      console.log(`  ${a["label"]} (${a["provider"]})  auth=${a["authState"]}  ${managed}`);
    }

    const seen = new Set<string>();
    const flags: string[] = [];
    for (const b of bindings) {
      for (const an of (b["anomalies"] as Array<Record<string, unknown>>) ?? []) {
        if (an["kind"] === "same_account_on_n_seats") {
          const seats = (an["seats"] as string[]) ?? [];
          const key = `sa:${seats.join(",")}`;
          if (!seen.has(key)) { seen.add(key); flags.push(`  ! same account on ${an["count"]} seats: ${seats.join(", ")}`); }
        }
        // An older daemon's seat_with_no_account marks every row with no Codex registry placement, which isn't
        // evidence the seat has no account, so it isn't flagged. The row's null accountId still says it.
      }
    }
    if (flags.length) { console.log("ANOMALIES"); for (const f of flags) console.log(f); }

    if (signals.length) {
      const freshest = signals.reduce((a, b) => ((a["asOf"] as string) >= (b["asOf"] as string) ? a : b));
      console.log(`SIGNALS (${signals.length}; freshest ${minutesAgo(freshest["asOf"] as string, readAsOf)})`);
    } else {
      console.log("SIGNALS: none");
    }

    // S-C (OPR.0.5.0.4-C) — host-level usage rollup on the EXISTING `provider status` verb (PM: no
    // new verb). The rows arrive verbatim via /api/provider/status; --json emits them unchanged, so
    // the human projection here is the parity surface. Honesty AT THE RENDER: state as-is (an
    // explicit_unknown reads "unknown", never blank/ok), C3 window granularity kept, the conflict
    // anomaly shown both-facts-visible (never a silent merge), the deployment-invariant provenance
    // label surfaced, and NO account identity emitted (the rows carry none — keys are host+provider).
    const hostUsage = (m["hostUsage"] as Array<Record<string, unknown>>) ?? [];
    if (hostUsage.length) {
      console.log("HOST USAGE");
      for (const r of hostUsage) {
        const state = r["state"] as string;
        const label = state === "explicit_unknown" ? "unknown" : state;
        const wins = ((r["windows"] as Array<Record<string, unknown>>) ?? [])
          .map((w) => `${w["window"]} ${w["usedPercent"] ?? "?"}%`).join(", ");
        let line = `  ${r["provider"]}  ${label}`;
        if (state === "limited" && r["resetsAt"]) line += `  until ${r["resetsAt"]}`;
        if (state === "explicit_unknown" && r["unknownReason"]) line += `  (${r["unknownReason"]})`;
        if (wins) line += `  [${wins}]`;
        console.log(line);
        for (const an of (r["anomalies"] as Array<Record<string, unknown>>) ?? []) {
          if (an["kind"] === "conflicting_seat_windows") {
            const seats = (an["seats"] as string[]) ?? [];
            console.log(`    ! conflict (${an["window"]}): ${seats.join(" vs ")} — ${an["evidence"]}  [invariant falsified for this host]`);
          }
        }
      }
      const prov = hostUsage[0]?.["provenance"] as Record<string, unknown> | undefined;
      if (prov?.["note"]) console.log(`  provenance: ${prov["note"]}`);
    }

    // Slice 01 — observed usage windows (present only while provider.usage_windows is on). Level and
    // freshness print side by side, each window with its own observation time; a failed refresh
    // prints beside the kept reading.
    if (Array.isArray(m["usage"])) renderUsage(m["usage"] as Array<Record<string, unknown>>);
    if (Array.isArray(m["seatAccounts"])) renderSeatAccounts(m["seatAccounts"] as Array<Record<string, unknown>>);
    // #3625 — without the seat accounts (usage windows off), the seats with an assignment or a result print on their own.
    else {
      const assigned = bindings.filter((b) => assignmentLines(b).length > 0);
      if (assigned.length) {
        console.log("ASSIGNMENTS (configured account against the rig's assignment; not proof of the login a running session uses)");
        for (const b of assigned) {
          console.log(`  ${b["seatSession"]}  ${b["runtime"]}  ${configuredText((b["configured"] ?? {}) as Record<string, unknown>, follows(b))}`);
          for (const line of assignmentLines(b)) console.log(line);
        }
      }
    }
  }

  // Slice 01 — each seat's configured account and its source (present only while provider.usage_windows is on).
  // Configuration, never an observed account: the allowance stays unlinked, with the reason.
  // A failure's reason and detail as served. Both are optional in the read model: an absent reason reads "no reason
  // given" and an absent detail drops its clause, never "undefined". When both are served the text is unchanged.
  function failureText(f: Record<string, unknown>): string {
    return `${f["reason"] ?? "no reason given"}${f["detail"] !== undefined ? ` (${f["detail"]})` : ""}`;
  }

  // #3625: who set a rig's assignment. A request from outside any seat (e.g. rig run from a plain shell) stores none.
  function setBy(requestedBy: unknown): string { return typeof requestedBy === "string" && requestedBy ? requestedBy : "a caller that isn't a seat"; }

  // A seat that follows its rig's assignment has that account in its own file or home: worded as the assignment, not as a
  // choice of its own.
  function configuredText(c: Record<string, unknown>, follows = false): string {
    return c["source"] === "registry"
        ? `configured: profile ${c["profileRef"]} (registry, recorded ${c["recordedAt"]}${c["profileSaved"] === false ? "; profile not saved on this host" : c["profileSaved"] === null ? "; whether the profile is saved: unknown" : ""})`
        : c["source"] === "claude_token"
          ? `configured: ${c["kind"] === "api-key" ? "API key" : "token"} ${c["label"]} (${follows ? "its credential file, as the rig is assigned" : "the seat's own credential file"})`
        : c["source"] === "default_login" && c["homeFrom"]
          ? `configured: ${follows ? "the seat's home" : "the seat's own home"} (${c["home"]}, from its ${c["homeFrom"]} env${follows ? ", as the rig is assigned" : ""})`
        : c["source"] === "default_login"
          ? `configured: default login${c["home"] ? ` (${c["home"]})` : ""}`
          : `configured: unknown (${c["reason"]})`;
  }

  // #3625 slice 4 — a seat against its rig's assignment: what the rig is assigned, where this seat's configuration stands
  // against it, and its last applied result. Configuration and stored results, never the login a session uses. Nothing
  // prints for a seat whose rig has no assignment and that has no result.
  // A seat not on its rig's assignment, worded from its last result: none, one that moved it to an earlier assignment, an
  // unknown one (which may have moved it), or one that didn't move it.
  function notAppliedText(intended: Record<string, unknown> | null, applied: Record<string, unknown> | null): string {
    if (!applied) return "not applied to this seat yet";
    if (applied["kind"] === "unknown") return "this seat isn't known to be configured as assigned: its last result is unknown and may have moved it (see its recovery)";
    if ((applied["kind"] === "switched" || applied["kind"] === "pending_successor") && applied["label"] !== intended?.["label"]) {
      return `this seat isn't configured as assigned yet: its last result moved it to ${applied["label"]}, an earlier assignment`;
    }
    return "this seat isn't configured as assigned: its last result didn't move it";
  }

  const follows = (r: Record<string, unknown>) => (r["assignment"] as Record<string, unknown> | undefined)?.["state"] === "follows";

  function assignmentLines(r: Record<string, unknown>): string[] {
    const a = r["assignment"] as Record<string, unknown> | undefined;
    if (!a || (a["state"] === "no_assignment" && !a["applied"])) return [];
    const intended = a["intended"] as Record<string, unknown> | null;
    const applied = a["applied"] as Record<string, unknown> | null;
    const standing = a["state"] === "follows" ? (a["asApplied"] ? `this seat is still as the apply of ${intended?.["label"]} left its home` : "this seat is configured as assigned")
      : a["state"] === "override" ? `this seat is configured with its own choice: ${a["override"] ?? "another account"}`
        : a["state"] === "not_applied" ? notAppliedText(intended, applied)
          : "";
    const lines = [intended
      ? `    assignment: rig ${r["rigName"]}'s ${a["provider"]} seats to ${intended["label"]} (${intended["reference"]}), set ${intended["at"]} by ${setBy(intended["requestedBy"])}; ${standing}`
      : `    assignment: none for rig ${r["rigName"]}'s ${a["provider"]} seats`];
    if (applied) {
      lines.push(`    last applied: ${String(applied["kind"]).replace(/_/g, "-")} (${applied["label"]}, ${applied["at"]}): ${applied["detail"]}`);
      if (applied["recovery"]) lines.push(`      recovery: ${applied["recovery"]}`);
    }
    return lines;
  }

  function renderSeatAccounts(rows: Array<Record<string, unknown>>, where = ""): void {
    console.log(`SEATS${where} (configured account; not proof of the login a running session uses)`);
    for (const r of rows) {
      const c = (r["configured"] ?? {}) as Record<string, unknown>;
      const configured = configuredText(c, follows(r));
      const allowance = (r["allowance"] ?? {}) as Record<string, unknown>;
      console.log(`  ${r["seatSession"]}  ${r["runtime"]}  ${configured} · allowance not linked`);
      if (c["source"] === "default_login" && c["homeNote"]) console.log(`    ${c["homeNote"]}`);
      if (c["source"] === "claude_token" && c["note"]) console.log(`    ${c["note"]}`);
      const ignored = r["ignoredHome"] as Record<string, unknown> | undefined;
      if (ignored) console.log(`    ignored: its ${ignored["from"]} env sets ${ignored["variable"]}=${ignored["value"]}, which isn't an absolute path, so it isn't used as this seat's home`);
      for (const note of (r["registryNotes"] as string[] | undefined) ?? []) console.log(`    ${note}`);
      const observed = r["observed"] as Record<string, unknown> | undefined;
      const differs = (observed?.["differsFrom"] as string[] | undefined) ?? [];
      if (differs.length) console.log(`    observed: differs from ${differs.join(", ")}${observed?.["note"] !== undefined ? ` (${observed["note"]})` : ""}`);
      else if (observed?.["windowsSampled"] === true) console.log(`    observed: this seat's status line last reported windows at ${observed["lastSampledAt"] ?? "an unknown time"}`);
      else if (observed?.["windowsSampled"] === false) console.log("    observed: no status-line windows from this seat yet");
      else if (observed?.["note"]) console.log(`    observed: ${observed["note"]}`);
      if (allowance["reason"]) console.log(`    allowance not linked: ${allowance["reason"]}`);
      for (const line of assignmentLines(r)) console.log(line);
    }
  }

  function windowName(w: Record<string, unknown>): string {
    const mins = w["durationMins"];
    const label = mins === 300 ? "5h" : mins === 10080 ? "weekly" : typeof mins === "number" ? `${mins} min` : null;
    return label ? `${label} (${w["window"]})` : String(w["window"]);
  }

  function identityLabel(id: Record<string, unknown>): string {
    // Codex: account, else the workspace account/read reported; Claude: the organisation and email auth status
    // reported at the last refresh; else unresolved. For Codex the email is a label.
    return id["source"] === "configured credential label" ? `credential ${id["credentialLabel"]} (operator label)` : id["accountId"] ? `account ${id["accountId"]}`
      : id["workspaceId"] ? `workspace ${id["workspaceId"]} (from account/read; no usage account id)`
        : id["source"] !== "unresolved" && id["orgId"] ? `organisation ${id["orgName"] ? `${id["orgName"]} (${id["orgId"]})` : id["orgId"]}`
          : "identity unresolved";
  }

  function renderUsage(rows: Array<Record<string, unknown>>): void {
    console.log("USAGE (read on request: rig provider status --refresh)");
    for (const r of rows) renderUsageRow(r);
    const saved = rows.find((r) => r["savedProfiles"])?.["savedProfiles"] as Record<string, unknown> | undefined;
    if (saved) console.log(`  ${saved["note"]}: ${((saved["names"] as string[]) ?? []).join(", ")}`);
  }

  /** The row's retained history: last observed exhaustion, the account link, and an inactive account's profile. */
  function historyLines(r: Record<string, unknown>): string[] {
    const out: string[] = [];
    const ex = r["lastObservedExhausted"] as Record<string, unknown> | null | undefined;
    if (ex) out.push(`last observed exhausted at ${ex["at"]} (${ex["window"] ?? "account-level"}: ${ex["evidence"]})`);
    if (r["accountHistory"] === "unknown") out.push("account history unknown");
    if (r["savedProfile"] === "not linked") out.push("saved profile: not linked (OpenRig doesn't record which saved profile was active at this read)");
    return out;
  }

  /** The row's sign-in fact, as served; nothing when an older daemon doesn't serve it. */
  function signInLine(r: Record<string, unknown>): string | null {
    const s = r["signIn"] as Record<string, unknown> | undefined;
    if (!s) return null;
    const state = s["state"] === "needs_sign_in" ? "needs sign-in" : String(s["state"]);
    return `sign-in: ${state} (${s["evidence"]}${s["at"] ? `; as of ${s["at"]}` : ""})`;
  }

  function renderUsageRow(r: Record<string, unknown>, pad = "  "): void {
    const id = r["identity"] as Record<string, unknown> | null;
    if (!id) {
      console.log(`${pad}${r["provider"]}  unavailable: ${r["unavailableReason"] ?? "no reading"}`);
      // A row with no identity yet can still carry history (Claude's before its first identity refresh): before sign-in,
      // as on an identified row.
      for (const line of historyLines(r)) console.log(`${pad}  ${line}`);
      const signIn = signInLine(r);
      if (signIn) console.log(`${pad}  ${signIn}`);
      return;
    }
    // Identity first; for Codex the email is a label.
    const labels = [identityLabel(id), `bucket ${id["limitId"]}`, id["email"] ?? "email not reported", id["planType"], id["subscriptionType"], `seats ${r["seats"] ?? "unknown"}`]
      .filter((x) => x !== null && x !== undefined);
    // Not from the latest read: say only that. A later read proves no other account (an unresolved read
    // may be this same login), so the label names the read, not an account.
    const earlier = r["latestFromSource"] ? ""
      : r["retained"] === "before_restart" ? "  [kept from before the daemon restarted; not a current reading]"
      : id["source"] === "unresolved" ? "  [from an earlier read; possibly this same login]"
        : "  [from an earlier read; the latest read didn't match this row]";
    console.log(`${pad}${r["provider"]}  ${labels.join(" · ")}${earlier}`);
    if (r["probe"]) console.log(`${pad}  token probe: ${JSON.stringify(r["probe"])}`);
    if (r["identityNote"]) console.log(`${pad}  ${r["identityNote"]}`);
    const unresolved = r["unresolved"] as Record<string, unknown> | undefined;
    if (unresolved) {
      const dropped = Number(unresolved["droppedReads"] ?? 0);
      console.log(`${pad}  not matched to, merged with or replacing any other row; kept from the ${unresolved["keptReads"]} most recent unresolved reads${dropped > 0 ? ` (${dropped} older dropped)` : ""}`);
    }
    for (const w of (r["windows"] as Array<Record<string, unknown>>) ?? []) {
      const left = w["remainingPercent"] === null ? "?% left" : `${w["remainingPercent"]}% left`;
      const level = w["levelReason"] ? `${w["level"]} (${w["levelReason"]})` : String(w["level"]);
      const fresh = w["freshnessReason"] ? `${w["freshness"]}: ${w["freshnessReason"]}` : String(w["freshness"]);
      const seat = w["seatSession"] ? ` by seat ${w["seatSession"]}` : "";
      console.log(`${pad}  ${windowName(w)}  ${left}  ${level}  resets ${w["resetsAt"] ?? "unknown"}  observed ${w["observedAt"]}${seat} (${fresh})${w["status"] ? ` · provider ${w["status"]}` : ""}`);
      for (const d of (w["disagreeingSeats"] as Array<Record<string, unknown>> | undefined) ?? []) {
        console.log(`${pad}    seat ${d["seatSession"]} reports ${Math.max(0, 100 - Number(d["usedPercent"]))}% left  resets ${d["resetsAt"] ?? "unknown"}  observed ${d["observedAt"]}`);
      }
      const expect = w["expectation"] as Record<string, unknown> | undefined;
      if (expect) console.log(`${pad}    expected full since ${expect["expectedFullSince"]}, not yet observed (${expect["note"]})`);
    }
    for (const line of historyLines(r)) console.log(`${pad}  ${line}`);
    if (r["unavailableReason"]) console.log(`${pad}  ${r["unavailableReason"]}`);
    if (r["limitEvidence"]) console.log(`${pad}  limit evidence: ${r["limitEvidence"]}`);
    const last = r["lastRefresh"] as Record<string, unknown> | null;
    if (last?.["outcome"] === "failed") {
      // Claude's refresh reads identity only; its windows keep coming from the seats' samples.
      console.log(r["provider"] === "claude" && (r["source"] as Record<string, unknown> | undefined)?.["kind"] !== "claude_token_probe"
        ? `${pad}  identity refresh failed at ${last["at"]}: ${failureText(last)}; the identity shown is from the last refresh that worked, if any`
        : `${pad}  refresh failed at ${last["at"]}: ${failureText(last)}; last reading kept, marked old`);
    }
    console.log(`${pad}  current availability: ${r["currentAvailability"]}`);
    const signIn = signInLine(r);
    if (signIn) console.log(`${pad}  ${signIn}`);
  }

  // Slice 01 — usage across registered hosts, as the daemon serves it: each host's status and whether it serves usage
  // windows, then one entry per allowance with every host's own observation (never summed), then each host's
  // configured seats. Nothing here re-derives a level, a freshness or a link.
  function renderAcrossHosts(v: Record<string, unknown>): void {
    console.log("USAGE ACROSS HOSTS (what each host already holds; read them now: rig provider status --all-hosts --refresh)");
    console.log("HOSTS");
    for (const h of (v["hosts"] as Array<Record<string, unknown>>) ?? []) {
      const transport = h["status"] === "ok" ? "answered" : `${h["status"]}${h["error"] ? ` (${h["error"]})` : ""}`;
      const usage = h["usage"] === "served" ? "usage windows served" : `usage ${h["usage"]}${h["usageReason"] ? `: ${h["usageReason"]}` : ""}`;
      console.log(`  ${h["hostId"]}  ${transport} · ${usage}${h["readAt"] ? ` · read ${h["readAt"]}` : ""}`);
      const last = (h["lastRefresh"] ?? {}) as Record<string, Record<string, unknown>>;
      for (const leg of Object.values(last)) {
        console.log(leg["outcome"] === "failed"
          ? `    refresh from here (${leg["provider"]}) failed at ${leg["at"]}: ${failureText(leg)}; this host's earlier observations are kept`
          : `    refresh from here (${leg["provider"]}) answered at ${leg["at"]}`);
      }
    }
    for (const s of (v["skipped"] as Array<Record<string, unknown>>) ?? []) console.log(`  ${s["hostId"]}  skipped: ${s["reason"]}`);
    const registry = (v["registry"] ?? {}) as Record<string, unknown>;
    if (registry["state"] !== "read") console.log(`  host registry ${registry["state"]}${registry["note"] ? `: ${registry["note"]}` : ""}`);
    console.log("ALLOWANCES (one entry per allowance; each host's observation kept as that host served it, never summed)");
    for (const g of (v["items"] as Array<Record<string, unknown>>) ?? []) {
      const obs = (g["observations"] as Array<Record<string, unknown>>) ?? [];
      const hosts = [...new Set(obs.map((o) => String(o["hostId"])))];
      const first = (obs[0]?.["row"] ?? {}) as Record<string, unknown>;
      const id = first["identity"] as Record<string, unknown> | null;
      const linkage = g["linkage"] === "same" ? `the same allowance on ${hosts.length} hosts: ${hosts.join(", ")}`
        : g["linkage"] === "conflict" ? `the same allowance on ${hosts.length} hosts, disagreeing: ${hosts.join(", ")}`
          : g["linkage"] === "single" ? `observed on ${hosts[0]}`
            : `linkage unknown; observed on ${hosts.join(", ")}`;
      const identity = id ? `${identityLabel(id)} · bucket ${id["limitId"]}` : "not read yet";
      console.log(`  ${g["provider"]}  ${identity}  [${linkage}]`);
      for (const note of (g["notes"] as string[] | undefined) ?? []) console.log(`    ! ${note}`);
      for (const o of obs) {
        console.log(`    on ${o["hostId"]} (read ${o["readAt"]}):`);
        renderUsageRow(o["row"] as Record<string, unknown>, "      ");
      }
    }
    for (const s of (v["seatAccounts"] as Array<Record<string, unknown>>) ?? []) {
      renderSeatAccounts((s["seats"] as Array<Record<string, unknown>>) ?? [], ` on ${s["hostId"]}`);
    }
  }

  // A host where Claude doesn't apply (no claude, no login, not a subscription login, or no Claude refresh there) is a
  // note under a bare --refresh, as on one host; naming --provider claude makes it count.
  const CLAUDE_NOT_APPLICABLE = new Set(["binary_not_found", "not_logged_in", "not_subscription_login", "not_available"]);

  async function statusAcrossHosts(
    client: DaemonClient,
    opts: { json?: boolean; refresh?: boolean; provider?: string; hosts?: string },
  ): Promise<void> {
    const hosts = (opts.hosts ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (opts.hosts !== undefined && hosts.length === 0) {
      console.error("--hosts needs at least one registered host id (comma-separated); for every host use --all-hosts");
      process.exitCode = 1;
      return;
    }
    const offLine = (data: unknown) =>
      ((data ?? {}) as { message?: unknown }).message ?? "usage windows are off on this daemon (provider.usage_windows)";
    let view: Record<string, unknown>;
    let refreshExit = 0;
    if (opts.refresh) {
      // One request for every asked provider: its answer carries each leg and the view, so the view isn't read again.
      const answer = await client.post<Record<string, unknown>>("/api/provider/usage/hosts/refresh",
        { providers: opts.provider ? [opts.provider] : ["codex", "claude"], ...(hosts.length > 0 ? { hosts } : {}) },
        { timeoutMs: USAGE_ACROSS_HOSTS_REFRESH_TIMEOUT_MS });
      if (answer.status === 409) {
        console.error(offLine(answer.data));
        process.exitCode = 1;
        return;
      }
      if (handleHttpError(answer, "refresh usage across hosts")) return;
      for (const leg of (answer.data["refresh"] as Array<Record<string, unknown>> | undefined) ?? []) {
        if (leg["outcome"] !== "failed") continue;
        const line = `refresh ${leg["provider"]} on ${leg["hostId"]} failed: ${failureText(leg)}`;
        if (opts.provider === undefined && leg["provider"] === "claude" && CLAUDE_NOT_APPLICABLE.has(String(leg["reason"]))) {
          console.error(`note: ${line}; exit unaffected (name --provider claude to require it)`);
        } else {
          console.error(line);
          refreshExit = 1;
        }
      }
      view = (answer.data["view"] ?? {}) as Record<string, unknown>;
    } else {
      const res = await client.get<Record<string, unknown>>(`/api/provider/usage/hosts${hosts.length > 0 ? `?hosts=${encodeURIComponent(hosts.join(","))}` : ""}`,
        { timeoutMs: USAGE_ACROSS_HOSTS_READ_TIMEOUT_MS });
      if (res.status === 409) {
        console.error(offLine(res.data));
        process.exitCode = 1;
        return;
      }
      if (handleHttpError(res, "read usage across hosts")) return;
      view = res.data;
    }
    // A host not heard from in time is listed like any host that couldn't be read; only a failed refresh leg sets the exit.
    if (refreshExit > 0) process.exitCode = refreshExit;
    if (opts.json) console.log(JSON.stringify(view));
    else renderAcrossHosts(view);
  }

  // Shared daemon-backed read for the FILTERED blocks: --json verbatim, human = pretty JSON (§3
  // allows pretty JSON for the filtered blocks; only `status` gets the projection).
  async function read(path: string, json: boolean | undefined, label: string): Promise<void> {
    const client = await getClient(getDeps());
    if (!client) {
      process.exitCode = 1;
      return;
    }
    const res = await client.get<Record<string, unknown>>(path);
    if (handleHttpError(res, `read provider ${label}`)) return;
    console.log(json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
  }

  cmd
    .command("status")
    .description("The whole four-block provider read model (accounts, bindings, signals), with each seat's account assignment")
    .addHelpText("after", `
Each Claude and Codex seat whose rig has an assignment (rig provider assign) is shown against it: follows (configured as
the assigned account, or still as its apply left it), override (its own choice of another account), or not applied yet,
with its last applied result. In --json this is assignment on each bindings row, and on each seatAccounts row when usage
windows are on. Configured and applied are what the seat's next launch uses and what an apply reported, not proof of the
login a running session uses.`)
    .option("--json", "Output as parseable JSON")
    .option("--refresh", "First read the Codex login's usage windows and the Claude login's identity natively (up to 35 s here, 75 s with --all-hosts/--hosts; provider.usage_windows is off by default: rig config set provider.usage_windows true)")
    .option("--provider <p>", "With --refresh, read only this provider (codex|claude)")
    .option("--claude-token-file <path>", "With --refresh --provider claude, probe this absolute token-file reference on the selected daemon (one model turn; no token value in argv)")
    .option("--credential-label <label>", "Operator label for the selected Claude token file; not provider-observed account identity")
    .option("--all-hosts", "Usage windows across every registered host, as each host already holds them (off by default: rig config set provider.usage_windows true)")
    .option("--hosts <ids>", "Like --all-hosts, for these registered hosts (comma-separated); this host is always included, so --hosts b --refresh also reads this daemon")
    .option("--host <id>", "Run this status on that registered machine over its SSH entry, with the same output and --json")
    .action(async (opts: { json?: boolean; refresh?: boolean; provider?: string; allHosts?: boolean; hosts?: string; claudeTokenFile?: string; credentialLabel?: string; host?: string }) => {
      if (opts.provider !== undefined && opts.provider !== "codex" && opts.provider !== "claude") {
        console.error(`--provider must be codex or claude (got ${opts.provider})`);
        process.exitCode = 1;
        return;
      }
      const tokenSelected = opts.claudeTokenFile !== undefined || opts.credentialLabel !== undefined;
      if (tokenSelected && (!opts.claudeTokenFile || !opts.credentialLabel || !opts.refresh || opts.provider !== "claude" || opts.allHosts || opts.hosts !== undefined)) {
        console.error("A token probe requires --refresh --provider claude --claude-token-file <absolute path> --credential-label <label>, on one daemon (no --all-hosts/--hosts).");
        process.exitCode = 1; return;
      }
      if (opts.host !== undefined) {
        if (opts.allHosts || opts.hosts !== undefined || tokenSelected) {
          console.error("--host runs status on one machine: drop --all-hosts, --hosts and the token probe, or run them without --host.");
          process.exitCode = 1; return;
        }
        // A read: a lost connection is a plain failure, since it changes nothing there.
        return onHost(opts.host, ["provider", "status", ...(opts.refresh ? ["--refresh"] : []), ...(opts.provider ? ["--provider", opts.provider] : []),
          ...(opts.json ? ["--json"] : [])], { json: opts.json });
      }
      if (tokenSelected) console.error("Claude token usage refresh spends one model turn; timeout or refusal does not prove no allowance was consumed.");
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      if (opts.allHosts || opts.hosts !== undefined) {
        await statusAcrossHosts(client, opts);
        return;
      }
      let refreshExit = 0;
      if (opts.refresh) {
        // The daemon's worst case is a read's deadline plus stopping what it started: Codex 35 s plus ~8 s
        // (stdin EOF, TERM, KILL and reap, up to 2 s each); Claude's auth status 10 s plus ~3 s. Wait 60 s so
        // a slow-dying child never turns the daemon's answer into a transport error here. Both providers are
        // read in parallel unless --provider names one.
        const providers = opts.provider ? [opts.provider] : ["codex", "claude"];
        const answered = await Promise.all(providers.map(async (provider) => ({
          provider,
          answer: await client.post<Record<string, unknown>>("/api/provider/usage/refresh", { provider, ...(tokenSelected ? { claudeToken: { label: opts.credentialLabel, tokenFile: opts.claudeTokenFile } } : {}) }, { timeoutMs: 60_000 }),
        })));
        // Bare --refresh keeps main's Codex exit: Claude is read too, but where it doesn't apply on this host
        // (no claude, no login, not a subscription login), or the daemon has no Claude refresh (400/404, an
        // older daemon), that is a note, not a failure. Naming --provider claude makes it count.
        const implicit = opts.provider === undefined;
        const notApplicable = ({ provider, answer }: (typeof answered)[number]): boolean => {
          if (!implicit || provider !== "claude") return false;
          if (answer.status === 400 || answer.status === 404) return true;
          const reason = answer.status === 200 ? (answer.data?.["refresh"] as Record<string, unknown> | undefined)?.["reason"] : undefined;
          return reason === "binary_not_found" || reason === "not_logged_in" || reason === "not_subscription_login";
        };
        const counted = answered.filter((a) => !notApplicable(a));
        if (counted.length > 0 && counted.every((a) => a.answer.status === 409)) {
          // The switch is off: one line naming it (the first provider's message).
          const p = (counted[0]!.answer.data ?? {}) as { message?: unknown };
          console.error(p.message ?? "Codex usage windows are off (provider.usage_windows)");
          process.exitCode = 1;
          return;
        }
        for (const a of answered) {
          if (!notApplicable(a)) continue;
          const refresh = a.answer.status === 200 ? (a.answer.data?.["refresh"] as Record<string, unknown> | undefined) : undefined;
          console.error(refresh
            ? `note: Claude usage not read on this host: ${refresh["reason"]} (${refresh["detail"]}); exit unaffected (name --provider claude to require it)`
            : "note: this daemon has no Claude usage refresh; exit unaffected");
        }
        // A counted provider's refusal or error is printed, and the status is still read and printed for the
        // other; the exit code then says the refresh didn't fully succeed.
        for (const { answer } of counted) {
          if (handleHttpError(answer, "refresh usage windows")) {
            refreshExit = Math.max(refreshExit, process.exitCode === 2 ? 2 : 1);
            continue;
          }
          if ((answer.data["refresh"] as Record<string, unknown> | undefined)?.["outcome"] === "failed") refreshExit = Math.max(refreshExit, 1);
        }
        process.exitCode = undefined;
      }
      const res = await client.get<Record<string, unknown>>("/api/provider/status");
      if (handleHttpError(res, "read provider status")) return;
      if (refreshExit > 0) process.exitCode = refreshExit;
      if (opts.json) console.log(JSON.stringify(res.data));
      else renderStatusHuman(res.data);
    });

  for (const block of ["accounts", "bindings", "signals"] as const) {
    cmd
      .command(block)
      .description(`The ${block} block of the provider read model`)
      .option("--json", "Output as parseable JSON")
      .option("--provider <p>", "Filter by provider (codex|claude)")
      .option("--account <a>", "Filter by account ref")
      .action(async (opts: { json?: boolean; provider?: string; account?: string }) => {
        const qs = new URLSearchParams();
        if (opts.provider) qs.set("provider", opts.provider);
        if (opts.account) qs.set("account", opts.account);
        const q = qs.toString();
        await read(`/api/provider/${block}${q ? `?${q}` : ""}`, opts.json, block);
      });
  }

  cmd
    .command("precheck")
    .description("Whether a seat can move to a login: its in-place restart plan (nothing is stopped) and the login saved in the Codex home it runs on")
    .requiredOption("--seat <s>", "The seat session")
    .option("--to-account <a>", "Codex: the login's saved name in the seat's Codex home (rig auth list --codex-home <home>). Claude: your label for the token")
    .option("--token-file <path>", "Claude: the absolute path of a 0600 file holding the seat's own subscription token; it's read only as Claude starts")
    .option("--api-key-file <path>", "Claude: a file containing its API key; resume the same conversation and settings")
    .option("--stored-login", "Claude: move the seat back to its config dir's stored login")
    .option("--json", "Output as parseable JSON")
    .action(async (opts: AccountOpts & { seat: string; json?: boolean }) => {
      const target = targetAccount(opts);
      if (!target) {
        console.error("Name the account: --to-account <name> (with --token-file <path> for a Claude seat), or --stored-login for a Claude seat.");
        process.exitCode = 1;
        return;
      }
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const qs = new URLSearchParams({ seat: opts.seat, toAccount: target.toAccount,
        ...(target.tokenFile === null ? { storedLogin: "1" } : target.tokenFile !== undefined ? { tokenFile: target.tokenFile } : {}),
        ...(target.apiKeyFile !== undefined ? { apiKeyFile: target.apiKeyFile } : {}) });
      const res = await client.get<{ safe: boolean; reasons?: string[]; message?: string; seat?: SeatView;
        claude?: Parameters<typeof printClaude>[0] }>(`/api/provider/precheck?${qs.toString()}`);
      if (handleHttpError(res, "precheck")) return;
      if (opts.json) console.log(JSON.stringify(res.data));
      else {
        console.log(res.data.safe ? "SAFE" : `UNSAFE: ${(res.data.reasons ?? []).join(", ")}`);
        if (res.data.message) console.log(res.data.message);
        if (res.data.seat) printSeat(res.data.seat);
        if (res.data.claude) printClaude(res.data.claude);
      }
      if (!res.data.safe) process.exitCode = 1; // let scripts gate on an unsafe verdict
    });

  cmd
    .command("switch")
    .description("Move one seat to subscription or API credentials, keeping its conversation: a Codex seat to a login saved in its Codex home (Linux only), a Claude seat to its own token file")
    .requiredOption("--seat <s>", "The seat session")
    .option("--to-account <a>", "Codex: the login's saved name in the seat's Codex home (rig auth list --codex-home <home>). Claude: your label for the token")
    .option("--token-file <path>", "Claude: the absolute path of a 0600 file holding the seat's own subscription token; it's read only as Claude starts")
    .option("--api-key-file <path>", "Claude: a file containing its API key; resume the same conversation and settings")
    .option("--stored-login", "Claude: move the seat back to its config dir's stored login")
    .option("--force-unsafe", "Kept for scripts; a seat's checks can't be overridden, since each means nothing safe to restart or no such login")
    .option("--clear-account-home", "Return to member/rig/daemon/native login selection through a fresh successor")
    .option("--account-home <path>", "Move to an isolated native account home with a fresh successor and handover; no shared login is changed")
    .option("--reason <text>", "Required with --account-home or --clear-account-home")
    .option("--model <id>", "With --account-home or --clear-account-home, the successor's model")
    .option("--codex-config-profile <name>", "With --account-home or --clear-account-home, the successor's Codex profile")
    .option("--dry-run", "With --account-home or --clear-account-home, show the plan without changing anything")
    .option("--json", "Output as parseable JSON")
    .addHelpText("after", `
The daemon plans the seat's in-place restart first (rig seat restart --plan), so a refusal changes nothing. It then saves the
home's current login as before-switch-<time>, activates the chosen one there (rig auth switch), and restarts the seat in place
with the same conversation, pane and launch settings. If the current login can't be saved first, nothing changes. Every seat
on that home shares its login. Peers aren't restarted: each keeps its current login only until its next token refresh, when
Codex stops it with "signed in to another account" until it's restarted, so the report prints the rig seat restart <peer>
--keep-conversation --reason "..." to paste for each. Signing in again there would replace the login you just switched to.
One switch runs at a time per home; a switch that waited checks the seat again before it changes anything. The account
isn't verified until the seat completes a tool turn: run the printed rig seat restart --keep-conversation --verify
--expect-account. An uncertain restart is reported, never retried.

Codex limits:
- Linux only: the in-place restart reads the running process from /proc, so elsewhere it refuses before anything changes.
- Same home: the login must already be saved in the home the seat runs on; the seat doesn't move to another home.

A Claude seat keeps its config dir and gets its own subscription token: --to-account <your label> --token-file <absolute path
to a 0600 file holding the token>. Only the path is kept, as the seat's reference; the launch reads the file as Claude starts,
so the token never passes through OpenRig. First the daemon checks that the file would apply and that nothing Claude Code ranks
above the token is set (a cloud provider, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, an apiKeyHelper), and refuses with each one
and its remedy if it is. When the token applies, the launch also unsets those names for Claude's process, so the pane shell's
own exports can't outrank it. For a running seat, it takes a snapshot and checks that the snapshot resumes the seat's
conversation. Then, holding the seat so no other stop, launch or switch runs on it in between, it sets the reference and
relaunches the seat from that snapshot in its own pane: Claude ends there, the pane and its scrollback stay, and restore
resumes the same conversation in it. Work in flight when it stopped doesn't carry over. Only a refusal before Claude was
touched reads as unchanged; a relaunch that doesn't report a resumed conversation reads unknown, with the snapshot's recovery
command, and isn't retried. The relaunch uses the seat's own effort choice (rig seat set-effort) when there is one; otherwise
it asks to keep the running effort, and uses the seat's saved effort when it can't. The report's effort line says which.
A stopped seat isn't relaunched, and no snapshot is taken: the reference is saved only when the seat's next launch would
resume its conversation, and the report prints that launch (rig launch <rig> <seat> --snapshot-id <id>, or a plain rig launch
when restore's periodic carry resumes it). Otherwise it refuses and nothing changes.
Seats sharing the config dir keep their own login: Claude Code reads the token from that one process's environment and doesn't
save it. That environment is Claude's, so the tools, hooks and MCP servers it starts inherit the token, and one that prints its
environment writes it into the transcript. A token-authenticated seat can make model requests but can't use claude.ai
connectors or Remote Control; its local MCP servers still work. --stored-login moves it back to the config dir's stored login;
a CLAUDE_CODE_OAUTH_TOKEN the seat still receives outranks that login, and the report says which token it will use. Claude's
/status shows token auth with no account email, so the label is yours, not an observed account.
For Claude API billing use --to-account <label> --api-key-file <absolute path to a 0600 file>. The key reaches only the
resumed child's environment, never command arguments. API credentials fail closed if their file is unavailable. Existing
model, permissions, config home and conversation are retained; in-flight work is interrupted. Claude may require native
API-key approval before the first turn. OpenRig does not enforce API budgets or choose when to fall back.
Codex can select a saved API-key auth profile with --to-account just like a subscription profile. Its shared-home effects
and native credential-store requirements are unchanged. No fresh account home or conversation is created.
Do not combine --api-key-file with --account-home or --clear-account-home; select a home and switch credentials separately.
Pi seats support --account-home with an existing readable auth.json, or --clear-account-home, through a fresh successor
with a handover. Their current model and effort are retained unless overridden. Pi account changes work with or without
a launch_wrapper. To change runtime, use rig seat set-runtime with --runtime pi, codex or claude-code.
--clear-account-home returns to the configured member/rig/daemon/native home through a fresh successor with a handover.
Use it without --to-account, --stored-login, --account-home or --token-file. It removes an account-home token reference
only after confirmation; it does not restore historical login bytes. Anthropic active/default profiles live outside
CLAUDE_CONFIG_DIR and are not isolated by an account home; check them before relying on a stored login.`)
    .action(async (opts: AccountOpts & { seat: string; forceUnsafe?: boolean; json?: boolean; accountHome?: string; clearAccountHome?: boolean; reason?: string; model?: string; codexConfigProfile?: string; dryRun?: boolean }) => {
      if (opts.apiKeyFile !== undefined && (opts.accountHome !== undefined || opts.clearAccountHome)) {
        console.error("Use --api-key-file for an in-place credential switch; select or clear an account home in a separate switch.");
        process.exitCode = 1; return;
      }
      if (opts.clearAccountHome && (opts.accountHome !== undefined || opts.tokenFile !== undefined || opts.toAccount !== undefined || opts.storedLogin)) {
        console.error("Use --clear-account-home alone, without --account-home, --token-file, --to-account or --stored-login.");
        process.exitCode = 1; return;
      }
      const target = opts.clearAccountHome ? { toAccount: "default" } : targetAccount(opts);
      if (!target) {
        console.error("Name the account: --to-account <name> (with --token-file <path> for a Claude seat), or --stored-login for a Claude seat.");
        process.exitCode = 1;
        return;
      }
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      if (opts.accountHome !== undefined || opts.clearAccountHome) {
        if (!opts.reason?.trim() || opts.storedLogin) {
          console.error(opts.clearAccountHome ? "Pass --reason with --clear-account-home."
            : "With --account-home pass --reason and --to-account, without --stored-login. A Claude subscription may also name --token-file.");
          process.exitCode = 1;
          return;
        }
        let preview: { status: number; data: Record<string, unknown> };
        try {
          const status = await client.get<{ runtime?: string }>(`/api/seat/status/${encodeURIComponent(opts.seat)}`);
          const runtime = status.data.runtime;
          if (status.status >= 400 || (runtime !== "codex" && runtime !== "claude-code" && runtime !== "pi")) {
            const refusal = { ok: false, code: "account_home_preflight_failed", message: "The seat runtime could not be read; no switch was requested." };
            if (opts.json) console.log(JSON.stringify(refusal)); else console.error(refusal.message);
            process.exitCode = 1; return;
          }
          preview = await client.post<Record<string, unknown>>(`/api/seat/set-runtime/${encodeURIComponent(opts.seat)}`, {
            runtime, ...(opts.clearAccountHome ? { clearAccountHome: true } : { accountHome: opts.accountHome }), reason: opts.reason, dryRun: true,
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.codexConfigProfile !== undefined ? { codexConfigProfile: opts.codexConfigProfile } : {}),
            ...(opts.tokenFile !== undefined ? { tokenFile: opts.tokenFile, accountLabel: opts.toAccount } : {}),
          }, { timeoutMs: 30_000 });
        } catch {
          const refusal = { ok: false, code: "account_home_preflight_failed", message: "The read-only account-home preflight failed; no switch was requested." };
          if (opts.json) console.log(JSON.stringify(refusal)); else console.error(refusal.message);
          process.exitCode = 1; return;
        }
        const token = opts.tokenFile ? { label: opts.toAccount!, tokenFile: opts.tokenFile } : undefined;
        if (!accountHomePlanMatches(preview.data, opts.clearAccountHome ? null : opts.accountHome!, token)) {
          const refusal = { ok: false, code: "account_home_switch_unavailable", message: preview.data["message"]
            ?? "The daemon did not acknowledge the selected account home and token. No switch was requested." };
          if (opts.json) console.log(JSON.stringify(refusal)); else console.error(refusal.message);
          process.exitCode = 1; return;
        }
        if (opts.dryRun) {
          if (opts.json) console.log(JSON.stringify(preview.data));
          else {
            console.log(`Account-home plan for ${opts.seat}: ${opts.accountHome ?? "configured defaults"}. Nothing changed.`);
            const settings = (preview.data["settings"] ?? {}) as Record<string, { value: string | null; source: string }>;
            console.log(`Settings on ${String(preview.data["to"])}:`);
            for (const [name, setting] of Object.entries(settings)) console.log(`  ${name}: ${setting.value ?? "none"} (${setting.source})`);
            const permission = preview.data["permission"] as { mode: string; source: string } | undefined;
            if (permission) console.log(`  permissions: ${permission.mode} (${permission.source})`);
            const dropped = (preview.data["dropped"] as Array<{ setting: string; value: string }> | undefined) ?? [];
            if (dropped.length) console.log(`Cleared from ${String(preview.data["from"])}: ${dropped.map(choice => `${choice.setting} ${choice.value}`).join("; ")}.`);
            console.log("Costs:");
            for (const cost of (preview.data["costs"] as string[] | undefined) ?? []) console.log(`  - ${cost}`);
          }
          return;
        }
        let result;
        try {
          result = await client.post<Record<string, unknown>>("/api/provider/switch", {
            seat: opts.seat, ...(opts.clearAccountHome ? { clearAccountHome: true } : { ...target, accountHome: opts.accountHome }), reason: opts.reason, dryRun: false,
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.codexConfigProfile !== undefined ? { codexConfigProfile: opts.codexConfigProfile } : {}),
          }, { timeoutMs: 300_000 });
        } catch (error) {
          if (!(error instanceof DaemonTimeoutError)) throw error;
          result = { status: 202, data: { ok: false, code: "runtime_switch_outcome_unknown",
            message: `The daemon may still be switching. Inspect rig seat status ${opts.seat}; do not retry the switch.` } };
        }
        if (opts.json) console.log(JSON.stringify(result.data));
        else if (result.data["recoveryPending"] === true) {
          console.error(`Recovery is still pending for ${opts.seat}; the account-home switch is not complete.`);
          if (typeof result.data["message"] === "string") console.error(result.data["message"]);
          if (typeof result.data["guidance"] === "string") console.error(result.data["guidance"]);
          for (const warning of (result.data["warnings"] as string[] | undefined) ?? []) console.error(`Warning: ${warning}`);
        }
        else if (result.data["ok"] === true) console.log(`Account-home switch for ${opts.seat}: ${opts.accountHome ?? "configured defaults"}. A fresh conversation carries the handover; the account is not verified until a real tool turn.`);
        else console.error(result.data["message"] ?? "The account-home switch did not complete.");
        process.exitCode = result.status >= 400 || result.data["ok"] !== true || result.data["recoveryPending"] === true ? 1 : 0;
        return;
      }
      if (opts.dryRun || opts.reason || opts.model || opts.codexConfigProfile) {
        console.error("--reason, --model, --codex-config-profile and --dry-run require --account-home or --clear-account-home.");
        process.exitCode = 1;
        return;
      }
      type SwitchResponse = { status: number; data: { outcome?: string; reasons?: string[]; message?: string; seat?: SwitchReport } };
      let res: SwitchResponse;
      const startedAt = new Date().toISOString();
      try {
        res = await client.post<SwitchResponse["data"]>("/api/provider/switch", {
          seat: opts.seat,
          ...target,
          forceUnsafe: opts.forceUnsafe ?? false,
        }, { timeoutMs: SWITCH_TIMEOUT_MS });
      } catch (err) {
        if (!(err instanceof DaemonTimeoutError)) throw err;
        // The daemon may still be switching: a timeout is neither a failure nor a reason to send it again.
        res = { status: 200, data: { outcome: "unknown", reasons: ["switch_outcome_unknown"],
          message: `The CLI timed out waiting for the daemon. The switch may still be running, or queued behind another switch on the same Codex home; a queued switch hasn't changed anything yet. `
            + `For a Codex seat, it has restarted the seat once rig seat restart ${opts.seat} --keep-conversation --plan shows a lastRestart that finished after ${startedAt}. `
            + `Until then an eligible plan, or an older lastRestart, doesn't mean it ended, so don't run the switch again: a second one would queue behind it. `
            + `For a Claude seat, rig seat status ${opts.seat} shows its token reference and whether it runs; a second switch would wait for this one.` } };
      }
      if (handleHttpError(res, "switch")) return;
      if (opts.json) console.log(JSON.stringify(res.data));
      else {
        const { outcome, reasons, message, seat } = res.data;
        console.log(reasons?.length ? `${outcome ?? "unknown"}: ${reasons.join(", ")}` : outcome ?? "unknown");
        if (message) console.log(message);
        if (seat?.home) {
          console.log(`home: ${seat.home}${seat.loginChanged ? ` (now "${seat.account}")` : ""}`);
          if (seat.undo) {
            console.log(`to restore the home's saved credential bytes: ${seat.undo}`);
            console.log("undo restores saved credential bytes only; sign-in is unverified. Saved credentials may expire, be revoked, or be superseded by refresh elsewhere. Restart the affected seat and use the existing account verification; fresh sign-in may be required.");
          }
        } else if (seat) {
          console.log(`Claude ${seat.credentialKind === "api-key" ? "API key" : "token"}: ${seat.tokenFile ? `"${seat.account}", read from ${seat.tokenFile}` : "the config dir's stored login"}${seat.loginChanged
            ? seat.tokenApplied === false ? " (reference saved; the token didn't take effect)" : " (set)" : ""}`);
          for (const warning of seat.warnings ?? []) console.log(`warning: ${warning}`);
          if (seat.effort) console.log(`effort: ${seat.effort}`);
          if (seat.conversation) console.log(`conversation: ${seat.conversation}`);
          if (seat.undo) console.log(`to switch back: ${seat.undo}`);
        }
        if (seat) {
          if (seat.restart?.recoveryCommand) console.log(`recovery: ${seat.restart.recoveryCommand}`);
          if (!seat.home && seat.restart?.remainingStep) console.log(seat.restart.remainingStep);
          printSeat({ peers: seat.peers });
          if (seat.next) console.log(`next: ${seat.next}`);
        }
      }
      if (res.data.outcome !== "rebind_in_progress" && res.data.outcome !== "succeeded") process.exitCode = 1;
    });

  // Slice 18 — subscription move reports: what the agent that moved a Codex home reports, kept as queue items tagged
  // subscription-move. Reading them back answers "why did these seats move?"; the Fleet app reads the same route.
  type MoveEntry = {
    qitemId: string; reportedAt: string; reportedTo: string; followedBy: string[];
    report: { host: string; home: string; from: string; to: string; reason: string; follows?: string; seats: Array<{ seat: string; result: string; missing?: string }>; peers?: Array<{ seat: string; note: string }> };
  };
  const moves = cmd
    .command("moves")
    .description("Recent subscription move reports on this daemon, newest first: from and to, why, and each seat's result")
    .option("--seat <seat>", "Only reports that restarted or listed this seat, among the reports read")
    .option("--limit <n>", "How many of the newest reports to read, before --seat filters them (default 50, at most 200)")
    .option("--json", "Output as parseable JSON")
    .action(async (opts: { seat?: string; limit?: string; json?: boolean }) => {
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const qs = new URLSearchParams();
      if (opts.seat) qs.set("seat", opts.seat);
      if (opts.limit) qs.set("limit", opts.limit);
      const res = await client.get<{ moves: MoveEntry[]; unreadable: Array<{ qitemId: string; reason: string }>; truncated: boolean }>(
        `/api/provider/moves${qs.toString() ? `?${qs.toString()}` : ""}`,
      );
      if (handleHttpError(res, "moves")) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }
      const { moves: entries, unreadable, truncated } = res.data;
      if (entries.length === 0) console.log("No subscription move reports.");
      for (const { qitemId, reportedAt, reportedTo, followedBy, report } of entries) {
        console.log(`${reportedAt}  ${qitemId}  ${report.host} ${report.home}: ${report.from} → ${report.to} (to ${reportedTo})`);
        console.log(`  why: ${report.reason}`);
        for (const seat of report.seats) console.log(`  ${seat.seat}: ${seat.result}${seat.missing ? `; missing: ${seat.missing}` : ""}`);
        for (const peer of report.peers ?? []) console.log(`  ${peer.seat}: ${peer.note}`);
        if (report.follows) console.log(`  follows ${report.follows}`);
        if (followedBy.length > 0) console.log(`  followed by ${followedBy.join(", ")}`);
      }
      for (const item of unreadable) console.log(`unreadable: ${item.qitemId}: ${item.reason}`);
      if (truncated) console.log(`(only the newest ${opts.limit ?? 50} reports were read; older ones may exist: raise --limit)`);
    });
  moves
    .command("report")
    .description("File a report of a move you made or attempted, as a queue item to whoever asked (it moves nothing)")
    .requiredOption("--file <path>", "The report as JSON, or - for stdin")
    .requiredOption("--to <seat>", "Who gets the report: whoever asked for the move, or the person")
    .option("--follows <qitemId>", "The earlier report this one follows up (sets the report's follows)")
    .option("--evidence-ref <ref>", "The evidence a report to a person's seat names, e.g. the saved --verify output")
    .option("--json", "Output as parseable JSON")
    .addHelpText("after", `
The report (version 1):
  { "version": 1, "host": "<machine>", "home": "<CODEX_HOME>", "from": "<subscription label>", "to": "<subscription label>",
    "reason": "<why, in your words>",
    "policy": { "ref": "account-policy", "version": "<manifest version>" }   (or { "none": true })
    "readings": [{ "subject": "<allowance>", "basis": "observed", "observedAt": "<when observed>", "summary": "<what it said>" },
                 { "subject": "<allowance>", "basis": "expected", "expectedFullSince": "<the reset>", "summary": "..." }],
    "seats": [{ "seat": "<seat>", "result": "moved",
                "accountEvidence": { "state": "matched", "detail": "<Account line>", "at": "<time>" },
                "toolTurn": { "state": "observed", "at": "<time>" } },
              { "seat": "<seat>", "result": "unconfirmed", "missing": "<what wasn't seen>" }],
    "peers": [{ "seat": "<seat>", "note": "not restarted; account unverified" }] }
moved needs accountEvidence matched and toolTurn observed, as rig seat restart --verify reports them; until both are
seen, report the seat unconfirmed (or unknown) with what's missing. An expected reading (slice 01's expectation after
a reset) stays labelled expected. Labels and references only: a value in a recognized credential format is refused.
A refused report records nothing and changes nothing about the move: correct it and file it again; never repeat the
switch or restart because a report was refused.`)
    .action(async (opts: { file: string; to: string; follows?: string; evidenceRef?: string; json?: boolean }, command: Command) => {
      const json = opts.json || command.parent?.opts().json;
      let report: unknown;
      try {
        report = JSON.parse(opts.file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.file, "utf8"));
      } catch {
        console.error(`Could not read a JSON report from ${opts.file}. Nothing was recorded, and the move itself is unchanged.`);
        process.exitCode = 1;
        return;
      }
      if (opts.follows && report && typeof report === "object" && !Array.isArray(report)) report = { ...report, follows: opts.follows };
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const res = await client.post<{ qitemId?: string; errors?: string[] }>("/api/provider/moves", {
        to: opts.to, report, ...(opts.evidenceRef ? { evidenceRef: opts.evidenceRef } : {}),
      });
      if (res.status < 400 && json) console.log(JSON.stringify(res.data));
      else if (res.status < 400) console.log(`Filed ${res.data.qitemId} to ${opts.to}`);
      else {
        for (const error of res.data.errors ?? []) console.error(`- ${error}`);
        handleHttpError(res, "move report");
      }
    });

  // #3625: the accounts a daemon knows by label, each a reference on that daemon's own machine. With --host the same
  // command runs there, over the host's SSH entry, the way rig auth --host does.
  type AccountRefView = { provider: string; label: string; kind: string; file: string | null; codexHome: string | null; login: string | null };
  const describeRef = (a: AccountRefView): string => a.kind === "codex_saved_login" ? `the login ${a.login} saved in ${a.codexHome}`
    : `the ${a.kind === "claude_api_key_file" ? "API-key" : "token"} file ${a.file}`;
  const onHost = async (hostId: string, argv: string[], opts: { json?: boolean; changes?: string }) => {
    const env = remote.env ?? process.env;
    const seat = (env.OPENRIG_SESSION_NAME ?? env.RIGGED_SESSION_NAME)?.trim() || undefined;
    const origin = await originFor(seat, remote.host?.selfHostId ?? (() => localSelfHostId(realDeps())));
    await runOnSshHost(hostId, argv.slice(0, 3).filter((a) => !a.startsWith("-")).join(" "), argv, {
      origin, ...(opts.json ? { json: true } : {}), ...(opts.changes ? { changes: { check: opts.changes } } : {}),
    }, remote.host);
  };
  const refusal = (message: string) => { console.error(message); process.exitCode = 1; };
  const providerProblem = (provider: string | undefined, required: boolean): string | null =>
    provider === undefined ? (required ? "Name the provider: --provider claude or --provider codex." : null)
      : VALID_ACCOUNT_PROVIDERS.includes(provider) ? null : `--provider must be claude or codex, not ${provider}.`;

  const account = cmd
    .command("account")
    .description("Accounts this daemon knows by your label: a Claude token or API-key file, or a Codex login saved in a Codex home")
    .addHelpText("after", `
Each account is your label and a reference on the daemon's own machine: the absolute path of a private (0600 or 0400) file
holding a Claude subscription token or API key, or a Codex home and the name of a login saved there (rig auth list
--codex-home <home> lists them). Only the reference is kept: the file isn't read or copied, and no credential passes
through OpenRig. Adding one checks it first: the file exists, is a regular file, is private and isn't empty, or the login
is saved in that home. A refusal says why and stores nothing. A label is unique per provider, and the same label can name
a Claude and a Codex account. A label is your name for a reference, not proof of the login a running seat uses.

With --host, the command runs on that registered machine over its SSH entry, as this seat, and the reference is a path on
that machine. Only the command and its output cross the connection.`);

  account
    .command("add <label>")
    .description("Add an account by label, after checking its reference on the daemon's machine")
    .option("--provider <p>", "claude or codex")
    .option("--token-file <path>", "Claude: the absolute path of a 0600 or 0400 file holding a subscription token")
    .option("--api-key-file <path>", "Claude: the absolute path of a 0600 or 0400 file holding an API key")
    .option("--codex-home <dir>", "Codex: the Codex home the login is saved in")
    .option("--login <name>", "Codex: the saved login's name in that home")
    .option("--host <id>", "Add it on this registered machine instead, over its SSH entry; the paths are on that machine")
    .option("--json", "Output as parseable JSON")
    .action(async (label: string, opts: { provider?: string; tokenFile?: string; apiKeyFile?: string; codexHome?: string; login?: string; host?: string; json?: boolean }) => {
      const problem = providerProblem(opts.provider, true) ?? (opts.provider === "claude"
        ? (opts.codexHome !== undefined || opts.login !== undefined ? "A Claude account is a --token-file or --api-key-file, not --codex-home or --login."
          : (opts.tokenFile === undefined) === (opts.apiKeyFile === undefined) ? "A Claude account needs one of --token-file <path> or --api-key-file <path>." : null)
        : opts.tokenFile !== undefined || opts.apiKeyFile !== undefined ? "A Codex account is --codex-home and --login, not a token or API-key file."
          : opts.codexHome === undefined || opts.login === undefined ? "A Codex account needs --codex-home <dir> and --login <name>." : null);
      if (problem) return refusal(`${problem} Nothing was stored.`);
      const fields: Array<[string, string | undefined]> = [["--token-file", opts.tokenFile], ["--api-key-file", opts.apiKeyFile], ["--codex-home", opts.codexHome], ["--login", opts.login]];
      if (opts.host) {
        return onHost(opts.host, ["provider", "account", "add", label, "--provider", opts.provider!,
          ...fields.flatMap(([flag, value]) => value === undefined ? [] : [flag, value]), ...(opts.json ? ["--json"] : [])],
        { json: opts.json, changes: `rig provider account list --host ${opts.host} --provider ${opts.provider}` });
      }
      const client = await getClient(getDeps());
      if (!client) { process.exitCode = 1; return; }
      const res = await client.post<{ ok: boolean; account?: AccountRefView; code?: string; message?: string }>("/api/provider/account-refs", {
        provider: opts.provider, label,
        ...(opts.tokenFile !== undefined ? { tokenFile: opts.tokenFile } : {}), ...(opts.apiKeyFile !== undefined ? { apiKeyFile: opts.apiKeyFile } : {}),
        ...(opts.codexHome !== undefined ? { codexHome: opts.codexHome } : {}), ...(opts.login !== undefined ? { login: opts.login } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      if (handleHttpError(res, "account add")) return;
      const added = res.data.account!;
      console.log(`Added the ${added.provider} account ${added.label}: ${describeRef(added)}.`);
      console.log(added.kind === "codex_saved_login" ? "Checked that the login is saved there; nothing was read or copied."
        : "Checked that the file exists, is private and isn't empty; it wasn't read.");
    });

  account
    .command("list")
    .description("The accounts this daemon knows, by provider and label, with each one's reference")
    .option("--provider <p>", "Only claude or only codex")
    .option("--host <id>", "List that registered machine's accounts instead, over its SSH entry")
    .option("--json", "Output as parseable JSON")
    .action(async (opts: { provider?: string; host?: string; json?: boolean }) => {
      const problem = providerProblem(opts.provider, false);
      if (problem) return refusal(problem);
      if (opts.host) {
        return onHost(opts.host, ["provider", "account", "list", ...(opts.provider ? ["--provider", opts.provider] : []), ...(opts.json ? ["--json"] : [])], { json: opts.json });
      }
      const client = await getClient(getDeps());
      if (!client) { process.exitCode = 1; return; }
      const res = await client.get<{ accounts: AccountRefView[] }>(`/api/provider/account-refs${opts.provider ? `?provider=${opts.provider}` : ""}`);
      if (handleHttpError(res, "account list")) return;
      if (opts.json) { console.log(JSON.stringify(res.data)); return; }
      if (res.data.accounts.length === 0) {
        console.log("No accounts on this daemon. Add one with rig provider account add <label> --provider claude|codex (rig provider account --help).");
        return;
      }
      for (const a of res.data.accounts) console.log(`${a.provider}  ${a.label}  ${describeRef(a)}`);
    });

  account
    .command("remove <label>")
    .description("Remove an account's label; its file or saved login is left as it is")
    .option("--provider <p>", "claude or codex")
    .option("--host <id>", "Remove it on that registered machine instead, over its SSH entry")
    .option("--json", "Output as parseable JSON")
    .action(async (label: string, opts: { provider?: string; host?: string; json?: boolean }) => {
      const problem = providerProblem(opts.provider, true);
      if (problem) return refusal(`${problem} Nothing changed.`);
      if (opts.host) {
        return onHost(opts.host, ["provider", "account", "remove", label, "--provider", opts.provider!, ...(opts.json ? ["--json"] : [])],
          { json: opts.json, changes: `rig provider account list --host ${opts.host} --provider ${opts.provider}` });
      }
      const client = await getClient(getDeps());
      if (!client) { process.exitCode = 1; return; }
      const res = await client.delete<{ ok: boolean; account?: AccountRefView; code?: string; message?: string }>(
        `/api/provider/account-refs/${opts.provider}/${encodeURIComponent(label)}`);
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      if (handleHttpError(res, "account remove")) return;
      console.log(`Removed the ${opts.provider} account ${label}. Its ${res.data.account?.kind === "codex_saved_login" ? "saved login" : "file"} is left as it is, and seats already switched to it keep their own reference.`);
    });

  // #3625: the plan for moving a rig's seats of one provider to an account, computed by the daemon that runs the rig
  // (slice 2, it changes nothing), and applying exactly that plan, named by its digest (slice 3).
  type PlanRow = { seat: string; runtime: string; current: string; effect: "change" | "unchanged" | "kept_override" | "not_affected";
    override?: string; precheck?: { safe: boolean; reasons: string[]; message?: string }; continuity?: string; activity: string; notes?: string[];
    lastResult?: { kind: string; label: string; detail: string; at: string }; asApplied?: true };
  type Plan = { daemon: string; rig: string; provider: string; account: { label: string; reference: string }; includeOverrides: boolean;
    accountHome?: string; rows: PlanRow[]; codexHomes: Array<{ home: string; seats: Array<{ seat: string; rig: string; effect: string }> }>;
    intent?: { label: string; reference: string; requestedBy: string | null; at: string }; digest: string; note: string };
  type ApplyReport = { daemon: string; rig: string; provider: string; account: { label: string; reference: string }; digest: string;
    results: Array<{ seat: string; kind: string; detail: string; recovery?: string; activity: string; at: string }>;
    otherRigPeers: Array<{ seat: string; rig: string; home: string; command: string }> };
  const kindWords = (kind: string) => kind.replace(/_/g, "-");
  const printPlan = (plan: Plan, again: string) => {
    console.log(`Plan ${plan.digest} on ${plan.daemon}: rig ${plan.rig}'s ${plan.provider} seats to ${plan.account.label} (${plan.account.reference})`
      + `${plan.accountHome ? `, as fresh successors on ${plan.accountHome}` : ""}.`);
    if (plan.intent) {
      console.log(`The rig's ${plan.provider} assignment: ${plan.intent.label} (${plan.intent.reference}), applied ${plan.intent.at} by ${setBy(plan.intent.requestedBy)}.`);
    }
    for (const row of plan.rows) {
      const last = row.lastResult ? `  last applied: ${kindWords(row.lastResult.kind)} (${row.lastResult.label}, ${row.lastResult.at}): ${row.lastResult.detail}` : null;
      if (row.effect === "not_affected") { console.log(`${row.seat}: not affected (${(row.notes ?? []).join("; ")})`); continue; }
      if (row.effect === "unchanged") console.log(row.asApplied ? `${row.seat}: unchanged: still as the apply of ${plan.account.label} left its home`
        : `${row.seat}: unchanged, already on ${plan.account.label}`);
      else if (row.effect === "kept_override") console.log(`${row.seat}: kept (seat override): ${row.override}; --include-overrides moves it too`);
      else {
        const check = row.precheck?.safe ? "precheck safe" : `precheck UNSAFE: ${(row.precheck?.reasons ?? []).join(", ")}`;
        console.log(`${row.seat}: from ${row.current}; ${check}; ${row.continuity}; activity ${row.activity}`);
        if (row.override) console.log(`  overrides ${row.override}`);
        if (row.precheck?.message) console.log(`  ${row.precheck.message}`);
        for (const note of row.notes ?? []) console.log(`  ${note}`);
      }
      if (last) console.log(last);
    }
    for (const group of plan.codexHomes) {
      console.log(`Codex home ${group.home}: one switch; every seat on it:`);
      for (const peer of group.seats) console.log(`  ${peer.seat} (rig ${peer.rig}): ${peer.effect}`);
    }
    console.log(`A plan only: nothing was changed. Apply exactly this plan with: ${again} --apply --plan ${plan.digest}`);
  };
  const printApply = (report: ApplyReport) => {
    console.log(`Applied plan ${report.digest} on ${report.daemon}: rig ${report.rig}'s ${report.provider} seats to ${report.account.label} (${report.account.reference}).`);
    for (const r of report.results) {
      console.log(`${r.seat}: ${kindWords(r.kind)}: ${r.detail}`);
      if (r.activity === "running" || r.activity === "needs_input") console.log(`  it was ${r.activity === "running" ? "working" : "waiting for input"} when it was reached: work in flight, including background commands, didn't carry over`);
      if (r.recovery) console.log(`  recovery: ${r.recovery}`);
    }
    for (const p of report.otherRigPeers) console.log(`${p.seat} (rig ${p.rig}): not restarted; it shares ${p.home}, so restart it yourself: ${p.command}`);
    console.log("Each result is reported on its own: nothing was rolled back or retried.");
  };

  cmd
    .command("assign <rig>")
    .description("Plan moving a rig's seats of one provider to an account this daemon knows by label, then apply that plan")
    .option("--provider <p>", "claude or codex: a mixed rig gets one assignment per provider")
    .option("--account <label>", "The account's label (rig provider account list)")
    .option("--include-overrides", "Also move seats with their own choice of account; by default they're kept and shown")
    .option("--account-home <dir>", "Codex: move the seats to this prepared home as fresh successors with a handover, instead of in place")
    .option("--apply", "Carry out the plan, one seat at a time; needs --plan with the digest the plan showed")
    .option("--plan <digest>", "The digest of the plan you reviewed: apply acts only while the plan is still the same")
    .option("--host <id>", "Plan or apply on that registered machine instead, over its SSH entry; the rig and account are that daemon's")
    .option("--json", "Output as parseable JSON")
    .addHelpText("after", `
The daemon that runs the rig computes the plan from what it already has, and changes nothing: one row per seat, with its
configured account, whether it has its own choice of account (kept unless --include-overrides), the switch's precheck
verdict, whether it keeps its conversation, and what it's doing now. A busy seat is noted, not refused.
A Claude seat is relaunched in place on the same conversation; a stopped one picks the account up at its next launch.
A Codex seat switches in place only on Linux, by changing its Codex home's active login, so every seat on that home moves
with it: the plan lists each one, in this rig ("would restart") or not ("not restarted; needs rig seat restart <seat>").
Elsewhere it reads "unsupported in place"; name a prepared home with --account-home to move it as a fresh successor
with a handover instead. Nothing falls back to that by itself.
A configured account is what a seat's next launch uses, not proof of the login a running session uses.

--apply --plan <digest> computes the plan again and refuses, changing nothing, unless it's the one you reviewed. It then
moves each seat through the existing switch, one at a time, reporting each result as unchanged, switched,
pending-successor, unsupported, failed-before-effect or unknown. A failure doesn't stop the other seats; nothing is
rolled back or retried, and an unknown result names its recovery command. After an unknown on a Codex home, that home's
other seats are skipped. Seats in other rigs on a switched home are listed, never restarted.
The rig's assignment is stored with the first seat that's on the account or may be, so an apply where every seat was
refused leaves the earlier one. Afterwards the plan shows the assignment and each seat's last result, and rig provider
status shows each seat against it. It exits 1 when any seat failed or is unknown.`)
    .action(async (rig: string, opts: { provider?: string; account?: string; includeOverrides?: boolean; accountHome?: string; apply?: boolean; plan?: string;
      host?: string; json?: boolean }) => {
      const problem = providerProblem(opts.provider, true) ?? (opts.account ? null : "Name the account: --account <label> (rig provider account list).")
        ?? (opts.accountHome !== undefined && opts.provider !== "codex" ? "--account-home is for Codex seats." : null)
        ?? (opts.apply && !opts.plan ? "--apply needs --plan <digest>: the digest the plan showed. Run the plan first and review it." : null)
        ?? (opts.plan !== undefined && !opts.apply ? "--plan names the plan to apply: add --apply." : null)
        ?? (opts.plan !== undefined && !/^[0-9a-f]{12}$/.test(opts.plan) ? "--plan is the 12-character digest the plan showed." : null);
      if (problem) return refusal(`${problem} Nothing changed.`);
      const again = `rig provider assign ${rig} --provider ${opts.provider} --account ${opts.account}${opts.includeOverrides ? " --include-overrides" : ""}`
        + `${opts.accountHome !== undefined ? ` --account-home ${opts.accountHome}` : ""}`;
      if (opts.host) {
        return onHost(opts.host, ["provider", "assign", rig, "--provider", opts.provider!, "--account", opts.account!,
          ...(opts.includeOverrides ? ["--include-overrides"] : []), ...(opts.accountHome !== undefined ? ["--account-home", opts.accountHome] : []),
          ...(opts.apply ? ["--apply", "--plan", opts.plan!] : []), ...(opts.json ? ["--json"] : [])],
        { json: opts.json, ...(opts.apply ? { changes: `${again} --host ${opts.host} (its plan shows each seat's last result)` } : {}) });
      }
      const client = await getClient(getDeps());
      if (!client) { process.exitCode = 1; return; }
      const qs = new URLSearchParams({ rig, provider: opts.provider!, account: opts.account!,
        ...(opts.includeOverrides ? { includeOverrides: "1" } : {}), ...(opts.accountHome !== undefined ? { accountHome: opts.accountHome } : {}) });
      const res = await client.get<{ ok: boolean; plan?: Plan; code?: string; message?: string }>(`/api/provider/assignment-plan?${qs.toString()}`);
      if (!opts.apply) {
        if (opts.json) {
          console.log(JSON.stringify(res.data));
          if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
          return;
        }
        if (handleHttpError(res, "assignment plan")) return;
        printPlan(res.data.plan!, again);
        return;
      }
      // The plan is read first only to size the wait: the daemon checks the digest itself. Each seat that changes takes a
      // switch, and so does each other seat of this rig on a Codex home that switches, since it restarts on it.
      const shown = res.data.plan;
      const changing = shown ? new Set([...shown.rows.filter((r) => r.effect === "change").map((r) => r.seat),
        ...shown.codexHomes.flatMap((h) => h.seats.filter((s) => s.rig === shown.rig).map((s) => s.seat))]).size : 1;
      type ApplyResponse = { status: number; data: { ok: boolean; report?: ApplyReport; code?: string; message?: string; digest?: string } };
      let applied: ApplyResponse;
      try {
        applied = await client.post<ApplyResponse["data"]>("/api/provider/assignment-apply", { rig, provider: opts.provider, account: opts.account,
          plan: opts.plan, ...(opts.includeOverrides ? { includeOverrides: true } : {}), ...(opts.accountHome !== undefined ? { accountHome: opts.accountHome } : {}) },
        { timeoutMs: SWITCH_TIMEOUT_MS * Math.max(1, changing) + 30_000 });
      } catch (err) {
        if (!(err instanceof DaemonTimeoutError)) throw err;
        if (opts.json) console.log(JSON.stringify({ ok: false, code: "apply_outcome_unknown", digest: opts.plan, check: again,
          message: "The CLI timed out waiting for the daemon; the apply may still be running. Don't run it again: each seat's result shows in the plan as it lands." }));
        console.error(`The CLI timed out waiting for the daemon. The apply may still be running, seat by seat, so don't run it again: `
          + `a second apply to the rig is refused while one runs. Each seat's result shows in the plan as it lands: ${again}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(applied.data));
        if (applied.status >= 400) process.exitCode = applied.status >= 500 ? 2 : 1;
      } else {
        if (handleHttpError(applied, "assignment apply")) return;
        printApply(applied.data.report!);
      }
      if (applied.data.report?.results.some((r) => r.kind === "failed_before_effect" || r.kind === "unknown")) process.exitCode = 1;
    });

  return cmd;
}
