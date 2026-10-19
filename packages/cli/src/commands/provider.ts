import fs from "node:fs";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
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

export function providerCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("provider").description(
    "Provider accounts, usage signals, and interruption-safe account switching",
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
        : c["source"] === "default_login"
          ? `configured: default login${c["home"] ? ` (${c["home"]})` : ""}`
          : `configured: unknown (${c["reason"]})`;
      const allowance = (r["allowance"] ?? {}) as Record<string, unknown>;
      console.log(`  ${r["seatSession"]}  ${r["runtime"]}  ${configured} · allowance not linked`);
      if (c["source"] === "default_login" && c["homeNote"]) console.log(`    ${c["homeNote"]}`);
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
    return id["accountId"] ? `account ${id["accountId"]}`
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

  function renderUsageRow(r: Record<string, unknown>, pad = "  "): void {
    const id = r["identity"] as Record<string, unknown> | null;
    if (!id) {
      console.log(`${pad}${r["provider"]}  unavailable: ${r["unavailableReason"] ?? "no reading"}`);
      return;
    }
    // Identity first; for Codex the email is a label.
    const labels = [identityLabel(id), `bucket ${id["limitId"]}`, id["email"] ?? "email not reported", id["planType"], id["subscriptionType"], `seats ${r["seats"] ?? "unknown"}`]
      .filter((x) => x !== null && x !== undefined);
    // Not from the latest read: say only that. A later read proves no other account (an unresolved read
    // may be this same login), so the label names the read, not an account.
    const earlier = r["latestFromSource"] ? ""
      : id["source"] === "unresolved" ? "  [from an earlier read; possibly this same login]"
        : "  [from an earlier read; the latest read didn't match this row]";
    console.log(`${pad}${r["provider"]}  ${labels.join(" · ")}${earlier}`);
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
      console.log(`${pad}  ${windowName(w)}  ${left}  ${level}  resets ${w["resetsAt"] ?? "unknown"}  observed ${w["observedAt"]}${seat} (${fresh})`);
      for (const d of (w["disagreeingSeats"] as Array<Record<string, unknown>> | undefined) ?? []) {
        console.log(`${pad}    seat ${d["seatSession"]} reports ${Math.max(0, 100 - Number(d["usedPercent"]))}% left  resets ${d["resetsAt"] ?? "unknown"}  observed ${d["observedAt"]}`);
      }
    }
    if (r["unavailableReason"]) console.log(`${pad}  ${r["unavailableReason"]}`);
    if (r["limitEvidence"]) console.log(`${pad}  limit evidence: ${r["limitEvidence"]}`);
    const last = r["lastRefresh"] as Record<string, unknown> | null;
    if (last?.["outcome"] === "failed") {
      // Claude's refresh reads identity only; its windows keep coming from the seats' samples.
      console.log(r["provider"] === "claude"
        ? `${pad}  identity refresh failed at ${last["at"]}: ${failureText(last)}; the identity shown is from the last refresh that worked, if any`
        : `${pad}  refresh failed at ${last["at"]}: ${failureText(last)}; last reading kept, marked old`);
    }
    console.log(`${pad}  current availability: ${r["currentAvailability"]}`);
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
    .option("--all-hosts", "Usage windows across every registered host, as each host already holds them (off by default: rig config set provider.usage_windows true)")
    .option("--hosts <ids>", "Like --all-hosts, for these registered hosts (comma-separated); this host is always included, so --hosts b --refresh also reads this daemon")
    .action(async (opts: { json?: boolean; refresh?: boolean; provider?: string; allHosts?: boolean; hosts?: string }) => {
      if (opts.provider !== undefined && opts.provider !== "codex" && opts.provider !== "claude") {
        console.error(`--provider must be codex or claude (got ${opts.provider})`);
        process.exitCode = 1;
        return;
      }
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
          answer: await client.post<Record<string, unknown>>("/api/provider/usage/refresh", { provider }, { timeoutMs: 60_000 }),
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
    .description("Whether switching a seat to an account is safe (never offers an unsafe switch)")
    .requiredOption("--seat <s>", "The seat session")
    .requiredOption("--to-account <a>", "The target account ref")
    .option("--json", "Output as parseable JSON")
    .action(async (opts: { seat: string; toAccount: string; json?: boolean }) => {
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const qs = new URLSearchParams({ seat: opts.seat, toAccount: opts.toAccount });
      const res = await client.get<{ safe: boolean; reasons?: string[] }>(`/api/provider/precheck?${qs.toString()}`);
      if (handleHttpError(res, "precheck")) return;
      if (opts.json) console.log(JSON.stringify(res.data));
      else console.log(res.data.safe ? "SAFE" : `UNSAFE: ${(res.data.reasons ?? []).join(", ")}`);
      if (!res.data.safe) process.exitCode = 1; // let scripts gate on an unsafe verdict
    });

  cmd
    .command("switch")
    .description("Switch a seat to an account (precheck-gated; the daemon orchestrates the switch)")
    .requiredOption("--seat <s>", "The seat session")
    .requiredOption("--to-account <a>", "The target account ref")
    .option("--force-unsafe", "Override a non-stranding precheck failure (still refuses to strand a live conversation)")
    .option("--json", "Output as parseable JSON")
    .action(async (opts: { seat: string; toAccount: string; forceUnsafe?: boolean; json?: boolean }) => {
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const res = await client.post<{ outcome?: string; reasons?: string[] }>("/api/provider/switch", {
        seat: opts.seat,
        toAccount: opts.toAccount,
        forceUnsafe: opts.forceUnsafe ?? false,
      });
      if (handleHttpError(res, "switch")) return;
      if (opts.json) console.log(JSON.stringify(res.data));
      else console.log(res.data.outcome ?? "unknown");
      if (res.data.outcome === "failed_safely") process.exitCode = 1;
    });

  // OPR.0.7.0.18 — the subscription move record. The agent that moves seats records each move it makes or attempts;
  // it and the observatory read them back. Labels and references only, never credentials. Off unless the daemon's
  // provider.subscription_moves is on.
  const moves = cmd
    .command("moves")
    .description("Recorded subscription moves, newest first (needs provider.subscription_moves on)")
    .option("--home <home>", "Only moves of this Codex home")
    .option("--seat <seat>", "Only moves that restarted or listed this seat")
    .option("--limit <n>", "At most this many (default 50)")
    .option("--json", "Output as parseable JSON")
    .action(async (opts: { home?: string; seat?: string; limit?: string; json?: boolean }) => {
      const qs = new URLSearchParams();
      if (opts.home) qs.set("home", opts.home);
      if (opts.seat) qs.set("seat", opts.seat);
      if (opts.limit) qs.set("limit", opts.limit);
      const q = qs.toString();
      await read(`/api/provider/moves${q ? `?${q}` : ""}`, opts.json, "moves");
    });
  moves
    .command("show <id>")
    .description("One recorded move: seats and results, from and to, the reason, the readings and their age, peers (needs provider.subscription_moves on)")
    .option("--json", "Output as parseable JSON")
    .action(async (id: string, opts: { json?: boolean }, command: Command) => {
      // `moves` has its own --json, which commander may take for the parent.
      await read(`/api/provider/moves/${encodeURIComponent(id)}`, opts.json || command.parent?.opts().json, "move");
    });
  moves
    .command("record")
    .description("Record a move you made or attempted (JSON: home, host, from, to, reason, readings, seats, peers, supersedes; needs provider.subscription_moves on)")
    .requiredOption("--file <path>", "The move as JSON, or - for stdin")
    .option("--operator <name>", "Who is recording, when this shell has no seat identity (a seat identity wins)")
    .option("--json", "Output as parseable JSON")
    .addHelpText("after", `
The JSON shape:
  { "home": "<codex home>", "host": "<machine>", "from": "<subscription>", "to": "<subscription>",
    "reason": "<why, in your words>",
    "readings": [{ "subject": "<allowance>", "observedAt": "<ISO time observed>", "summary": "<what it said>" }],
    "seats": [{ "seat": "<seat>", "result": "moved|unconfirmed|unknown", "missing": "<what's missing>", "evidence": "<verify outcome>" }],
    "peers": [{ "seat": "<seat>", "note": "not restarted; account unverified" }],
    "supersedes": "<an earlier move id>" }
Record unconfirmed and partial moves too. Labels only: never put credentials in a record.
The record is off by default. Turn it on with: rig config set provider.subscription_moves true`)
    .action(async (opts: { file: string; operator?: string; json?: boolean }, command: Command) => {
      const json = opts.json || command.parent?.opts().json;
      let body: unknown;
      try {
        body = JSON.parse(opts.file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.file, "utf8"));
      } catch (error) {
        console.error(`Could not read the move from ${opts.file}: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      if (opts.operator && body !== null && typeof body === "object" && !Array.isArray(body)) {
        body = { ...(body as Record<string, unknown>), operator: opts.operator };
      }
      const res = await client.post<{ move?: { id?: string } }>("/api/provider/moves", body);
      if (handleHttpError(res, "record move")) return;
      if (json) console.log(JSON.stringify(res.data));
      else console.log(`Recorded ${res.data.move?.id ?? "the move"}`);
    });

  return cmd;
}
