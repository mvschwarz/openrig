// 51-08 A4 — `rig usage`: the CLI face of the ONE telemetry projection
// (PM decision 4; the daemon's /api/telemetry/usage/* routes). Facts only:
// tokens/hour, window velocities, honest-unknown rail — thresholds and
// judgments belong to the consumer (the oversight detector). --json is
// verbatim route payload for the scripted detector.
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/** Parse a human duration (`90m`, `1h`, `2d`, bare hours `1.5`) into hours.
 *  Returns null on anything unparseable — the caller renders the teaching error. */
export function parseWindowToHours(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([mhd])?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "h";
  if (unit === "m") return n / 60;
  if (unit === "d") return n * 24;
  return n;
}

interface TopPayload {
  ranked: Array<{
    seatSession: string;
    tokensPerHour: number;
    tokensDelta: number;
    resets: number;
    spanHours: number;
    samples: number;
    windows: Array<{ window: string; usedPercentFirst: number | null; usedPercentLast: number | null; percentPerHour: number | null }>;
  }>;
  unknown: Array<{ seatSession: string; reason: string }>;
  totalRankedSeats: number;
  windowHours: number;
}

interface CostPayload {
  seats: Array<Record<string, unknown> & { seatSession: string; status: string }>;
  note: string;
}

const tok = (t: unknown): string => {
  const v = t as { input?: number | null; output?: number | null } | undefined;
  return `tokens in ${v?.input ?? "?"} / out ${v?.output ?? "?"}`;
};

/** A real estimate below a cent prints as "<$0.01", never "$0.00" (which reads as zero); JSON keeps the exact value. */
export function formatUsd(value: number): string {
  return value > 0 && value < 0.005 ? "<$0.01" : `$${value.toFixed(2)}`;
}

/** A Pi seat: the model-priced estimate summed over its own persisted entries, with what isn't in it named. */
function piCostLine(seat: CostPayload["seats"][number]): string {
  const w = (seat["window"] ?? {}) as { piSessionId?: string; since?: string | null; asOf?: string | null };
  const e = (seat["entries"] ?? {}) as { own?: number; ownWithoutCost?: number; errorOrAborted?: number;
    inherited?: { count: number; costUsd: number | null }; unknownOrigin?: { count: number; costUsd: number | null } };
  const t = (seat["tokens"] ?? {}) as { input?: number; output?: number };
  const extras = [
    e.ownWithoutCost ? `${e.ownWithoutCost} entr${e.ownWithoutCost === 1 ? "y" : "ies"} without a cost` : "",
    e.errorOrAborted ? `${e.errorOrAborted} error/aborted turn${e.errorOrAborted === 1 ? "" : "s"} included` : "",
    e.inherited?.count ? `${e.inherited.count} inherited from the fork, not counted${e.inherited.costUsd !== null ? ` (${formatUsd(e.inherited.costUsd)})` : ""}` : "",
    e.unknownOrigin?.count ? `${e.unknownOrigin.count} of unknown origin, not counted${e.unknownOrigin.costUsd !== null ? ` (${formatUsd(e.unknownOrigin.costUsd)})` : ""}` : "",
  ].filter(Boolean).join("; ");
  const head = seat.status === "reported"
    ? `${formatUsd(Number(seat["costUsd"]))} model-priced estimate (Pi persisted entries, ${e.own ?? 0} own entries) for Pi session ${w.piSessionId}${w.since ? ` since ${w.since}` : ""}${w.asOf ? `, last ${w.asOf}` : ""}`
    : `cost: not reported (${seat["reason"]}) for Pi session ${w.piSessionId}`;
  return `${seat.seatSession}  ${head}${extras ? `; ${extras}` : ""}  tokens in ${t.input ?? "?"} / out ${t.output ?? "?"}`;
}

/** One labelled line per seat. Never prints a dollar figure the route didn't report. */
export function costLine(seat: CostPayload["seats"][number]): string {
  if (seat["runtime"] === "pi") return piCostLine(seat);
  const w = (seat["window"] ?? {}) as { nativeSessionId?: string | null; since?: string; asOf?: string | null };
  if (seat.status === "reported") {
    const stale = seat["stale"] ? `, STALE (${seat["ageSeconds"] ?? "?"}s old; kept as history)` : "";
    const resets = Number(seat["resets"]) > 0 ? `, ${seat["resets"]} reset${seat["resets"] === 1 ? "" : "s"}` : "";
    return `${seat.seatSession}  ${formatUsd(Number(seat["costUsd"]))} client-side estimate (Claude statusline) for session ${w.nativeSessionId} since ${w.since}, as of ${w.asOf}${resets}${stale}  ${tok(seat["tokens"])}`;
  }
  if (seat.status === "absent") return `${seat.seatSession}  cost: not reported (${seat["reason"]})  ${tok(seat["tokens"])}`;
  if (seat.status === "no-cost-method") return `${seat.seatSession}  ${tok(seat["tokens"])}  cost: ${seat["note"]}`;
  return `${seat.seatSession}  cost: unknown (${seat["reason"]})`;
}

