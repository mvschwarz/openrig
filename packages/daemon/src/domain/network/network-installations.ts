// This daemon enrolled in an account, so the person connects a seat by a name instead of a hub URL and a token file.
// Enrolling trades a one-time code from the account page for this installation's key. Connecting a seat lists the
// installation's participants with the account, which answers a bearer for a newly listed name, and the account's MCP
// front and rig, where the binding then reaches. A name the installation stops listing is revoked there.
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NetworkBindingError, readPrivateToken, writePrivateToken, type NetworkBinding, type NetworkBindingStore } from "./network-bindings.js";

export interface NetworkInstallation {
  id: string;
  site: string;
  /** The account's id for this installation. */
  installationId: string;
  name: string | null;
  allowHttp: boolean;
  createdAt: string;
}

interface Row { id: string; site: string; installation_id: string; name: string | null; allow_http: number; created_at: string }

const project = (row: Row): NetworkInstallation => ({
  id: row.id, site: row.site, installationId: row.installation_id, name: row.name, allowHttp: row.allow_http === 1, createdAt: row.created_at,
});

/** Where the installation key lives: `<home>/network-secrets/<installation>/key.json`, private to this user. */
export function networkInstallationKeyFile(home: string, id: string): string {
  if (!/^neti-[0-9a-f]{20}$/.test(id)) throw new NetworkBindingError("invalid_installation_id", `'${id}' isn't a network installation id.`);
  return join(home, "network-secrets", id, "key.json");
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** What the account answers for the installation's participant list. */
interface Identities { participants: Array<{ name: string; state?: string; bearer?: string }>; mcp: string; rig: string }

export type AccountFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal })
  => Promise<{ status: number; json(): Promise<unknown> }>;

/** How long one call to the account may take. */
const ACCOUNT_TIMEOUT_MS = 20_000;

export class NetworkInstallationStore {
  private readonly fetch: AccountFetch;
  constructor(
    private readonly db: Database.Database,
    private readonly home: string,
    private readonly opts: { fetch?: AccountFetch; selfHostId: () => string | null; now?: () => Date; newId?: () => string; timeoutMs?: number },
  ) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  list(): NetworkInstallation[] {
    return (this.db.prepare("SELECT * FROM network_installations ORDER BY created_at, id").all() as Row[]).map(project);
  }

  /** Trade the account page's one-time code for this installation's key. The code is checked by the account only, so a
   *  refused enroll here (a URL, a second enroll at the same site) never spends it. */
  async enroll(input: { code: unknown; site: unknown; allowHttp?: unknown }): Promise<NetworkInstallation> {
    const code = typeof input.code === "string" ? input.code.trim() : "";
    if (!code || /\s/.test(code)) throw new NetworkBindingError("invalid_code", "Give the one-time code the account page shows.");
    const site = validSite(input.site, input.allowHttp === true);
    const taken = this.db.prepare("SELECT id FROM network_installations WHERE site = ?").get(site) as { id: string } | undefined;
    if (taken) throw new NetworkBindingError("already_enrolled", `This daemon is already enrolled at ${site} (${taken.id}).`, 409);
    const instance = this.opts.selfHostId();
    if (!instance) throw new NetworkBindingError("instance_unknown", "This daemon hasn't resolved its host id yet. Try again once it's fully up.", 503);

    const answer = await this.call(site, "POST", "/api/connector/enroll", null, { code, instance });
    if (answer.status !== 200) {
      const error = errorCode(answer.body);
      if (answer.status === 400 || answer.status === 409) {
        throw new NetworkBindingError(error ?? "enroll_refused", `The account refused the code (${error ?? answer.status}). Get a new one from the account page; each is single-use and short-lived.`, answer.status);
      }
      throw new NetworkBindingError("account_unavailable", `The account couldn't answer (${answer.status}). If the code is still current, try again with it; otherwise get a new one.`, 503);
    }
    const body = (answer.body ?? {}) as { installation?: { id?: unknown; name?: unknown }; key?: unknown };
    if (typeof body.installation?.id !== "string" || typeof body.key !== "string" || !body.key || /\s/.test(body.key)) {
      throw new NetworkBindingError("account_unexpected", "The account's answer to the enroll had no installation or key.", 502);
    }
    const id = this.opts.newId?.() ?? `neti-${randomBytes(10).toString("hex")}`;
    const cleanup = writePrivateToken(networkInstallationKeyFile(this.home, id), body.key);
    try {
      this.db.prepare("INSERT INTO network_installations (id, site, installation_id, name, allow_http, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, site, body.installation.id, typeof body.installation.name === "string" ? body.installation.name : null, input.allowHttp === true ? 1 : 0,
          (this.opts.now?.() ?? new Date()).toISOString());
    } catch (error) {
      cleanup();
      throw error;
    }
    return project(this.db.prepare("SELECT * FROM network_installations WHERE id = ?").get(id) as Row);
  }

