// OPR.0.4.3.28 B2/B3 — self-provisioned activity-hook endpoint (url + token).
//
// The daemon generates a per-install activity-hook token and derives its own
// ingest URL so launched seats can reach /api/activity/hooks WITHOUT the
// operator seeding OPENRIG_URL / OPENRIG_ACTIVITY_HOOK_TOKEN into their shell
// (the confirmed live break — see the slice-28 IMPL-SPEC §1.1).
//
// The token is a LOCALHOST internal-auth HANDLE, not a founder-secret: kept out
// of logs/prints and stored mode-0600, but no redaction machinery is built
// around it (orch-advisor ruling 2026-07-02).
//
// - activity-hook-token : durable token, STABLE across daemon restarts so
//   already-launched seats (whose env froze the token at launch) still
//   authenticate after a restart.
// - activity-endpoint.json : {baseUrl, token} snapshot, re-written each boot,
//   read by the relay's file-discovery fallback for reconcile/restored seats
//   whose frozen process env carries no OpenRig activity vars (B3).

import fs from "node:fs";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";

const TOKEN_FILE = "activity-hook-token";
const ENDPOINT_FILE = "activity-endpoint.json";
const DEFAULT_DAEMON_PORT = "7433";

/** OPR.0.4.3.28 B2 — derive the activity ingest URL the daemon injects into seats
 *  from its OWN bound host+port, so the seat's relay posts to an address the
 *  daemon is actually listening on. When OPENRIG_HOST is an explicit host
 *  (loopback, localhost, a tailnet IP, a hostname) the daemon binds ONLY that
 *  host, so the URL MUST use it — a hardcoded 127.0.0.1 would be unreachable.
 *  Wildcard/bind-all hosts (0.0.0.0 / ::) are not connectable addresses and the
 *  daemon also binds loopback there, so they map to 127.0.0.1. An absent host
 *  (the default loopback+tailscale multi-bind) also uses loopback. */
export function deriveActivityUrl(host: string | undefined, port: string | undefined): string {
  const p = port && port.trim().length > 0 ? port.trim() : DEFAULT_DAEMON_PORT;
  const h = host?.trim();
  const wildcard = !h || h === "0.0.0.0" || h === "::" || h === "[::]" || h === "*";
  return `http://${wildcard ? "127.0.0.1" : h}:${p}`;
}

/** Read the durable activity-hook token from state, or generate + persist one.
 *  Stable across restarts (so frozen-env seats keep authenticating). */
export function ensureActivityHookToken(stateDir: string): string {
  const tokenPath = nodePath.join(stateDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(tokenPath, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // not present yet — generate below
  }
  const token = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600); // enforce mode even if the file pre-existed
  } catch {
    // best-effort persist — an in-memory token still works for this daemon run,
    // it just won't survive a restart (falls back to regenerate).
  }
  return token;
}

/** Snapshot the current {baseUrl, token} to activity-endpoint.json (mode 0600)
 *  for the relay file-discovery fallback (B3). Best-effort. */
export function writeActivityEndpointFile(stateDir: string, endpoint: { baseUrl: string; token: string }): void {
  const endpointPath = nodePath.join(stateDir, ENDPOINT_FILE);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(endpointPath, JSON.stringify({ baseUrl: endpoint.baseUrl, token: endpoint.token }), { mode: 0o600 });
    fs.chmodSync(endpointPath, 0o600);
  } catch {
    // best-effort — reconcile/restored seats simply won't get file-discovery.
  }
}

/** Read {baseUrl, token} from activity-endpoint.json, or null if absent/invalid.
 *  (The relay .cjs reads the file directly; this is for daemon-side use + tests.) */
export function readActivityEndpointFile(stateDir: string): { baseUrl: string; token: string } | null {
  const endpointPath = nodePath.join(stateDir, ENDPOINT_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(endpointPath, "utf-8")) as { baseUrl?: unknown; token?: unknown };
    if (typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0
      && typeof parsed.token === "string" && parsed.token.length > 0) {
      return { baseUrl: parsed.baseUrl, token: parsed.token };
    }
  } catch {
    // absent or malformed
  }
  return null;
}
