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

  function handleHttpError(res: { status: number; data: unknown }, label: string): boolean {
    if (res.status < 400) return false;
    const p = (res.data ?? {}) as { error?: unknown };
    console.error(p.error ?? `${label} failed (HTTP ${res.status})`);
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
      if (handleHttpError(res, "usage top")) return;
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
      if (handleHttpError(res, "usage series")) return;
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