  /** The one installation a name-only connect goes through. */
  only(): NetworkInstallation {
    const all = this.list();
    if (all.length === 0) throw new NetworkBindingError("not_enrolled", "This daemon isn't enrolled in an account. Run rig network enroll <code> --site <site> first, or connect with --hub and --token-file.", 404);
    if (all.length > 1) throw new NetworkBindingError("installation_ambiguous", "This daemon is enrolled at more than one site; connect with --hub and --token-file.", 409);
    return all[0]!;
  }

  /** Connect a seat as a participant name: list it with the account, then bind to the account's MCP front with the new
   *  bearer. The seat is checked first, so a refusal here sends nothing. A name the account keeps without a bearer had
   *  its answer lost earlier: it's dropped and listed again for a fresh one. */
  async connect(bindings: NetworkBindingStore, input: { session: unknown; name: unknown }): Promise<NetworkBinding> {
    const installation = this.only();
    bindings.freeSeat(input.session);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!NAME.test(name)) throw new NetworkBindingError("invalid_name", `'${name}' isn't a participant name: lowercase letters, digits and inner dashes, up to 32.`);
    const others = this.listedNames(bindings, installation);
    if (others.includes(name)) throw new NetworkBindingError("participant_already_connected", `${name} is already connected here.`, 409);

