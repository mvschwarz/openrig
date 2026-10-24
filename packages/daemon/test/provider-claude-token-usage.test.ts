import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ClaudeTokenUsage, claudeTokenUsageReader, parseClaudeTokenUsage } from "../src/domain/provider/claude-token-usage.js";
import { ProviderAccountReadingsStore } from "../src/domain/provider/provider-account-readings.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { providerRoutes } from "../src/routes/provider.js";
import { allowanceKey } from "../src/domain/provider/usage-across-hosts.js";
import { allowanceLines } from "../../tui/src/usage/usage-model.js";
import type { UsageReadOutcome } from "../src/domain/provider/usage-windows.js";
import type { ClaudeTokenAnswer } from "../src/domain/provider/claude-token-usage.js";
import type { ClaudeTokenIdentity } from "../src/domain/provider/provider-types.js";

const NOW = "2026-10-24T04:16:45.000Z";
// Sanitized provider event: no credential, account identity, UUID or model text.
const EVENT = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1793196000,
  rateLimitType: "seven_day", utilization: 0.83, overageStatus: "rejected", overageDisabledReason: "org_level_disabled",
  isUsingOverage: false, surpassedThreshold: 0.75, unifiedWindows: {
    five_hour: { utilization: 0.02, resetsAt: 1792822200, status: "allowed" },
    seven_day: { utilization: 0.83, resetsAt: 1793196000, status: "allowed_warning", surpassedThreshold: 0.75 },
  } } };
const answer = () => ({ ok: true as const, observedAt: NOW, ...parseClaudeTokenUsage(JSON.stringify(EVENT))! });
const A = { label: "First subscription", tokenFile: "/private/first.token" };
const B = { label: "Second subscription", tokenFile: "/private/second.token" };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); vi.unstubAllEnvs(); });
function db() { const d = new Database(":memory:"); migrate(d, ALL_MIGRATIONS); cleanup.push(() => d.close()); return d; }
function fake(script: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-probe-test-")); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "claude"), `#!${process.execPath}\n${script}`, { mode: 0o700 });
  const tokenFile = path.join(root, "selected.token"); fs.writeFileSync(tokenFile, "SYNTHETIC-TEST-ONLY", { mode: 0o600 });
  return { root, tokenFile };
}

