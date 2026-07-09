// OPR.0.4.4.13 — the host-registry verbs (add / list / doctor — arch
// R13-2a: no edit/remove/tunnel/bootstrap verbs; hand-editing hosts.yaml
// remains the path for exotica; the bootstrap ships as script + runbook).
// OPR.0.4.6.MH1 FR-1 extends the family with `select` — the persisted
// host-selection pointer (kubectl current-context shape). The pointer
// lives in the config twins as `host.selected`; this verb is a THIN
// CLIENT of the daemon config write (one write path for CLI+UI
// convergence, arch ruling); reads resolve from the local ConfigStore
// (env > file > default — zero new daemon lookups on read paths).
//
// Secret hygiene (FR-1): every render carries bearer POINTERS (env var /
// file NAMES) only — no code path in this file resolves a bearer value
// for display.

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname as osHostname, userInfo } from "node:os";
import { connect } from "node:net";
import { getOpenRigHome } from "../openrig-compat.js";
import { addHostEntry, defaultHostRegistryPath, loadHostRegistry, validateHostRegistry, hostDisplayTarget, resolveHost, resolveRemoteBearer, type HostEntry, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type CrossHostResult } from "../cross-host-executor.js";
import { DaemonClient } from "../client.js";
import { readOwnHostName, readSelectedHost } from "../host-selection.js";

// ---------------------------------------------------------------------------
// rig host doctor — stepwise, honest, three-valued (FR-1 + FR-2).
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "unknown";

export interface CheckRow {
  step: string;
  status: CheckStatus;
  detail: string;
  /** Actionable next step; REQUIRED for fail, encouraged for unknown. */
  fix?: string;
}

export interface DoctorDeps {
  run: (host: HostEntry, argv: readonly string[]) => Promise<CrossHostResult>;
  httpGet: (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string }>;
  /** OPR.0.4.6.MH1 FR-6: bounded JSON POST for the pair handshake.
   *  Optional so existing DoctorDeps fixtures keep compiling; the pair
   *  verb falls back to plain fetch when absent. */
  httpPost?: (url: string, body: unknown) => Promise<{ status: number; body: string }>;
  /** TCP connect probe: "open" (connected) | "closed" (refused/filtered/timeout) | "unknown" (probe itself failed). */
  tcpProbe: (target: string, port: number, timeoutMs: number) => Promise<"open" | "closed" | "unknown">;
}

function nestedBoolean(obj: unknown, path: readonly string[]): boolean | undefined {
  let cur: unknown = obj;
  for (const part of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "boolean" ? cur : undefined;
}

function tailscaleRunSshFromPrefs(text: string): boolean | undefined {
  if (!text.trim().startsWith("{")) return undefined;
  const parsed = JSON.parse(text) as unknown;
  return nestedBoolean(parsed, ["RunSSH"])
    ?? nestedBoolean(parsed, ["Prefs", "RunSSH"])
    ?? nestedBoolean(parsed, ["CurrentProfile", "RunSSH"]);
}

function defaultDoctorDeps(): DoctorDeps {
  return {
    run: (host, argv) => runCrossHostCommand(host, argv),
    httpGet: async (url, headers) => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      return { status: res.status, body: await res.text() };
    },
    httpPost: async (url, body) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: await res.text() };
    },
    tcpProbe: (target, port, timeoutMs) =>
      new Promise((resolve) => {
        const sock = connect({ host: target, port, timeout: timeoutMs });
        sock.on("connect", () => { sock.destroy(); resolve("open"); });
        sock.on("timeout", () => { sock.destroy(); resolve("closed"); });
        sock.on("error", () => { sock.destroy(); resolve("closed"); });
      }),
  };
}

/** FR-1 doctor legs — each failing step maps to a DISTINCT actionable error:
 *  "SSH works but daemon is down" ≠ "daemon works but registry is wrong" ≠
 *  "remote rig binary missing/old". */
/** OPR.0.4.6.MH1 FR-3 — the coarse ls status word: a BOUNDED tcp dial
 *  against the host's transport endpoint (ssh: target:22; http: the
 *  URL's host:port). Coarse by design (the kubectl STATUS / docker
 *  context ls precedent): reachable | unreachable | unknown — never a
 *  hang (hard timeout), never a guess (dial failure = unreachable,
 *  probe error/unparseable endpoint = unknown). */