    let answer = await this.setParticipants(installation, [...others, name]);
    let bearer = answer.participants.find((p) => p.name === name)?.bearer;
    if (!bearer) {
      await this.setParticipants(installation, others);
      answer = await this.setParticipants(installation, [...others, name]);
      bearer = answer.participants.find((p) => p.name === name)?.bearer;
      if (!bearer) throw new NetworkBindingError("account_unexpected", `The account listed ${name} without a bearer, twice.`, 502);
    }
    try {
      return bindings.create({ session: input.session, hubUrl: answer.mcp, hubSeat: `${name}@${answer.rig}`, token: bearer,
        allowHttp: installation.allowHttp, installation: { id: installation.id, name } });
    } catch (error) {
      // Nothing here holds that bearer, so the account stops listing the name.
      await this.setParticipants(installation, others).catch(() => {});
      throw error;
    }
  }

  /** After a binding made through the account ended here, the account stops listing its name, which revokes it there. */
  async removeAtAccount(bindings: NetworkBindingStore, binding: NetworkBinding): Promise<NetworkBinding> {
    if (!binding.installationId || binding.accountRemovedAt || binding.state === "active") return binding;
    const installation = this.list().find((i) => i.id === binding.installationId);
    if (!installation) return binding;
    try {
      await this.setParticipants(installation, this.listedNames(bindings, installation));
    } catch (error) {
      throw new NetworkBindingError("account_update_failed",
        `${binding.id} is ${binding.state} here, but the account still lists ${binding.participantName} (${(error as Error).message}). Run \`rig network disconnect ${binding.id}\` again to retry.`, 502);
    }
    bindings.markAccountRemoved(binding.id);
    return bindings.get(binding.id)!;
  }

  private listedNames(bindings: NetworkBindingStore, installation: NetworkInstallation): string[] {
    return bindings.active().filter((b) => b.installationId === installation.id && b.participantName).map((b) => b.participantName!);
  }

  private async setParticipants(installation: NetworkInstallation, participants: string[]): Promise<Identities> {
    const key = readPrivateToken(networkInstallationKeyFile(this.home, installation.id),
      (file) => `The installation key for ${installation.id} isn't at ${file}. Enroll again with a new code.`);
    const put = () => this.call(installation.site, "PUT", "/api/connector/identities", key, { instance: this.opts.selfHostId(), participants });
    let answer = await put();
    // The account couldn't apply a drop while something else changed this installation: the list is retried once.
    if (answer.status === 409 && errorCode(answer.body) === "drop_failed") answer = await put();
    if (answer.status !== 200) {
      const error = errorCode(answer.body);
      if (answer.status === 409 && error === "drop_failed") {
        throw new NetworkBindingError("account_busy", "The account was changing this installation's participants at the same time. Try again.", 503);
      }
      if (answer.status === 409) throw new NetworkBindingError(error ?? "name_taken", "Another connection to the account already uses that name. Choose another.", 409);
      if (answer.status === 401) throw new NetworkBindingError(error ?? "not_enrolled", "The account doesn't recognize this installation any more. Enroll again with a new code.", 401);
      if (answer.status === 400) throw new NetworkBindingError(error ?? "bad_names", "The account refused the participant names.", 400);
      throw new NetworkBindingError("account_unavailable", `The account couldn't answer (${answer.status}). Try again.`, 503);
    }
    const body = (answer.body ?? {}) as Partial<Identities>;
    if (!Array.isArray(body.participants) || typeof body.mcp !== "string" || typeof body.rig !== "string") {
      throw new NetworkBindingError("account_unexpected", "The account's answer had no participants, MCP front or rig.", 502);
    }
    return body as Identities;
  }

  private async call(site: string, method: string, path: string, key: string | null, payload: unknown): Promise<{ status: number; body: unknown }> {
    let res;
    try {
      // The key goes only to the site the person enrolled at: a redirect isn't followed with it, and a stalled call ends.
      res = await this.fetch(new URL(path, site).toString(), {
        method,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? ACCOUNT_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as { cause?: { message?: unknown } }).cause?.message;
      if (typeof cause === "string" && /redirect/i.test(cause)) {
        throw new NetworkBindingError("account_redirected", `The account at ${site} answered with a redirect, which isn't followed with the installation key. Use the site's own URL.`, 502);
      }
      throw new NetworkBindingError("account_unavailable", `The account at ${site} couldn't be reached: ${(error as Error).message.slice(0, 200)}`, 503);
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* no JSON body */ }
    return { status: res.status, body };
  }
}

function errorCode(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && /^[a-z][a-z0-9_]*$/.test(error) ? error : null;
}

/** The account's site: https, or plain http on the person's choice, with no credential in it. */
function validSite(raw: unknown, allowHttp: boolean): string {
  if (typeof raw !== "string" || !raw.trim()) throw new NetworkBindingError("invalid_site", "Give the account's site URL with --site.");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new NetworkBindingError("invalid_site", `'${raw}' isn't a URL.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new NetworkBindingError("invalid_site", "The site must use https (or http).");
  if (url.username || url.password) throw new NetworkBindingError("invalid_site", "The site URL can't hold a credential.");
  if (url.protocol === "http:" && !allowHttp) {
    throw new NetworkBindingError("http_not_allowed", `${url.origin} is plain http, so the installation key and every participant's token would cross the network unencrypted, where they can be read. Use the site's https URL, or enroll again with --allow-http to accept that.`);
  }
  return url.origin + "/";
}
