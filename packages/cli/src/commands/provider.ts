import fs from "node:fs";
import { Command } from "commander";
import { DaemonClient, DaemonTimeoutError } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

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
type SwitchReport = { home?: string; account: string; tokenFile?: string; conversation?: string | null; loginChanged: boolean; undo: string | null; peers: Peer[];
  restart?: { recoveryCommand?: string; remainingStep?: string }; next?: string; warnings?: string[]; tokenApplied?: boolean };

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

type AccountOpts = { toAccount?: string; tokenFile?: string; storedLogin?: boolean };

/** The account a switch names: a Codex login's saved name, a Claude token's label with its file, or a Claude seat's stored
 *  login. Null when neither --to-account nor --stored-login was given. */
function targetAccount(opts: AccountOpts): { toAccount: string; tokenFile?: string | null } | null {
  if (opts.storedLogin) return { toAccount: "stored-login", tokenFile: null };
  if (!opts.toAccount) return null;
  return { toAccount: opts.toAccount, ...(opts.tokenFile !== undefined ? { tokenFile: opts.tokenFile } : {}) };
}

function printClaude(claude: { label: string; tokenFile: string | null; checked: string[]; notChecked: string[]; instead?: string }): void {
  console.log(`Claude token: ${claude.tokenFile ? `"${claude.label}", read from ${claude.tokenFile} when Claude starts` : "none (the config dir's stored login)"}`);
  if (claude.instead) console.log(`instead of the stored login, the seat would use ${claude.instead}`);
  if (claude.checked.length) console.log(`checked for anything that outranks it: ${claude.checked.join("; ")}`);
  if (claude.notChecked.length) console.log(`not checked (the seat's /status shows what it uses): ${claude.notChecked.join("; ")}`);
}

export function providerCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("provider").description(
    "Provider accounts and usage signals, and moving one Codex seat to another login saved in its Codex home",
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
        } else if (an["kind"] === "seat_with_no_account") {
          const key = `sw:${an["seat"]}`;
          if (!seen.has(key)) { seen.add(key); flags.push(`  ! seat with no bound account: ${an["seat"]}`); }
        }
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
  }

  // Slice 01 — each seat's configured account and its source (present only while provider.usage_windows is on).
  // Configuration, never an observed account: the allowance stays unlinked, with the reason.
  // A failure's reason and detail as served. Both are optional in the read model: an absent reason reads "no reason
  // given" and an absent detail drops its clause, never "undefined". When both are served the text is unchanged.
  function failureText(f: Record<string, unknown>): string {
    return `${f["reason"] ?? "no reason given"}${f["detail"] !== undefined ? ` (${f["detail"]})` : ""}`;
  }

  function renderSeatAccounts(rows: Array<Record<string, unknown>>, where = ""): void {
    console.log(`SEATS${where} (configured account; not proof of the login a running session uses)`);
    for (const r of rows) {
      const c = (r["configured"] ?? {}) as Record<string, unknown>;
      const configured = c["source"] === "registry"
        ? `configured: profile ${c["profileRef"]} (registry, recorded ${c["recordedAt"]}${c["profileSaved"] === false ? "; profile not saved on this host" : c["profileSaved"] === null ? "; whether the profile is saved: unknown" : ""})`
        : c["source"] === "default_login" && c["homeFrom"]
          ? `configured: the seat's own home (${c["home"]}, from its ${c["homeFrom"]} env)`
        : c["source"] === "default_login"
          ? `configured: default login${c["home"] ? ` (${c["home"]})` : ""}`
          : `configured: unknown (${c["reason"]})`;
      const allowance = (r["allowance"] ?? {}) as Record<string, unknown>;
      console.log(`  ${r["seatSession"]}  ${r["runtime"]}  ${configured} · allowance not linked`);
      if (c["source"] === "default_login" && c["homeNote"]) console.log(`    ${c["homeNote"]}`);
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
    .description("The whole four-block provider read model (accounts, bindings, signals)")
    .option("--json", "Output as parseable JSON")
    .option("--refresh", "First read the Codex login's usage windows and the Claude login's identity natively (up to 35 s here, 75 s with --all-hosts/--hosts; provider.usage_windows is off by default: rig config set provider.usage_windows true)")
    .option("--provider <p>", "With --refresh, read only this provider (codex|claude)")
    .option("--claude-token-file <path>", "With --refresh --provider claude, probe this absolute token-file reference on the selected daemon (one model turn; no token value in argv)")
    .option("--credential-label <label>", "Operator label for the selected Claude token file; not provider-observed account identity")
    .option("--all-hosts", "Usage windows across every registered host, as each host already holds them (off by default: rig config set provider.usage_windows true)")
    .option("--hosts <ids>", "Like --all-hosts, for these registered hosts (comma-separated); this host is always included, so --hosts b --refresh also reads this daemon")
    .action(async (opts: { json?: boolean; refresh?: boolean; provider?: string; allHosts?: boolean; hosts?: string; claudeTokenFile?: string; credentialLabel?: string }) => {
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
        ...(target.tokenFile === null ? { storedLogin: "1" } : target.tokenFile !== undefined ? { tokenFile: target.tokenFile } : {}) });
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
    .description("Move one seat to another subscription login, keeping its conversation: a Codex seat to a login saved in its Codex home (Linux only), a Claude seat to its own token file")
    .requiredOption("--seat <s>", "The seat session")
    .option("--to-account <a>", "Codex: the login's saved name in the seat's Codex home (rig auth list --codex-home <home>). Claude: your label for the token")
    .option("--token-file <path>", "Claude: the absolute path of a 0600 file holding the seat's own subscription token; it's read only as Claude starts")
    .option("--stored-login", "Claude: move the seat back to its config dir's stored login")
    .option("--force-unsafe", "Kept for scripts; a seat's checks can't be overridden, since each means nothing safe to restart or no such login")
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
own exports can't outrank it. It takes a snapshot and checks that the snapshot resumes the seat's conversation. Then, holding
the seat so no other stop, launch or switch runs on it in between, it sets the reference and relaunches the seat from that
snapshot in its own pane: Claude ends there, the pane and its scrollback stay, and restore resumes the same conversation in it.
Work in flight when it stopped doesn't carry over. Only a refusal before Claude was touched reads as unchanged; a relaunch that
doesn't report a resumed conversation reads unknown, with the snapshot's recovery command, and isn't retried.
Seats sharing the config dir keep their own login: Claude Code reads the token from that one process's environment and doesn't
save it. That environment is Claude's, so the tools, hooks and MCP servers it starts inherit the token, and one that prints its
environment writes it into the transcript. A token-authenticated seat can make model requests but can't use claude.ai
connectors or Remote Control; its local MCP servers still work. --stored-login moves it back to the config dir's stored login;
a CLAUDE_CODE_OAUTH_TOKEN the seat still receives outranks that login, and the report says which token it will use. Claude's
/status shows token auth with no account email, so the label is yours, not an observed account.`)
    .action(async (opts: AccountOpts & { seat: string; forceUnsafe?: boolean; json?: boolean }) => {
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
          console.log(`Claude token: ${seat.tokenFile ? `"${seat.account}", read from ${seat.tokenFile}` : "the config dir's stored login"}${seat.loginChanged
            ? seat.tokenApplied === false ? " (reference saved; the token didn't take effect)" : " (set)" : ""}`);
          for (const warning of seat.warnings ?? []) console.log(`warning: ${warning}`);
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

  return cmd;
}