export async function probeHostStatus(
  host: HostEntry,
  tcpProbe: DoctorDeps["tcpProbe"],
  timeoutMs = 1500,
): Promise<"reachable" | "unreachable" | "unknown"> {
  try {
    let target: string;
    let port: number;
    if (host.transport === "ssh") {
      target = host.target;
      port = 22;
    } else {
      const u = new URL(host.url);
      target = u.hostname;
      port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    }
    const r = await tcpProbe(target, port, timeoutMs);
    return r === "open" ? "reachable" : r === "closed" ? "unreachable" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function doctorLegs(host: HostEntry, deps: DoctorDeps): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];

  if (host.transport === "ssh") {
    const reach = await deps.run(host, ["true"]);
    if (!reach.ok && (reach.failedStep === "ssh-unreachable" || reach.failedStep === "permission-gate")) {
      rows.push({
        step: "transport-reachability",
        status: "fail",
        detail: `ssh to ${host.target} failed (${reach.failedStep}): ${reach.sshStderr.trim()}`,
        fix: reach.failedStep === "permission-gate"
          ? "SSH auth/permission gate — check the key, agent, and remote authorized_keys"
          : "verify the ssh target/alias, tailnet connectivity, and that sshd is running",
      });
      return rows; // later legs are meaningless without the shell
    }
    rows.push({ step: "transport-reachability", status: "pass", detail: `ssh to ${host.target} ok` });

    const version = await deps.run(host, ["rig", "--version"]);
    if (!version.ok) {
      rows.push({
        step: "remote-rig-binary",
        status: "fail",
        detail: "reached the remote shell, but `rig --version` failed — remote rig binary missing or broken",
        fix: "install the published artifact on the host: npm install -g @openrig/cli (see the product-factory runbook)",
      });
      return rows;
    }
    rows.push({ step: "remote-rig-binary", status: "pass", detail: `remote rig ${version.stdout.trim() || "(version unreadable)"}` });

    const daemon = await deps.run(host, ["rig", "daemon", "status"]);
    const daemonUp = daemon.ok && /running/i.test(daemon.stdout);
    rows.push(daemonUp
      ? { step: "remote-daemon-health", status: "pass", detail: "remote daemon reports running" }
      : {
          step: "remote-daemon-health",
          status: "fail",
          detail: "SSH works and rig is installed, but the remote daemon is not running",
          fix: "on the host: rig daemon start (then re-run doctor)",
        });
    if (!daemonUp) return rows;

    const whoami = await deps.run(host, ["rig", "ps", "--json", "--limit", "5"]);
    let identityOk = false;
    if (whoami.ok) {
      try { identityOk = typeof JSON.parse(whoami.stdout) === "object"; } catch { identityOk = false; }
    }
    rows.push(identityOk
      ? { step: "remote-identity", status: "pass", detail: "remote daemon identity/list resolves (rig ps --json parses)" }
      : {
          step: "remote-identity",
          status: "fail",
          detail: "daemon is up but remote identity/list did not resolve",
          fix: "on the host: check `rig ps --json` directly; the daemon API may be unhealthy even though status says running",
        });
    return rows;
  }

  // http transport
  const bearer = resolveRemoteBearer(host as HttpHostEntry);
  if (!bearer.ok) {
    rows.push({ step: "transport-reachability", status: "fail", detail: bearer.error, fix: "set the bearer env var / file the registry entry points at (pointer names: rig host list)" });
    return rows;
  }
  try {
    const health = await deps.httpGet(`${(host as HttpHostEntry).url}/healthz`, { Authorization: `Bearer ${bearer.token}` });
    if (health.status === 401 || health.status === 403) {
      rows.push({ step: "transport-reachability", status: "fail", detail: `daemon reachable but rejected the bearer (HTTP ${health.status})`, fix: "registry is reachable but the token is wrong — rotate/set the bearer the entry points at" });
      return rows;
    }
    if (health.status < 200 || health.status >= 300) {
      rows.push({ step: "transport-reachability", status: "fail", detail: `healthz returned HTTP ${health.status}`, fix: "the daemon answered abnormally — check remote daemon logs" });
      return rows;
    }
    rows.push({ step: "transport-reachability", status: "pass", detail: `healthz ok at ${(host as HttpHostEntry).url}` });
    rows.push({ step: "remote-daemon-health", status: "pass", detail: "healthz IS the daemon health check on http transport" });
  } catch (err) {
    rows.push({ step: "transport-reachability", status: "fail", detail: `daemon unreachable at ${(host as HttpHostEntry).url}: ${(err as Error).message}`, fix: "check tailnet connectivity and that the remote daemon is running (rig daemon start on the host)" });
    return rows;
  }
  rows.push({
    step: "remote-rig-binary",
    status: "unknown",
    detail: "not determinable over http transport (no shell)",
    fix: "verify via an ssh-transport entry for this host, or on the host directly: rig --version",
  });
  try {
    const ps = await deps.httpGet(`${(host as HttpHostEntry).url}/api/ps`, { Authorization: `Bearer ${bearer.token}` });
    rows.push(ps.status >= 200 && ps.status < 300
      ? { step: "remote-identity", status: "pass", detail: "authenticated daemon API answers (/api/ps)" }
      : { step: "remote-identity", status: "fail", detail: `/api/ps returned HTTP ${ps.status}`, fix: "daemon healthz is up but the API is unhealthy — check remote daemon logs" });
  } catch (err) {
    rows.push({ step: "remote-identity", status: "fail", detail: `/api/ps unreachable: ${(err as Error).message}`, fix: "check remote daemon logs" });
  }
  return rows;
}

