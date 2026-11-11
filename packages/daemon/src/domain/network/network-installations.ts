// This daemon enrolled in an account, so the person connects a seat by a name instead of a hub URL and a token file.
// Enrolling trades a one-time code from the account page for this installation's key. Connecting a seat lists the
// installation's participants with the account, which answers a bearer for a newly listed name, and the account's MCP
// front and rig, where the binding then reaches. A name the installation stops listing is revoked there.
//
// The account replaces the whole list on every change, so changes to one installation's list run one at a time, each
// reading the names to keep inside its turn. One enroll, connect or disconnect spends at most one deadline with the
// account, waiting for its turn included.
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
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

/** An enroll's answer. A replaced enrollment names the bindings it ended, whose names the old installation may still list. */
export interface EnrollResult extends NetworkInstallation {
  replaced?: { endedBindings: Array<{ id: string; localSession: string; participantName: string | null }> };
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

/** The state reason of a binding a replaced enrollment ended: its name belongs to the old installation. */
export const REPLACED_REASON = "replaced by a new enrollment";

/** What's known about the account's side of an ended binding made through it: confirmed dropped, unconfirmed (a removal
 *  that failed or whose answer was lost), or left with the old installation when the enrollment was replaced. */
export function accountRemoval(binding: NetworkBinding): "confirmed" | "unconfirmed" | "old-installation" | null {
  if (!binding.installationId || binding.state === "active") return null;
  if (binding.stateReason === REPLACED_REASON) return "old-installation";
  if (binding.accountRemovedAt) return "confirmed";
  // The hub refused its credential, so nothing live is left there.
  if (binding.state === "revoked") return null;
  return "unconfirmed";
}

/** What the account answers for the installation's participant list. */
interface Identities { participants: Array<{ name: string; state?: string; bearer?: string }>; mcp: string; rig: string }

export type AccountFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal })
  => Promise<{ status: number; json(): Promise<unknown> }>;

/** How long one enroll, connect or disconnect may spend with the account in all, waiting for its turn included. */
export const ACCOUNT_DEADLINE_MS = 30_000;