export function usageCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("usage").description(
    "Per-seat token telemetry over time (series + top-N burn) — facts for the oversight detector",
  );
  const getDeps = (): StatusDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  function handleHttpError(res: { status: number; data: unknown }, label: string, json?: boolean): boolean {
    if (res.status < 400) return false;
    if (json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      const p = (res.data ?? {}) as { error?: unknown };
      console.error(p.error ?? `${label} failed (HTTP ${res.status})`);
    }
    process.exitCode = res.status >= 500 ? 2 : 1;
    return true;
  }

  cmd
    .command("top")
    .description("top-N seats by token burn over the window")
    .option("--window <duration>", "look-back window (90m, 1h, 2d, or bare hours)", "1h")
    .option("--top <n>", "cap the ranking to N seats")
    .option("--json", "machine-readable (verbatim route payload)")
    .action(async (opts: { window: string; top?: string; json?: boolean }) => {
      const hours = parseWindowToHours(opts.window);
      if (hours === null) {
        console.error(
          `invalid --window "${opts.window}" — accepted forms: 90m, 1h, 2d, or bare hours like 1.5`,
        );
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams({ window_hours: String(hours) });
      if (opts.top !== undefined) params.set("top", opts.top);
      const res = await client.get<TopPayload>(`/api/telemetry/usage/top?${params.toString()}`);
      if (handleHttpError(res, "usage top", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const body = res.data;
      if (body.ranked.length === 0 && body.unknown.length === 0) {
        console.log(`no usage samples in the last ${opts.window} — the series is empty`);
        return;
      }
      console.log(`TOP TOKEN BURN — last ${opts.window} (${body.totalRankedSeats} seats ranked)`);
      for (const [i, r] of body.ranked.entries()) {
        const winPart = r.windows
          .map((w) => `${w.window}: ${w.usedPercentLast ?? "?"}%${w.percentPerHour !== null ? ` (${w.percentPerHour >= 0 ? "+" : ""}${w.percentPerHour.toFixed(1)}%/h)` : ""}`)
          .join("  ");
        const resetPart = r.resets > 0 ? `  resets:${r.resets}` : "";
        console.log(
          `${i + 1}. ${r.seatSession}  ${Math.round(r.tokensPerHour).toLocaleString()} tok/h  (${r.tokensDelta.toLocaleString()} over ${r.spanHours.toFixed(1)}h, ${r.samples} samples)${resetPart}${winPart ? `  ${winPart}` : ""}`,
        );
      }
      for (const u of body.unknown) {
        console.log(`?  ${u.seatSession}  unknown (${u.reason})`); // honest rail — never a 0 row
      }
    });

  cmd
    .command("cost")
    .description("what each seat's harness reports about cost, beside tokens: kind, source, window and coverage")
    .option("--seat <session>", "one seat session")
    .option("--json", "machine-readable (verbatim route payload)")
    .addHelpText("after", `
Claude seats show the statusline's cost.total_cost_usd: a client-side estimate, cumulative for one
native session since its last reset (not an invoice). Codex seats show tokens and that the inspected
method reports no cost. A missing figure reads as missing and an old one as stale, never as $0; no
subscription window is shown in dollars. Earlier values stay in rig usage series --lane context.
With usage.pi_cost_facts on (default off), Pi seats show Pi's model-priced estimate summed over
their own persisted session entries, each counted once; entries a fork copied in are shown apart and
not counted, and an entry without a cost is named, not counted as zero.`)
    .action(async (opts: { seat?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.seat) params.set("seat", opts.seat);
      const res = await client.get<CostPayload>(`/api/telemetry/usage/cost${params.size ? `?${params.toString()}` : ""}`);
      if (handleHttpError(res, "usage cost", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const body = res.data;
      if (body.seats.length === 0) {
        console.log("no usage samples yet: no seat has reported tokens or cost");
        return;
      }
      for (const seat of body.seats) console.log(costLine(seat));
      console.log(body.note);
    });

  cmd
    .command("series")
    .description("raw per-seat usage samples, oldest first")
    .option("--seat <session>", "filter to one seat session")
    .option("--lane <lane>", "context | provider_window")
    .option("--since <iso>", "absolute lower bound on captured_at (inclusive)")
    .option("--until <iso>", "absolute upper bound on captured_at (exclusive)")
    .option("--limit <n>", "max rows")
    .option("--json", "machine-readable (verbatim route payload)")
    .action(async (opts: { seat?: string; lane?: string; since?: string; until?: string; limit?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.seat) params.set("seat", opts.seat);
      if (opts.lane) params.set("lane", opts.lane);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      if (opts.limit) params.set("limit", opts.limit);
      const qs = params.toString();
      const res = await client.get<{ rows: Array<Record<string, unknown>> }>(
        `/api/telemetry/usage/series${qs ? `?${qs}` : ""}`,
      );
      if (handleHttpError(res, "usage series", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const rows = res.data.rows;
      if (rows.length === 0) {
        console.log("no samples match — the series is empty for this filter");
        return;
      }
      for (const r of rows) {
        const lane = r.lane === "provider_window"
          ? `${r.window} ${r.windowUsedPercent ?? "?"}%`
          : `tokens ${(r.totalInputTokens as number | null) ?? "?"}/${(r.totalOutputTokens as number | null) ?? "?"} used ${(r.usedPercentage as number | null) ?? "?"}%`;
        console.log(`${r.capturedAt}  ${r.seatSession}  [${r.lane}] ${lane}`);
      }
    });

  return cmd;
}