/** FR-2 — THE one built-in posture profile (arch R13-2b: a named constant
 *  table, no framework). Every item is three-valued; UNKNOWN is never
 *  smoothed to pass, and every non-pass carries its fix. */
export const POSTURE_PROFILE_ID = "product-factory-vps";

export async function postureCheck(
  host: HostEntry,
  deps: DoctorDeps,
  opts: { publicAddr?: string } = {},
): Promise<CheckRow[]> {
  if (host.transport !== "ssh") {
    // Posture needs a shell. Report every item unknown — honestly.
    return POSTURE_ITEM_IDS.map((id) => ({
      step: id,
      status: "unknown" as const,
      detail: "posture checks need shell access; this host is registered with http transport",
      fix: "register an ssh-transport entry for this host (or run the checks on the host per the runbook)",
    }));
  }

  const rows: CheckRow[] = [];
  const sh = async (cmd: string) => deps.run(host, ["sh", "-c", cmd]);

  // 1. non-root openrig user
  const idOut = await sh("id -u openrig 2>/dev/null");
  if (idOut.ok && idOut.stdout.trim() !== "") {
    rows.push(idOut.stdout.trim() === "0"
      ? { step: "nonroot-openrig-user", status: "fail", detail: "user 'openrig' resolves to uid 0", fix: "create a non-root openrig user per the runbook" }
      : { step: "nonroot-openrig-user", status: "pass", detail: `user 'openrig' uid ${idOut.stdout.trim()}` });
  } else {
    rows.push({ step: "nonroot-openrig-user", status: "fail", detail: "user 'openrig' does not exist", fix: "adduser openrig + key-only SSH per the runbook" });
  }

  // 2+3. sshd effective config (root SSH off, password auth off)
  const sshd = await sh("sudo -n sshd -T 2>/dev/null || sshd -T 2>/dev/null || true");
  const sshdOut = sshd.ok ? sshd.stdout.toLowerCase() : "";
  const sshdItem = (step: string, key: string, want: string): CheckRow => {
    if (!sshdOut.includes(key)) {
      return { step, status: "unknown", detail: "effective sshd config not readable from this vantage (sshd -T needs root)", fix: "on the host: sudo sshd -T | grep " + key };
    }
    return sshdOut.includes(`${key} ${want}`)
      ? { step, status: "pass", detail: `${key} ${want}` }
      : { step, status: "fail", detail: `sshd -T reports ${key} != ${want}`, fix: `set ${key} ${want} in /etc/ssh/sshd_config.d/99-openrig-hardening.conf and reload sshd` };
  };
  rows.push(sshdItem("root-ssh-disabled", "permitrootlogin", "no"));
  rows.push(sshdItem("key-only-ssh", "passwordauthentication", "no"));

  // 4+5. UFW default-deny + tailnet ingress
  const ufw = await sh("sudo -n ufw status verbose 2>/dev/null || true");
  const ufwOut = ufw.ok ? ufw.stdout.toLowerCase() : "";
  if (ufwOut.trim() === "") {
    const unknownUfw = (step: string): CheckRow => ({ step, status: "unknown", detail: "ufw status not readable from this vantage (needs sudo)", fix: "on the host: sudo ufw status verbose" });
    rows.push(unknownUfw("ufw-default-deny-incoming"));
    rows.push(unknownUfw("tailnet-ingress-allowed"));
  } else {
    rows.push(/default:\s*deny\s*\(incoming/.test(ufwOut)
      ? { step: "ufw-default-deny-incoming", status: "pass", detail: "ufw default deny (incoming)" }
      : { step: "ufw-default-deny-incoming", status: "fail", detail: "ufw incoming default is not deny", fix: "sudo ufw default deny incoming" });
    // R2-B1: mentioning tailscale0 is NOT enough — a DENY on tailscale0
    // must never pass. Pass requires an ALLOW IN rule on the interface.
    const tailnetAllowIn = ufwOut.split("\n").some((line) => line.includes("tailscale0") && /allow\s+in/.test(line));
    if (tailnetAllowIn) {
      rows.push({ step: "tailnet-ingress-allowed", status: "pass", detail: "ufw has an ALLOW IN rule on tailscale0" });
    } else if (ufwOut.includes("tailscale0")) {
      rows.push({ step: "tailnet-ingress-allowed", status: "fail", detail: "tailscale0 appears in ufw rules but with no ALLOW IN rule (deny/other only)", fix: "sudo ufw allow in on tailscale0" });
    } else {
      rows.push({ step: "tailnet-ingress-allowed", status: "fail", detail: "no tailscale0 allow rule found", fix: "sudo ufw allow in on tailscale0" });
    }
  }

  // 6. tailscale flags (no subnet routes / exit node / ts-SSH)
  const ts = await sh("tailscale status --json 2>/dev/null || true");
  const prefs = await sh("tailscale debug prefs --json 2>/dev/null || true");
  let routes: number | undefined;
  let exitNode: boolean | undefined;
  let runSsh: boolean | undefined;
  const unknownReasons: string[] = [];
  try {
    if (ts.ok && ts.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(ts.stdout) as { Self?: { PrimaryRoutes?: unknown[]; ExitNodeOption?: boolean }; ExitNodeStatus?: unknown };
      routes = parsed.Self?.PrimaryRoutes?.length ?? 0;
      exitNode = (parsed.ExitNodeStatus !== undefined && parsed.ExitNodeStatus !== null) || parsed.Self?.ExitNodeOption === true;
    } else {
      unknownReasons.push("tailscale status unreadable");
    }
  } catch {
    unknownReasons.push("tailscale status did not parse");
  }
  try {
    runSsh = prefs.ok ? tailscaleRunSshFromPrefs(prefs.stdout) : undefined;
    if (runSsh === undefined) unknownReasons.push("tailscale debug prefs unreadable");
  } catch {
    unknownReasons.push("tailscale debug prefs did not parse");
  }
  if ((routes ?? 0) > 0 || exitNode === true || runSsh === true) {
    rows.push({
      step: "tailscale-minimal-trust",
      status: "fail",
      detail: `subnet routes: ${routes ?? "unknown"}; exit node in use: ${exitNode ?? "unknown"}; Tailscale SSH enabled: ${runSsh ?? "unknown"}`,
      fix: "remove advertised routes / exit-node use (tailscale set) and disable Tailscale SSH: tailscale set --ssh=false",
    });
  } else if (routes === 0 && exitNode === false && runSsh === false) {
    rows.push({ step: "tailscale-minimal-trust", status: "pass", detail: "no advertised subnet routes; no exit-node use; Tailscale SSH disabled" });
  } else {
    rows.push({
      step: "tailscale-minimal-trust",
      status: "unknown",
      detail: `tailscale posture not fully determined (${unknownReasons.join("; ")})`,
      fix: "on the host: tailscale status --json && tailscale debug prefs --json; disable Tailscale SSH with tailscale set --ssh=false",
    });
  }

  // 7. daemon bound loopback/tailnet — never public. R2-B1: a SPECIFIC
  // public IP bind must fail exactly like a wildcard — pass is an
  // ALLOWLIST (loopback or the tailnet CGNAT range 100.64.0.0/10), never
  // "not wildcard".
  const ss = await sh("ss -tln 2>/dev/null | grep ':7433' || true");
  const ssOut = ss.ok ? ss.stdout : "";
  const listenAddrs = ssOut
    .split("\n")
    .map((line) => line.match(/(\S+):7433\b/)?.[1])
    .filter((a): a is string => a !== undefined);
  if (listenAddrs.length === 0) {
    rows.push({ step: "daemon-bind-not-public", status: "unknown", detail: "no listener on :7433 observed (daemon may be down)", fix: "start the daemon, then re-check: ss -tln | grep 7433" });
  } else {
    const isLoopbackOrTailnet = (addr: string): boolean => {
      const a = addr.replace(/^\[|\]$/g, "");
      if (a.startsWith("127.") || a === "::1") return true;
      const m = a.match(/^100\.(\d+)\./);
      return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
    };
    const offending = listenAddrs.filter((a) => !isLoopbackOrTailnet(a));
    rows.push(offending.length === 0
      ? { step: "daemon-bind-not-public", status: "pass", detail: `listener(s) bound loopback/tailnet only: ${listenAddrs.join(", ")}` }
      : { step: "daemon-bind-not-public", status: "fail", detail: `daemon listens on a non-loopback/non-tailnet address: ${offending.join(", ")}`, fix: "bind the daemon to loopback/tailnet only (OPENRIG daemon host config); never expose :7433 publicly" });
  }

  // 8+9. public reachability probes — only meaningful with a known PUBLIC address.
  if (opts.publicAddr) {
    for (const [step, port] of [["public-daemon-port-unreachable", 7433], ["public-ssh-unreachable-or-accepted", 22]] as const) {
      const probe = await deps.tcpProbe(opts.publicAddr, port, 5000);
      rows.push(probe === "open"
        ? { step, status: "fail", detail: `${opts.publicAddr}:${port} is publicly reachable`, fix: "remove the public allow rule / firewall the port (the smoke-test hardening bar: public :22/:7433 time out)" }
        : { step, status: "pass", detail: `${opts.publicAddr}:${port} not reachable (${probe})` });
    }
  } else {
    const unknownProbe = (step: string, port: number): CheckRow => ({
      step, status: "unknown",
      detail: `public reachability of :${port} not probed (no public address known — the registry target may be a tailnet alias)`,
      fix: `re-run with --public-addr <ip> to probe from this vantage`,
    });
    rows.push(unknownProbe("public-daemon-port-unreachable", 7433));
    rows.push(unknownProbe("public-ssh-unreachable-or-accepted", 22));
  }

  return rows;
}

export const POSTURE_ITEM_IDS = [
  "nonroot-openrig-user",
  "root-ssh-disabled",
  "key-only-ssh",
  "ufw-default-deny-incoming",
  "tailnet-ingress-allowed",
  "tailscale-minimal-trust",
  "daemon-bind-not-public",
  "public-daemon-port-unreachable",
  "public-ssh-unreachable-or-accepted",
] as const;

function renderRows(rows: CheckRow[], json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(rows));
    return;
  }
  const glyph = { pass: "✓", fail: "✗", unknown: "?" } as const;
  for (const r of rows) {
    console.log(`${glyph[r.status]} ${r.step}: ${r.detail}${r.fix ? `\n    fix: ${r.fix}` : ""}`);
  }
}

