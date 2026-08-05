import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// Slice-04 (OPR.0.5.0.4) — the `rig provider` CLI verb surface (packet 3ffa3c22 §3), grammar per
// the auth.ts precedent (conventions/cli-read-command-grammar). Daemon-backed: reads/precheck go
// through the DaemonClient to the daemon's four-block read model + precheck; switch POSTs the
// orchestration route. NOTE: this CLI seam does NOT itself compose `rig auth` — it only calls the
// route; the real precheck-gated switch + rig-auth codex composition + durable action record live
// in the daemon routes/service (seams B/C/D), where seam D resolves the CLI-local auth
// composition/package boundary. Every verb is --json-stable for agents.

export function providerCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("provider").description(
    "Provider accounts, usage signals, and interruption-safe account switching",
  );
  const getDeps = (): StatusDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running");
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  // Consistent HTTP error handling: print the daemon error payload, exit 1 for 4xx / 2 for 5xx.
  // A 4xx (e.g. 404 unknown provider / 400 invalid target) is an ERROR, never a success.
  function handleHttpError(res: { status: number; data: unknown }, label: string): boolean {
    if (res.status < 400) return false;
    const p = (res.data ?? {}) as { error?: unknown; errors?: unknown };
    console.error(p.errors ?? p.error ?? `${label} failed (HTTP ${res.status})`);
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
    .action(async (opts: { json?: boolean }) => {
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const res = await client.get<Record<string, unknown>>("/api/provider/status");
      if (handleHttpError(res, "read provider status")) return;
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

  return cmd;
}
