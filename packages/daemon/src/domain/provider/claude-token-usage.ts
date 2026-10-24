// Explicit credential-labelled usage probes. No read/render path invokes a model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeExecutable, runClaudeCommand } from "./claude-auth-status-reader.js";
import { UsageWindows, type UsageReadOutcome, type UsageReadingStore } from "./usage-windows.js";
import type { ClaudeTokenIdentity, ClaudeTokenProbe, ProviderUsageAllowance } from "./provider-types.js";

export interface ClaudeTokenSelection { label: string; tokenFile: string }
export interface ClaudeTokenAnswer { windows: import("./usage-windows.js").UsageReadWindow[]; probe: ClaudeTokenProbe }
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const status = (v: unknown): string | null => typeof v === "string" && ["allowed", "allowed_warning", "rejected"].includes(v) ? v : null;
const reset = (v: unknown): string | null => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 8640000000000 ? new Date(v * 1000).toISOString() : null;

/** Select only usage fields. Neither model text, raw errors nor auth/session payloads are retained. */
export function parseClaudeTokenUsage(stdout: string): ClaudeTokenAnswer | null {
  const windows = new Map<string, import("./usage-windows.js").UsageReadWindow>();
  let info: Record<string, unknown> | null = null, cliVersion: string | null = null;
  let requestOutcome: ClaudeTokenProbe["requestOutcome"] = "unknown";
  for (const line of stdout.split("\n")) {
    let event: Record<string, unknown> | null;
    try { event = object(JSON.parse(line)); } catch { continue; }
    if (event?.type === "result") requestOutcome = event.is_error === true ? "failed" : event.subtype === "success" ? "completed" : "unknown";
    if (event?.type === "system" && typeof event.claude_code_version === "string" && /^\d+\.\d+\.\d+$/.test(event.claude_code_version)) cliVersion = event.claude_code_version;
    if (event?.type !== "rate_limit_event") continue;
    const next = object(event.rate_limit_info);
    if (!next) continue;
    info = next;
    const unified = object(info.unifiedWindows) ?? {};
    const entries = { ...unified };
    if (typeof info.rateLimitType === "string" && !entries[info.rateLimitType]) entries[info.rateLimitType] = info;
    for (const [name, raw] of Object.entries(entries)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) continue;
      const w = object(raw); if (!w) continue;
      const fraction = typeof w.utilization === "number" && Number.isFinite(w.utilization) && w.utilization >= 0 && w.utilization <= 1 ? w.utilization : null;
      if (fraction === null && reset(w.resetsAt) === null && status(w.status) === null) continue;
      windows.set(name, { window: name, durationMins: name === "five_hour" ? 300 : name === "seven_day" ? 10080 : null,
        usedPercent: fraction === null ? null : Math.round(fraction * 10000) / 100, resetsAt: reset(w.resetsAt),
        ...(status(w.status) ? { status: status(w.status)! } : {}) });
    }
  }
  if (!info || windows.size === 0) return null;
  for (const name of ["five_hour", "seven_day"]) if (!windows.has(name)) windows.set(name, {
    window: name, durationMins: name === "five_hour" ? 300 : 10080, usedPercent: null, resetsAt: null,
  });
  return { windows: [...windows.values()], probe: { exitCode: null, requestOutcome, cliVersion, status: status(info.status), overageStatus: status(info.overageStatus),
    overageDisabledReason: typeof info.overageDisabledReason === "string" && ["org_level_disabled", "org_level_limit", "extra_usage_disabled", "extra_usage_limit"].includes(info.overageDisabledReason) ? info.overageDisabledReason : info.overageDisabledReason === undefined ? null : "other (not retained)",
    isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null } };
}