function authPointer(h: HostEntry): string {
  if (h.transport === "ssh") return "ssh-key";
  return h.bearer_env ? `env:${h.bearer_env}` : h.bearer_file ? `file:${h.bearer_file}` : "—";
}

export function hostCommand(doctorDepsOverride?: DoctorDeps): Command {
  const cmd = new Command("host").description("Manage the multi-host registry (~/.openrig/hosts.yaml)");

  cmd
    .command("add")
    .description("Add a host entry (validated with the registry loader's own rules)")
    .requiredOption("--id <id>", "Unique host id")
    .requiredOption("--transport <transport>", "ssh or http")
    .option("--target <target>", "SSH target (DNS name, ssh-config alias, or IP) — ssh transport")
    .option("--user <user>", "SSH user — ssh transport")
    .option("--url <url>", "Remote daemon base URL — http transport")
    .option("--bearer-env <name>", "Env var NAME holding the bearer token — http transport (pointer, never a value)")
    .option("--bearer-file <path>", "File PATH holding the bearer token — http transport (pointer, never a value)")
    .option("--notes <text>", "Free-form operator note")
    .option("--json", "JSON output")
    .action((opts: { id: string; transport: string; target?: string; user?: string; url?: string; bearerEnv?: string; bearerFile?: string; notes?: string; json?: boolean }) => {
      const rawEntry: Record<string, unknown> = { id: opts.id, transport: opts.transport };
      if (opts.target !== undefined) rawEntry["target"] = opts.target;
      if (opts.user !== undefined) rawEntry["user"] = opts.user;
      if (opts.url !== undefined) rawEntry["url"] = opts.url;
      if (opts.bearerEnv !== undefined) rawEntry["bearer_env"] = opts.bearerEnv;
      if (opts.bearerFile !== undefined) rawEntry["bearer_file"] = opts.bearerFile;
      if (opts.notes !== undefined) rawEntry["notes"] = opts.notes;

      const res = addHostEntry(rawEntry);
      if (!res.ok) {
        console.error(res.error);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, path: res.path, entry: res.entry }));
        return;
      }
      console.log(`Added host '${res.entry.id}' (${res.entry.transport}) to ${res.path}`);
      console.log(`Verify it: rig host doctor ${res.entry.id}`);
    });

  cmd
    .command("select")
    .description("Select which host you are viewing/acting on (persisted; 'local' returns to this host)")
    .argument("<id>", "A registered host id, or 'local'")
    .option("--json", "JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      // Validate BEFORE persisting: 'local' is always legal; anything
      // else must be a registered host id.
      if (id !== "local") {
        const registryPath = defaultHostRegistryPath();
        const loaded = existsSync(registryPath) ? loadHostRegistry(registryPath) : null;
        if (!loaded || !loaded.ok) {
          console.error(
            loaded && !loaded.ok
              ? loaded.error
              : `cannot select '${id}': no hosts registered (no registry at ${registryPath}). Add one first: rig host add --id <id> --transport <ssh|http> ...`,
          );
          process.exitCode = 1;
          return;
        }
        const ids = loaded.registry.hosts.map((h) => h.id);
        if (!ids.includes(id)) {
          console.error(
            `cannot select '${id}': not a registered host id. Registered: ${ids.length > 0 ? ids.join(", ") : "(none)"}. Add it first: rig host add --id ${id} --transport <ssh|http> ... (or select 'local').`,
          );
          process.exitCode = 1;
          return;
        }
      }
      // ONE write path: the daemon config write (the CLI is a thin
      // client — arch FR-1 ruling). Daemon-down surfaces the existing
      // structured connection error (trade named in the PRD).
      const client = new DaemonClient();
      let res: { status: number; data: { ok?: boolean; error?: string } };
      try {
        res = await client.post<{ ok?: boolean; error?: string }>(
          `/api/config/${encodeURIComponent("host.selected")}`,
          { value: id },
        );
      } catch (err) {
        // Daemon down: the existing structured connection error, named
        // trade in the PRD (selection writes need the local daemon up).
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      if (res.status !== 200 || res.data?.error) {
        console.error(res.data?.error ?? `daemon config write failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, selected: id }));
        return;
      }
      console.log(id === "local" ? "Selected host: local (this host)" : `Selected host: ${id}`);
      console.log(id === "local" ? "Commands run against this host." : `Flagless commands that support --host now run against '${id}'. Return with: rig host select local`);
    });

  cmd
    .command("rename")
    .description("Rename THIS host's display name (renders in dashboard, explorer, ls, whoami)")
    .argument("<name>", 'The new display name, e.g. "Mac mini 2"')
    .option("--json", "JSON output")
    .action(async (name: string, opts: { json?: boolean }) => {
      // OPR.0.4.6.MH1 FR-4 — one stored name (the settings twins, arch
      // Ruling 1), one write path (the daemon config write, same as
      // select). The name is free text; only emptiness is rejected.
      const trimmed = name.trim();
      if (!trimmed) {
        console.error("host name must not be empty");
        process.exitCode = 1;
        return;
      }
      const client = new DaemonClient();
      let res: { status: number; data: { ok?: boolean; error?: string } };
      try {
        res = await client.post<{ ok?: boolean; error?: string }>(
          `/api/config/${encodeURIComponent("host.name")}`,
          { value: trimmed },
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      if (res.status !== 200 || res.data?.error) {
        console.error(res.data?.error ?? `daemon config write failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, name: trimmed }));
        return;
      }
      console.log(`This host is now named: ${trimmed}`);
    });

  cmd
    .command("pair")
    .description("Pair with a remote host from one pasted address — one approval on the target, done (FR-6)")
    .argument("<url>", "The target daemon's address (http[s]://host:port, or host:port)")
    .option("--id <id>", "Registry id for the new host (default: derived from the hostname)")
    .option("--timeout <seconds>", "How long to wait for the target-side approval", "600")
    .option("--json", "JSON output")
    .action(async (rawUrl: string, opts: { id?: string; timeout?: string; json?: boolean }) => {
      // OPR.0.4.6.MH1 FR-6 — THE founder-simple add path: one pasted
      // address, one approval ON the target, done. The flag-heavy
      // `rig host add` stays as the unchanged advanced path. B1: the CLI
      // keeps its direct-fs write (addHostEntry); the browser surface
      // pairs through its local daemon — both converge on the ONE write
      // contract.
      let target: URL;
      try {
        target = new URL(/^https?:\/\//.test(rawUrl.trim()) ? rawUrl.trim() : `http://${rawUrl.trim()}`);
      } catch {
        console.error(`'${rawUrl}' is not a usable address. Paste the target daemon's URL, e.g. http://vps-a:7433`);
        process.exitCode = 1;
        return;
      }
      const targetBase = target.origin;
      const deps = doctorDepsOverride ?? defaultDoctorDeps();

      // B1 fixback (guard code-review 2026-07-07): PREFLIGHT before any
      // network call or credential mutation. The candidate entry runs the
      // SAME validation contract the add will use (duplicate ids, reserved
      // ids, invalid existing registry all fail HERE — before the target
      // is asked for approval), and a pre-existing token file is
      // pre-existing CREDENTIAL STATE: rejected, never overwritten, and
      // never deleted by this request's cleanup.
      const id = (opts.id ?? "").trim() || target.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/\./g, "-").replace(/^-+|-+$/g, "") || "paired-host";
      const secretsDir = join(getOpenRigHome(), "secrets");
      const tokenPath = join(secretsDir, `host-${id}.token`);
      {
        const registryPath = defaultHostRegistryPath();
        let existing: HostEntry[] = [];
        if (existsSync(registryPath)) {
          const loaded = loadHostRegistry(registryPath);
          if (!loaded.ok) {
            console.error(`cannot pair: ${loaded.error}`);
            process.exitCode = 1;
            return;
          }
          existing = loaded.registry.hosts;
        }
        const preflight = validateHostRegistry(
          { hosts: [...existing, { id, transport: "http", url: targetBase, bearer_file: tokenPath }] },
          registryPath,
        );
        if (!preflight.ok) {
          console.error(`cannot pair as '${id}': ${preflight.error}`);
          process.exitCode = 1;
          return;
        }
        if (existsSync(tokenPath)) {
          console.error(`a credential file already exists at ${tokenPath} — pre-existing credential state is never overwritten. Pass --id <different-id>, or remove the file yourself if you know it is stale.`);
          process.exitCode = 1;
          return;
        }
      }

      const httpPost = deps.httpPost ?? (async (url: string, payload: unknown) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: res.status, body: await res.text() };
      });
      const parseJson = (s: string): Record<string, unknown> => {
        try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
      };

      let issued: { pairId?: string; code?: string; approvalQitemId?: string; error?: string; message?: string };
      try {
        const res = await httpPost(`${targetBase}/api/hosts/pair-request`, {
          requester: `${userInfo().username}@${osHostname()}`,
        });
        issued = parseJson(res.body) as typeof issued;
        if (res.status !== 200 || !issued.pairId || !issued.code) {
          console.error(issued.message ?? `pairing refused: target responded HTTP ${res.status}${issued.error ? ` (${issued.error})` : ""}`);
          process.exitCode = 1;
          return;
        }
      } catch (err) {
        console.error(`could not reach ${targetBase}: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      if (!opts.json) {
        console.log(`Pairing code: ${issued.code}`);
        console.log(`Waiting for approval on the target (its attention queue carries item ${issued.approvalQitemId ?? "?"}).`);
        console.log(`On the target: rig queue update ${issued.approvalQitemId ?? "<qitem-id>"} --state done --closure-reason no-follow-on`);
      }

      const timeoutMs = Math.max(1, Number(opts.timeout ?? "600") || 600) * 1000;
      const deadline = Date.now() + timeoutMs;
      let outcome: { status?: string; token?: string } = {};
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await deps.httpGet(`${targetBase}/api/hosts/pair-request/${issued.pairId}`);
          outcome = parseJson(res.body) as typeof outcome;
        } catch {
          continue; // transient poll failure: keep waiting until the deadline
        }
        if (outcome.status && outcome.status !== "pending") break;
      }

      if (outcome.status !== "approved" || !outcome.token) {
        const why = outcome.status === "denied" ? "the target DENIED the pairing"
          : outcome.status === "expired" ? "the pairing EXPIRED on the target"
          : "no approval arrived before the timeout";
        console.error(`pairing failed: ${why}. Nothing was persisted (no registry entry, no token file).`);
        process.exitCode = 1;
        return;
      }

      // Approved: token → EXCLUSIVE-CREATE 0600 file (open flag "wx" —
      // rev1-r2 B3: check-then-rename had a window where a concurrent
      // same-id pair could clobber the winner's file and then delete it
      // on its own add failure; "wx" is atomic at the filesystem, so
      // creation SUCCESS is the proof of ownership the cleanup relies
      // on), then the registry entry via the ONE shipped write path.
      // addHostEntry re-validates authoritatively (the registry may have
      // changed since preflight).
      try {
        mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
        writeFileSync(tokenPath, `${outcome.token}\n`, { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          console.error(`a credential file appeared at ${tokenPath} during pairing — refusing to overwrite it. Nothing was persisted by this request.`);
        } else {
          console.error(`failed to store the pairing token: ${(err as Error).message}`);
        }
        process.exitCode = 1;
        return;
      }
      const added = addHostEntry({
        id,
        transport: "http",
        url: targetBase,
        bearer_file: tokenPath,
        notes: `paired ${new Date().toISOString().slice(0, 10)}`,
      });
      if (!added.ok) {
        rmSync(tokenPath, { force: true });
        console.error(`pairing approved but the registry write failed: ${added.error}. The token file (created by this request) was removed — nothing persisted.`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, entry: added.entry }));
        return;
      }
      console.log(`Paired. Host '${id}' registered (${targetBase}, bearer_file ${tokenPath}).`);
      console.log(`Verify it: rig host doctor ${id}`);
    });

  cmd
    .command("list")
    // OPR.0.4.6.MH1 QA fixback: the PRD/proof contract spells the verb
    // `rig host ls` (FR-3); `list` stays the canonical name, `ls` is the
    // contract-required alias (same action, same --json).
    .alias("ls")
    .description("List registered hosts w/ status + selected marker (config pointers only — never secret values)")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const registryPath = defaultHostRegistryPath();
      if (!existsSync(registryPath)) {
        if (opts.json) {
          console.log(JSON.stringify([]));
          return;
        }
        console.log(`No hosts registered in ${registryPath}. Pair one from a single address: rig host pair <url> (advanced/manual path: rig host add --id <id> --transport <ssh|http> ...)`);
        return;
      }
      const loaded = loadHostRegistry(registryPath);
      if (!loaded.ok) {
        console.error(loaded.error);
        process.exitCode = 1;
        return;
      }
      // OPR.0.4.6.MH1 FR-1/FR-3: selected marker (local ConfigStore read —
      // env > file > default; zero daemon dependency) + a bounded status
      // probe per host (parallel; hard per-host timeout — never a hang).
      const selected = readSelectedHost();
      const probeDeps: DoctorDeps = doctorDepsOverride ?? defaultDoctorDeps();
      const statuses = await Promise.all(
        loaded.registry.hosts.map((h) => probeHostStatus(h, probeDeps.tcpProbe)),
      );
      if (opts.json) {
        // Entries as validated: bearer fields are NAMES by construction.
        // ADDITIVE ONLY (the shipped bare-array shape is a contract —
        // pre-MH1 consumers keep working): each row gains `selected` +
        // `status`; the scriptable selection pointer is the true row (or
        // `rig config get host.selected`).
        console.log(JSON.stringify(loaded.registry.hosts.map((h, i) => ({ ...h, selected: h.id === selected, status: statuses[i] }))));
        return;
      }
      if (loaded.registry.hosts.length === 0) {
        console.log(`No hosts registered in ${registryPath}. Pair one from a single address: rig host pair <url> (advanced/manual path: rig host add --id <id> --transport <ssh|http> ...)`);
        return;
      }
      // OPR.0.4.6.MH1 FR-4: the own-host name renders here when RENAMED;
      // unnamed (default "localhost") keeps today's output byte-identical
      // (the FR-4 zero-regression AC). Scriptable read: rig config get
      // host.name — the --json array stays registry rows only (shipped
      // bare-array contract).
      const ownName = readOwnHostName();
      if (ownName !== "localhost") {
        console.log(`This host: ${ownName}\n`);
      }
      const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
      console.log(`${pad("", 2)}${pad("ID", 20)} ${pad("TRANSPORT", 10)} ${pad("TARGET", 30)} ${pad("STATUS", 12)} ${pad("AUTH", 24)} NOTES`);
      for (let i = 0; i < loaded.registry.hosts.length; i++) {
        const h = loaded.registry.hosts[i]!;
        const marker = h.id === selected ? "* " : "  ";
        console.log(`${marker}${pad(h.id, 20)} ${pad(h.transport, 10)} ${pad(hostDisplayTarget(h), 30)} ${pad(statuses[i]!, 12)} ${pad(authPointer(h), 24)} ${h.notes ?? "—"}`);
      }
      if (selected !== "local") {
        console.log(`\nSelected host: ${selected} (return with: rig host select local)`);
      }
    });

  cmd
    .command("doctor")
    .description("Stepwise host verification (+ --posture for the product-factory-vps baseline)")
    .argument("<id>", "Registered host id")
    .option("--posture <profile>", `Run the posture baseline (only built-in profile: ${POSTURE_PROFILE_ID})`)
    .option("--public-addr <ip>", "Public address for the outside-vantage reachability probes (posture items 8-9)")
    .option("--json", "JSON output")
    .action(async (id: string, opts: { posture?: string; publicAddr?: string; json?: boolean }) => {
      const deps: DoctorDeps = doctorDepsOverride ?? defaultDoctorDeps();
      const loaded = loadHostRegistry();
      if (!loaded.ok) {
        console.error(loaded.error);
        process.exitCode = 1;
        return;
      }
      const resolved = resolveHost(loaded.registry, id);
      if (!resolved.ok) {
        // The DISTINCT "registry is wrong" error class.
        console.error(`registry: ${resolved.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.posture !== undefined && opts.posture !== POSTURE_PROFILE_ID) {
        console.error(`unknown posture profile '${opts.posture}'. The only built-in profile is: ${POSTURE_PROFILE_ID}`);
        process.exitCode = 1;
        return;
      }

      const rows = await doctorLegs(resolved.host, deps);
      if (opts.posture) {
        rows.push(...await postureCheck(resolved.host, deps, { publicAddr: opts.publicAddr }));
      }
      renderRows(rows, opts.json);
      if (rows.some((r) => r.status === "fail")) process.exitCode = 1;
      const unknowns = rows.filter((r) => r.status === "unknown").length;
      if (!opts.json && unknowns > 0) {
        console.log(`${unknowns} item${unknowns === 1 ? "" : "s"} UNKNOWN — unknown is not pass; see the fix lines to verify.`);
      }
    });

  return cmd;
}