describe("selected Claude credential usage", () => {
  it("shows the supplied windows, times, label provenance and independent overage refusal", async () => {
    const cache = new ClaudeTokenUsage({ read: vi.fn(async () => answer()), now: () => NOW });
    await cache.refresh(A);
    const [r] = cache.project(NOW);
    expect(r).toMatchObject({ identity: { source: "configured credential label", credentialLabel: A.label, credentialRef: A.tokenFile },
      observedAt: NOW, accountHistory: "unknown", seats: "unknown", currentAvailability: "unknown",
      probe: { overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false } });
    expect(r!.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ window: "five_hour", remainingPercent: 98, resetsAt: "2026-10-24T06:10:00.000Z", level: "ok", freshness: "fresh" }),
      expect.objectContaining({ window: "seven_day", remainingPercent: 17, resetsAt: "2026-10-28T14:00:00.000Z", level: "nearing" }),
    ]));
    expect(allowanceKey(r!)).toBeNull(); // labels/paths on different hosts never establish a shared account
    const view = allowanceLines(r! as unknown as Record<string, unknown>).map(x => x.text).join("\n");
    expect(view).toContain("First subscription (operator label)"); expect(view).toContain("17% left"); expect(view).toContain("overageStatus");
  });

  it("keeps a provider rejection and its reset without inventing a measured percentage", async () => {
    const rejected = parseClaudeTokenUsage(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1793196000 } }))!;
    const cache = new ClaudeTokenUsage({ read: async () => ({ ok: true, observedAt: NOW, ...rejected }), now: () => NOW });
    await cache.refresh(A);
    expect(cache.project(NOW)[0]!.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ window: "seven_day", usedPercent: null, remainingPercent: null, status: "rejected", level: "exhausted" }),
      expect.objectContaining({ window: "five_hour", usedPercent: null, remainingPercent: null, level: "unknown" }),
    ]));
  });

  it.each(["", "not json", JSON.stringify({ type: "result", is_error: true }), JSON.stringify({ type: "rate_limit_event", rate_limit_info: [] })])("keeps missing or malformed usage unknown (%j)", raw => {
    expect(parseClaudeTokenUsage(raw)).toBeNull();
  });

  it("coalesces only the selected credential, keeps other labels, and retains the old reading on failure", async () => {
    let release!: () => void;
    const read = vi.fn(async (): Promise<UsageReadOutcome<ClaudeTokenAnswer>> => { await new Promise<void>(r => { release = r; }); return answer(); });
    const cache = new ClaudeTokenUsage({ read, now: () => NOW });
    const first = cache.refresh(A), joined = cache.refresh(A); release(); await Promise.all([first, joined]); expect(read).toHaveBeenCalledTimes(1);
    read.mockImplementation(async () => answer()); await cache.refresh(B);
    read.mockImplementation(async () => ({ ok: false, at: "2026-10-24T04:18:00.000Z", reason: "probe_timeout", detail: "provider effects unknown" }));
    await cache.refresh(A);
    const rows = cache.project("2026-10-24T04:18:00.000Z");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ identity: { credentialLabel: A.label }, observedAt: NOW, lastRefresh: { outcome: "failed", reason: "probe_timeout" } });
    expect(rows[0]!.windows.every(w => w.freshness === "stale")).toBe(true);
    expect(rows[1]).toMatchObject({ identity: { credentialLabel: B.label }, lastRefresh: { outcome: "ok" } });
    expect(rows[1]!.windows.every(w => w.freshness === "fresh")).toBe(true);
  });

  it("restores labelled evidence after restart without reading any credential or changing existing Codex rows", async () => {
    const d = db();
    d.prepare(`INSERT INTO provider_account_readings (provider,identity_key,account_id,limit_id,identity_source,observed_at,windows_json)
      VALUES ('codex','codex-old','native-id','bucket','account/rateLimits/read accountId',?,'[]')`).run(NOW);
    const before = d.prepare("SELECT * FROM provider_account_readings WHERE provider='codex'").all();
    const store = new ProviderAccountReadingsStore<ClaudeTokenIdentity>(d, "claude");
    await new ClaudeTokenUsage({ read: async () => { const a = answer(); return { ...a, probe: { ...a.probe, warnings: ["token file is a symlink; the opened target is checked"] } }; }, store, now: () => NOW }).refresh(A);
    const read = vi.fn(); const afterRestart = new ClaudeTokenUsage({ read, store, now: () => NOW });
    expect(read).not.toHaveBeenCalled();
    expect(afterRestart.project(NOW)[0]).toMatchObject({ retained: "before_restart", identity: { credentialLabel: A.label }, probe: { overageStatus: "rejected", warnings: ["token file is a symlink; the opened target is checked"] } });
    expect(afterRestart.project(NOW)[0]!.windows.every(w => w.freshness === "stale")).toBe(true);
    expect(d.prepare("SELECT * FROM provider_account_readings WHERE provider='codex'").all()).toEqual(before);
    expect(new ProviderAccountReadingsStore(d).latestAll()).toHaveLength(1);
  });

  it("migration preserves every existing Codex history field", () => {
    const d = new Database(":memory:"); cleanup.push(() => d.close());
    migrate(d, ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.findIndex((m) => m.name === "134_claude_token_readings.sql")));
    d.prepare(`INSERT INTO provider_account_readings (provider,identity_key,account_id,limit_id,identity_source,observed_at,windows_json)
      VALUES ('codex','old','native-id','bucket','account/rateLimits/read accountId',?,'[]')`).run(NOW);
    const before = d.prepare("SELECT * FROM provider_account_readings").all();
    migrate(d, ALL_MIGRATIONS);
    const after = d.prepare("SELECT * FROM provider_account_readings").all() as Array<Record<string, unknown>>;
    expect(after.map(({ metadata_json, ...row }) => row)).toEqual(before);
    expect(after[0]!.metadata_json).toBeNull();
  });

  it("does not turn malformed percentages into zero, and keeps additional native windows", () => {
    const parsed = parseClaudeTokenUsage(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 2, resetsAt: "bad" }, seven_day_sonnet: { utilization: 0.4, resetsAt: 1793196000 },
    } } }))!;
    expect(parsed.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ window: "five_hour", usedPercent: null, resetsAt: null }),
      expect.objectContaining({ window: "seven_day_sonnet", usedPercent: 40, durationMins: null }),
    ]));
  });

  it("a failed or expired credential produces no raw error or fabricated usage", async () => {
    const f = fake("console.log('SYNTHETIC-TEST-ONLY invalid credential'); process.exit(1)");
    const result = await claudeTokenUsageReader({ launchPath: f.root })({ label: "fixture", tokenFile: f.tokenFile });
    expect(result).toMatchObject({ ok: false, reason: "probe_failed" }); expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });

  it("uses only the selected token in an isolated real child, with tools/hooks/MCP disabled and no secret in argv/results", async () => {
    const f = fake(`if(process.argv.includes('--version')) { if(process.env.CLAUDE_CODE_OAUTH_TOKEN) process.exit(5); console.log('2.1.310 (Claude Code)'); process.exit(0); }
      const fs=require('fs'); const args=process.argv.slice(2);
      const ok = process.env.CLAUDE_CODE_OAUTH_TOKEN === 'SYNTHETIC-TEST-ONLY' && !process.env.ANTHROPIC_API_KEY && !process.env.OPENRIG_HOME && !process.env.CLAUDECODE && !process.env.TMUX && process.cwd() === fs.realpathSync(process.env.HOME) && process.env.HOME === process.env.CLAUDE_CONFIG_DIR && args[args.indexOf('--tools')+1] === '' && args.includes('--strict-mcp-config') && JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks;
      if(!ok || args.join(' ').includes(process.env.CLAUDE_CODE_OAUTH_TOKEN)) process.exit(4);
      console.log(JSON.stringify(${JSON.stringify(EVENT)})); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));`);
    vi.stubEnv("ANTHROPIC_API_KEY", "UNRELATED-SYNTHETIC-KEY"); vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "UNSELECTED-SYNTHETIC-TOKEN");
    const r = await claudeTokenUsageReader({ launchPath: f.root, now: () => NOW })({ label: "fixture", tokenFile: f.tokenFile });
    expect(r).toMatchObject({ ok: true, probe: { exitCode: 0, requestOutcome: "completed", cliVersion: "2.1.310" } });
    expect(JSON.stringify(r)).not.toContain("SYNTHETIC");
  });

  it.skipIf(process.platform === "win32")("a FIFO credential path returns without blocking the serving event loop", () => {
    const f = fake("process.exit(6)"); fs.unlinkSync(f.tokenFile); execFileSync("/usr/bin/mkfifo", [f.tokenFile]);
    const module = fileURLToPath(new URL("../src/domain/provider/claude-token-usage.ts", import.meta.url));
    const script = `import { claudeTokenUsageReader } from ${JSON.stringify(module)};
      const outcome = await claudeTokenUsageReader({launchPath:${JSON.stringify(f.root)},timeoutMs:80})({label:'fixture',tokenFile:${JSON.stringify(f.tokenFile)}});
      console.log(JSON.stringify(outcome));`;
    // The parent deadline kills this disposable process if a synchronous open blocks its own timers.
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 8000 });
    expect(child.error, "reader must return before the parent deadline").toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: false, reason: "credential_file_unavailable" });
  });

  it.each(["mode", "owner", "symlink"] as const)("a readable token with a %s concern is used with a warning", async concern => {
    const f = fake(`console.log(JSON.stringify(${JSON.stringify(EVENT)}))`);
    let tokenFile = f.tokenFile;
    let uid: ReturnType<typeof vi.spyOn> | undefined;
    if (concern === "mode") fs.chmodSync(tokenFile, 0o644);
    if (concern === "owner" && process.getuid) { const current = process.getuid(); uid = vi.spyOn(process, "getuid").mockReturnValue(current + 1); }
    if (concern === "symlink") { tokenFile = path.join(f.root, "alias.token"); fs.symlinkSync(f.tokenFile, tokenFile); }
    try {
      const result = await claudeTokenUsageReader({ launchPath: f.root })({ label: "fixture", tokenFile });
      expect(result).toMatchObject({ ok: true, probe: { warnings: expect.arrayContaining([expect.stringContaining(concern === "mode" ? "group/others" : concern === "owner" ? "owned by uid" : "symlink")]) } });
    } finally { uid?.mockRestore(); }
  });

  it("bounds an unfinished child and reports possible provider spend", async () => {
    const f = fake("setInterval(()=>{},1000)");
    expect(await claudeTokenUsageReader({ launchPath: f.root, timeoutMs: 80, graceMs: 30 })({ label: "fixture", tokenFile: f.tokenFile })).toMatchObject({ ok: false, reason: "probe_timeout", detail: expect.stringContaining("may have been consumed") });
  });

  it("plain API/view reads never probe; a selected refresh alone reads one credential", async () => {
    const read = vi.fn(async () => answer()); const d = db(); let enabled = true;
    const service = new ProviderServiceImpl({ db: d, listRigs: () => [], usageWindows: { enabled: () => enabled,
      windows: new CodexUsageWindows({ read: vi.fn() }), claudeTokens: new ClaudeTokenUsage({ read, now: () => NOW }) } });
    const app = new Hono(); app.use('*',async(c,next)=>{ c.set('providerService' as never,service as never); await next(); }); app.route('/api/provider',providerRoutes());
    await app.request('/api/provider/status'); expect(read).not.toHaveBeenCalled();
    await app.request('/api/provider/usage/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude' }) });
    expect(read).not.toHaveBeenCalled();
    const response = await app.request('/api/provider/usage/refresh',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'claude',claudeToken:A}) });
    expect(response.status).toBe(200); expect(read).toHaveBeenCalledExactlyOnceWith(A);
    await app.request('/api/provider/status'); await app.request('/api/provider/status'); expect(read).toHaveBeenCalledTimes(1);
    const invalid = await app.request('/api/provider/usage/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'claude',claudeToken:{label:'no path',tokenFile:'relative.token'}})});
    expect(invalid.status).toBe(400); expect(read).toHaveBeenCalledTimes(1);
    enabled = false;
    const disabled = await app.request('/api/provider/usage/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude', claudeToken: B }) });
    expect(disabled.status).toBe(409); expect(read).toHaveBeenCalledTimes(1);
  });
});