/** Token only in the child's environment, isolated from shared logins, API keys, projects and user hooks. */
export function claudeTokenUsageReader(options: { launchPath?: string; timeoutMs?: number; graceMs?: number; now?: () => string } = {}) {
  return async (selection: ClaudeTokenSelection): Promise<UsageReadOutcome<ClaudeTokenAnswer>> => {
    const now = options.now ?? (() => new Date().toISOString());
    const warnings: string[] = [];
    const fail = (reason: string, detail: string) => ({ ok: false as const, at: now(), reason, detail: [detail, ...warnings].join("; ") });
    const executable = resolveClaudeExecutable({ PATH: options.launchPath ?? process.env.PATH });
    if (!executable) return fail("binary_not_found", "no claude executable on the daemon's PATH");
    let scratch: string | undefined;
    try {
      if (fs.lstatSync(selection.tokenFile).isSymbolicLink()) warnings.push("token file is a symlink; the opened target is checked");
      const fd = fs.openSync(selection.tokenFile, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      let token: string;
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > 8192) return fail("credential_file_unavailable", "token file must be a regular file, at most 8 KiB");
        if ((st.mode & 0o077) !== 0) warnings.push("token file has group/others permission bits; mode 0600 or 0400 is recommended");
        if (process.getuid && st.uid !== process.getuid()) warnings.push(`token file is owned by uid ${st.uid}, not the daemon user`);
        token = fs.readFileSync(fd, "utf8").trim();
      } finally { fs.closeSync(fd); }
      if (!token || /\s/.test(token)) return fail("credential_file_unavailable", "token file must hold one nonempty token");
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-usage-"));
      const env: NodeJS.ProcessEnv = { PATH: options.launchPath ?? process.env.PATH, HOME: scratch, CLAUDE_CONFIG_DIR: scratch,
        CLAUDE_CODE_OAUTH_TOKEN: token, DISABLE_AUTOUPDATER: "1" };
      for (const key of ["TMPDIR", "SYSTEMROOT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) if (process.env[key]) env[key] = process.env[key];
      const r = await runClaudeCommand(executable, env, scratch, options.timeoutMs ?? 30_000, options.graceMs ?? 1_000,
        ["-p", "Reply with exactly: OK", "--model", "haiku", "--max-turns", "1", "--output-format", "stream-json", "--verbose",
          "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence",
          "--settings", '{"disableAllHooks":true}']);
      if (r.timedOut) return fail("probe_timeout", "usage probe timed out; a provider turn may have been consumed");
      if (r.error || r.signal) return fail("probe_failed", "usage probe could not complete; provider effects are unknown");
      const answer = parseClaudeTokenUsage(r.stdout);
      if (!answer) return fail(r.code === 0 ? "no_usage_event" : "probe_failed", "no recognized usage event; authentication, refusal and quota are not inferred from missing output");
      const observedAt = now();
      // Version is local metadata, not another model turn. Never give this child the credential.
      if (answer.probe.cliVersion === null) {
        const versionEnv = { ...env }; delete versionEnv.CLAUDE_CODE_OAUTH_TOKEN;
        const version = await runClaudeCommand(executable, versionEnv, scratch, 3_000, options.graceMs ?? 1_000, ["--version"]);
        const match = version.code === 0 ? /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?\s*$/.exec(version.stdout.trim()) : null;
        answer.probe.cliVersion = match?.[1] ?? null;
      }
      return { ok: true, observedAt, ...answer, probe: { ...answer.probe, exitCode: r.code, ...(warnings.length ? { warnings } : {}) } };
    } catch { return fail("credential_or_probe_failed", "credential file or isolated probe unavailable; no raw provider output retained"); }
    finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
  };
}

export const tokenUsageKey = (s: ClaudeTokenSelection): string => `claude-token:${JSON.stringify([s.tokenFile, s.label])}`;

/** Reuse the existing refresh coalescer, freshness rules and reading history; each selected reference has its own failure. */
export class ClaudeTokenUsage {
  private readonly sources = new Map<string, UsageWindows<ClaudeTokenIdentity, ClaudeTokenAnswer>>();
  constructor(private readonly deps: { read: ReturnType<typeof claudeTokenUsageReader>; store?: UsageReadingStore<ClaudeTokenIdentity>; now?: () => string }) {
    try {
      for (const { reading } of deps.store?.latestAll() ?? []) this.source({ label: reading.identity.credentialLabel, tokenFile: reading.identity.credentialRef });
    } catch { /* unreadable history starts empty; it must not stop the daemon */ }
  }
  private source(selection: ClaudeTokenSelection) {
    const key = tokenUsageKey(selection);
    let source = this.sources.get(key);
    if (!source) {
      const store = this.deps.store;
      source = new UsageWindows<ClaudeTokenIdentity, ClaudeTokenAnswer>({ provider: "claude", sourceKind: "claude_token_probe", now: this.deps.now,
        key: id => tokenUsageKey({ label: id.credentialLabel, tokenFile: id.credentialRef }),
        read: () => this.deps.read(selection),
        normalize: answer => ({ ok: true, readings: [{ identity: { source: "configured credential label", credentialLabel: selection.label,
          credentialRef: selection.tokenFile, limitId: "provider-reported windows" }, windows: answer.windows, probe: answer.probe, limitEvidence: null, observedAt: answer.observedAt }] }),
        ...(store ? { store: { record: store.record.bind(store), lastExhaustion: store.lastExhaustion.bind(store), latestAll: () => store.latestAll().filter(x => x.key === key) } } : {}) });
      this.sources.set(key, source);
    }
    return source;
  }
  refresh(selection: ClaudeTokenSelection) { return this.source({ ...selection }).refresh(); }
  project(now: string): ProviderUsageAllowance[] {
    return [...this.sources.entries()].flatMap(([key, source]) => source.project(now).map(row => ({ ...row,
      identity: row.identity ?? { source: "configured credential label" as const, credentialRef: JSON.parse(key.slice("claude-token:".length))[0], credentialLabel: JSON.parse(key.slice("claude-token:".length))[1], limitId: "provider-reported windows" },
      currentAvailability: "unknown" as const, accountHistory: "unknown" as const,
      identityNote: "operator-labelled credential, not provider-observed account identity; no seat linkage or cross-host allowance join",
      unavailableReason: "this reading names a credential reference; the provider did not identify its account or all model-specific limits",
      signIn: { state: row.retained || row.lastRefresh?.outcome !== "ok" || row.probe?.exitCode !== 0 || row.probe?.requestOutcome !== "completed" ? "unknown" as const : !["allowed", "allowed_warning"].includes(row.probe?.status ?? "") ? "unknown" as const : "usable" as const,
        at: row.lastRefresh?.at ?? null, evidence: "usage event under the explicitly selected credential; a rejection is not proof the token is revoked" },
    })));
  }
}