/** One change at a time to an installation's participant list, across the stores each request makes. */
const listTurns = new Map<string, Promise<void>>();
async function inListTurn<T>(installationId: string, run: () => Promise<T>): Promise<T> {
  const before = listTurns.get(installationId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const chain = before.then(() => mine);
  listTurns.set(installationId, chain);
  try {
    await before;
    return await run();
  } finally {
    release();
    if (listTurns.get(installationId) === chain) listTurns.delete(installationId);
  }
}

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
   *  refused enroll here (a URL, a second enroll at the same site without `replace`) never spends it. With `replace`, the
   *  new key takes the old one's place only after the account accepted the new code, so a failed replace leaves the old
   *  enrollment working. */
  async enroll(bindings: NetworkBindingStore, input: { code: unknown; site: unknown; allowHttp?: unknown; replace?: unknown }): Promise<EnrollResult> {
    const code = typeof input.code === "string" ? input.code.trim() : "";
    if (!code || /\s/.test(code)) throw new NetworkBindingError("invalid_code", "Give the one-time code the account page shows.");
    const site = validSite(input.site, input.allowHttp === true);
    const existing = this.db.prepare("SELECT * FROM network_installations WHERE site = ?").get(site) as Row | undefined;
    if (existing && input.replace !== true) {
      throw new NetworkBindingError("already_enrolled", `This daemon is already enrolled at ${site} (${existing.id}). To enroll again with a new code, add --replace.`, 409);
    }
    const instance = this.instance();
    const until = this.deadline();

    let answer;
    try {
      answer = await this.call(site, "POST", "/api/connector/enroll", null, { code, instance }, until);
    } catch (error) {
      if (error instanceof NetworkBindingError && error.code === "account_unavailable") {
        throw new NetworkBindingError("account_unavailable", `${error.message} Whether the account took the code is unknown: try again with the same code, and if it's refused, get a new one.`, 503);
      }
      throw error;
    }
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
    const installation = { id: body.installation.id, name: typeof body.installation.name === "string" ? body.installation.name : null };
    const allowHttp = input.allowHttp === true ? 1 : 0;
    if (existing) return inListTurn(existing.id, async () => this.replace(bindings, project(existing), installation, body.key as string, allowHttp));

    const id = this.opts.newId?.() ?? `neti-${randomBytes(10).toString("hex")}`;
    const cleanup = writePrivateToken(networkInstallationKeyFile(this.home, id), body.key);
    try {
      this.db.prepare("INSERT INTO network_installations (id, site, installation_id, name, allow_http, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, site, installation.id, installation.name, allowHttp, (this.opts.now?.() ?? new Date()).toISOString());
    } catch (error) {
      cleanup();
      throw error;
    }
    return this.get(id);
  }

  /** The new key goes in beside the old one, then takes its place, then the row follows; a failure on the way puts the
   *  old key back. The bindings made through the old installation end here, and their names are returned: the old
   *  installation may still list them, and this key can't drop them. */
  private replace(bindings: NetworkBindingStore, old: NetworkInstallation, next: { id: string; name: string | null }, key: string, allowHttp: number): EnrollResult {
    const file = networkInstallationKeyFile(this.home, old.id);
    const staged = `${file}.next`;
    const kept = `${file}.prev`;
    rmSync(staged, { force: true });
    const cleanup = writePrivateToken(staged, key);
    const hadKey = existsSync(file);
    try {
      if (hadKey) renameSync(file, kept);
      renameSync(staged, file);
      this.db.prepare("UPDATE network_installations SET installation_id = ?, name = ?, allow_http = ? WHERE id = ?").run(next.id, next.name, allowHttp, old.id);
    } catch (error) {
      if (existsSync(kept)) renameSync(kept, file);
      cleanup();
      throw error;
    }
    rmSync(kept, { force: true });
    const ended = bindings.active().filter((b) => b.installationId === old.id);
    for (const binding of ended) {
      try { bindings.disconnect(binding.id, REPLACED_REASON); } catch { /* ended either way; its credential cleanup says how to retry */ }
    }
    return { ...this.get(old.id), replaced: { endedBindings: ended.map((b) => ({ id: b.id, localSession: b.localSession, participantName: b.participantName })) } };
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
    const until = this.deadline();
    return inListTurn(installation.id, async () => {
      // In this installation's turn: checked again, and every list sent reads the names to keep afresh.
      bindings.freeSeat(input.session);
      if (this.listedNames(bindings, installation).includes(name)) throw new NetworkBindingError("participant_already_connected", `${name} is already connected here.`, 409);
      const others = () => this.listedNames(bindings, installation).filter((n) => n !== name);
      let answer = await this.setParticipants(bindings, installation, () => [...others(), name], until);
      let bearer = answer.participants.find((p) => p.name === name)?.bearer;
      if (!bearer) {
        await this.setParticipants(bindings, installation, others, until);
        answer = await this.setParticipants(bindings, installation, () => [...others(), name], until);
        bearer = answer.participants.find((p) => p.name === name)?.bearer;
        if (!bearer) throw new NetworkBindingError("account_unexpected", `The account listed ${name} without a bearer, twice.`, 502);
      }
      try {
        return bindings.create({ session: input.session, hubUrl: answer.mcp, hubSeat: `${name}@${answer.rig}`, token: bearer,
          allowHttp: installation.allowHttp, installation: { id: installation.id, name } });
      } catch (error) {
        // Best effort: nothing here holds that bearer, so the account is asked to stop listing the name. If that fails,
        // the error says so; the account may still list it.
        let unconfirmed = "";
        try {
          await this.setParticipants(bindings, installation, others, until);
        } catch (drop) {
          unconfirmed = ` OpenRig couldn't confirm the account dropped ${name} again (${(drop as Error).message}); it may still list it.`;
        }
        if (unconfirmed && error instanceof NetworkBindingError) throw new NetworkBindingError(error.code, `${error.message}${unconfirmed}`, error.status);
        throw error;
      }
    });
  }

  /** After a binding made through the account ended here, the account stops listing its name, which revokes it there.
   *  Only an answered list that no longer has the name marks it removed; a failed or lost one leaves it unconfirmed. */
  async removeAtAccount(bindings: NetworkBindingStore, binding: NetworkBinding): Promise<NetworkBinding> {
    if (accountRemoval(binding) !== "unconfirmed") return binding;
    const installation = this.list().find((i) => i.id === binding.installationId);
    if (!installation) return binding;
    const until = this.deadline();
    return inListTurn(installation.id, async () => {
      try {
        await this.setParticipants(bindings, installation, () => this.listedNames(bindings, installation), until);
      } catch (error) {
        throw new NetworkBindingError("account_update_unconfirmed",
          `${binding.id} is ${binding.state} here, but OpenRig couldn't confirm that the account dropped ${binding.participantName} (${(error as Error).message}). Run \`rig network disconnect ${binding.id}\` again.`, 502);
      }
      return bindings.get(binding.id)!;
    });
  }

  private get(id: string): NetworkInstallation {
    return project(this.db.prepare("SELECT * FROM network_installations WHERE id = ?").get(id) as Row);
  }

  private listedNames(bindings: NetworkBindingStore, installation: NetworkInstallation): string[] {
    return bindings.active().filter((b) => b.installationId === installation.id && b.participantName).map((b) => b.participantName!);
  }

  private instance(): string {
    const instance = this.opts.selfHostId();
    if (!instance) throw new NetworkBindingError("instance_unknown", "This daemon hasn't resolved its host id yet. Try again once it's fully up.", 503);
    return instance;
  }

  private deadline(): number {
    return Date.now() + (this.opts.timeoutMs ?? ACCOUNT_DEADLINE_MS);
  }

  private async setParticipants(bindings: NetworkBindingStore, installation: NetworkInstallation, names: () => string[], until: number): Promise<Identities> {
    const instance = this.instance();
    const repair = `Get a new code from the account page and run rig network enroll <code> --site ${installation.site} --replace.`;
    const key = readPrivateToken(networkInstallationKeyFile(this.home, installation.id),
      (file) => `The installation key for ${installation.id} isn't at ${file}. ${repair}`);
    const put = () => this.call(installation.site, "PUT", "/api/connector/identities", key, { instance, participants: names() }, until);
    let answer = await put();
    // The account couldn't apply a drop while something else changed this installation: the list is read and sent once more.
    if (answer.status === 409 && errorCode(answer.body) === "drop_failed") answer = await put();
    if (answer.status !== 200) {
      const error = errorCode(answer.body);
      if (answer.status === 409 && error === "drop_failed") {
        throw new NetworkBindingError("account_busy", "The account was changing this installation's participants at the same time. Try again.", 503);
      }
      if (answer.status === 409) throw new NetworkBindingError(error ?? "name_taken", "Another connection to the account already uses that name. Choose another.", 409);
      if (answer.status === 401) throw new NetworkBindingError(error ?? "not_enrolled", `The account doesn't recognize this installation any more. ${repair}`, 401);
      if (answer.status === 400) throw new NetworkBindingError(error ?? "bad_names", "The account refused the participant names.", 400);
      throw new NetworkBindingError("account_unavailable", `The account couldn't answer (${answer.status}). Try again.`, 503);
    }
    const body = (answer.body ?? {}) as Partial<Identities>;
    if (!Array.isArray(body.participants) || typeof body.mcp !== "string" || typeof body.rig !== "string") {
      throw new NetworkBindingError("account_unexpected", "The account's answer had no participants, MCP front or rig.", 502);
    }
    // The answer is what the account now lists: an ended binding's name that isn't in it is confirmed dropped.
    const listed = new Set(body.participants.map((p) => p.name));
    for (const ended of bindings.list()) {
      if (ended.installationId === installation.id && ended.participantName && !listed.has(ended.participantName) && accountRemoval(ended) === "unconfirmed") {
        bindings.markAccountRemoved(ended.id);
      }
    }
    return body as Identities;
  }

  private async call(site: string, method: string, path: string, key: string | null, payload: unknown, until: number): Promise<{ status: number; body: unknown }> {
    const left = until - Date.now();
    if (left <= 0) throw new NetworkBindingError("account_unavailable", `The account at ${site} wasn't reached in time: this command's time with the account ran out.`, 503);
    let res;
    try {
      // The key goes only to the site the person enrolled at: a redirect isn't followed with it, and a stalled call ends.
      res = await this.fetch(new URL(path, site).toString(), {
        method,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(left),
      });
    } catch (error) {
      const cause = (error as { cause?: { message?: unknown } }).cause?.message;
      if (typeof cause === "string" && /redirect/i.test(cause)) {
        throw new NetworkBindingError("account_redirected", `The account at ${site} answered with a redirect, which isn't followed with the installation key. Use the site's own URL.`, 502);
      }
      throw new NetworkBindingError("account_unavailable", `The account at ${site} couldn't be reached: ${(error as Error).message.slice(0, 200)}.`, 503);
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
