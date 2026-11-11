// A selected local seat joined to one participant of a remote hub: the account's network rig, which this daemon reaches
// as an MCP client with that participant's own credential (an external grant). The binding names the local seat by its
// durable node id, so a renamed or relaunched seat keeps it; the hub address represents the seat and never renames it.
// The credential is a private file under the OpenRig home; this table only says where the binding stands.
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionNodeId } from "../queue-owner.js";

export type NetworkBindingState = "active" | "revoked" | "disconnected";

export interface NetworkBinding {
  id: string;
  nodeId: string;
  /** The seat's address when it was bound, for display; the node id is what the binding follows. */
  localSession: string;
  hubUrl: string;
  /** The participant's address in the hub (`member@rig`). */
  hubSeat: string;
  /** The person chose, for this binding, to send the participant's token to a plain-http hub. */
  allowHttp: boolean;
  /** The hub URL is plain http, so the token and the work cross the network unencrypted. */
  unencrypted: boolean;
  state: NetworkBindingState;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastContactAt: string | null;
  lastError: string | null;
  /** Set when the binding was made through an enrolled account: its installation (`neti-…`) and participant name. */
  installationId: string | null;
  participantName: string | null;
  /** The account's own id for the installation the name was listed under. A replaced enrollment keeps the local id and
   *  moves to a new account installation, so only a list from this one can confirm the name was dropped. */
  accountInstallationId: string | null;
  /** When the account stopped listing this participant, after the binding ended here. */
  accountRemovedAt: string | null;
}

export class NetworkBindingError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 404 | 409 | 500 | 502 | 503 = 400) {
    super(message);
  }
}

interface Row {
  id: string; node_id: string; local_session: string; hub_url: string; hub_seat: string; allow_http: number; state: NetworkBindingState;
  state_reason: string | null; created_at: string; updated_at: string; last_contact_at: string | null; last_error: string | null;
  installation_id: string | null; participant_name: string | null; account_removed_at: string | null; account_installation_id: string | null;
}

const project = (row: Row): NetworkBinding => ({
  id: row.id, nodeId: row.node_id, localSession: row.local_session, hubUrl: row.hub_url, hubSeat: row.hub_seat,
  allowHttp: row.allow_http === 1, unencrypted: row.hub_url.startsWith("http:"), state: row.state, stateReason: row.state_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  lastContactAt: row.last_contact_at, lastError: row.last_error,
  installationId: row.installation_id, participantName: row.participant_name, accountRemovedAt: row.account_removed_at,
  accountInstallationId: row.account_installation_id,
});

const MAX_CREDENTIAL_BYTES = 16384;

/** Where a binding's credential lives: `<home>/network-secrets/<binding id>/credential.json`, private to this user. */
export function networkCredentialFile(home: string, bindingId: string): string {
  if (!/^netb-[0-9a-f]{20}$/.test(bindingId)) throw new NetworkBindingError("invalid_binding_id", `'${bindingId}' isn't a network binding id.`);
  return join(home, "network-secrets", bindingId, "credential.json");
}

/** The participant's bearer, read from its private file. A file anyone else can read, a link or an oversized file is
 *  refused, with the path named and the value never shown. */
export function readNetworkCredential(home: string, bindingId: string): string {
  return readPrivateToken(networkCredentialFile(home, bindingId),
    (file) => `The credential for ${bindingId} isn't at ${file}. Connect the seat again with its token file.`);
}

/** A token from one of the network's private files (`{"version":1,"token":…}`), checked the same way for every kind. */
export function readPrivateToken(file: string, missing: (file: string) => string): string {
  let stat;
  try { stat = lstatSync(file); } catch {
    throw new NetworkBindingError("credential_missing", missing(file), 404);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES || (stat.mode & 0o077) !== 0) {
    throw new NetworkBindingError("credential_unsafe", `${file} must be a regular file readable only by this user.`);
  }
  // A parse error can quote the file's text, which holds the token: say only which file.
  let value: { version?: unknown; token?: unknown };
  try { value = JSON.parse(readFileSync(file, "utf8")) as typeof value; } catch {
    throw new NetworkBindingError("credential_invalid", `${file} isn't a network credential.`);
  }
  if (value === null || typeof value !== "object" || value.version !== 1 || typeof value.token !== "string" || !value.token) {
    throw new NetworkBindingError("credential_invalid", `${file} isn't a network credential.`);
  }
  return value.token;
}

/** Write a token to its own private file: a 0700 folder and a 0600 file, opened exclusively. On failure, only what
 *  this call made is removed: the file it opened, and the folder if it made it (`mkdirSync` returns the first folder it
 *  made, so any value means this one is new). Returns the cleanup for a later step that fails. */
export function writePrivateToken(file: string, token: string): () => void {
  let created = false;
  let madeFolder: string | undefined;
  const cleanup = () => {
    if (created) rmSync(file, { force: true });
    if (madeFolder !== undefined) rmSync(dirname(file), { recursive: true, force: true });
  };
  try {
    madeFolder = mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, `${JSON.stringify({ version: 1, token })}\n`); } finally { closeSync(fd); }
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}

export function validHubUrl(raw: unknown, allowHttp: boolean): string {
  if (typeof raw !== "string" || !raw.trim()) throw new NetworkBindingError("invalid_hub_url", "A hub URL is required.");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new NetworkBindingError("invalid_hub_url", `'${raw}' isn't a URL.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new NetworkBindingError("invalid_hub_url", "The hub URL must use https (or http).");
  // A credential in the URL would be stored in plain text in this table and shown in status.
  if (url.username || url.password) throw new NetworkBindingError("invalid_hub_url", "Put the participant's token in its token file, not in the hub URL.");
  // Plain http is the person's choice per binding. The scheme is kept as given, and the address isn't judged: a private
  // or tailnet address doesn't prove the connection is protected.
  if (url.protocol === "http:" && !allowHttp) {
    throw new NetworkBindingError("http_not_allowed", `${url.toString()} is plain http, so the participant's token and its work would cross the network unencrypted, where they can be read. Use the hub's https URL, or connect again with --allow-http to accept that for this binding.`);
  }
  return url.toString();
}

function validHubSeat(raw: unknown): string {
  if (typeof raw !== "string" || !/^[^@\s]+@[^@\s]+$/.test(raw.trim())) {
    throw new NetworkBindingError("invalid_hub_seat", "The hub participant is its address in the hub, member@rig.");
  }
  return raw.trim();
}

function validToken(raw: unknown): string {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token || /\s/.test(token) || Buffer.byteLength(token) > 8192) {
    throw new NetworkBindingError("invalid_token", "The participant's token must be one non-empty line with no spaces.");
  }
  return token;
}

export class NetworkBindingStore {
  constructor(
    private readonly db: Database.Database,
    private readonly home: string,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => `netb-${randomBytes(10).toString("hex")}`,
  ) {}

  list(): NetworkBinding[] {
    return (this.db.prepare("SELECT * FROM network_bindings ORDER BY created_at, id").all() as Row[]).map(project);
  }

  active(): NetworkBinding[] {
    return (this.db.prepare("SELECT * FROM network_bindings WHERE state = 'active' ORDER BY created_at, id").all() as Row[]).map(project);
  }

  get(id: string): NetworkBinding | null {
    const row = this.db.prepare("SELECT * FROM network_bindings WHERE id = ?").get(id) as Row | undefined;
    return row ? project(row) : null;
  }

  /** A binding by its id, or the active binding of a local seat named by its address. */
  find(ref: string): NetworkBinding | null {
    const byId = this.get(ref);
    if (byId) return byId;
    const nodeId = resolveSessionNodeId(this.db, ref);
    const row = nodeId ? this.db.prepare("SELECT * FROM network_bindings WHERE node_id = ? AND state = 'active'").get(nodeId) as Row | undefined : undefined;
    return row ? project(row) : null;
  }

  /** Bind a local seat to a hub participant with that participant's token. The credential is written first, exclusively
   *  and private, then the row. If either step fails, the credential this call created is removed, so a refused bind
   *  leaves none behind; a file that was already at that path is never touched. */
  /** The seat to bind, by its node: it must exist and have no active binding. Checked before anything is sent anywhere. */
  freeSeat(rawSession: unknown): { session: string; nodeId: string } {
    const session = typeof rawSession === "string" ? rawSession.trim() : "";
    if (!session) throw new NetworkBindingError("invalid_seat", "Name the local seat to connect.");
    const nodeId = resolveSessionNodeId(this.db, session);
    if (!nodeId) throw new NetworkBindingError("seat_not_found", `No local seat is named '${session}'.`, 404);
    const bound = this.db.prepare("SELECT id FROM network_bindings WHERE node_id = ? AND state = 'active'").get(nodeId) as { id: string } | undefined;
    if (bound) throw new NetworkBindingError("seat_already_connected", `${session} is already connected (${bound.id}). Disconnect it first.`, 409);
    return { session, nodeId };
  }

  create(input: { session: unknown; hubUrl: unknown; hubSeat: unknown; token: unknown; allowHttp?: unknown;
    installation?: { id: string; name: string; account: string } }): NetworkBinding {
    const { session, nodeId } = this.freeSeat(input.session);
    const allowHttp = input.allowHttp === true;
    const hubUrl = validHubUrl(input.hubUrl, allowHttp);
    const hubSeat = validHubSeat(input.hubSeat);
    const token = validToken(input.token);
    const taken = this.db.prepare("SELECT id FROM network_bindings WHERE hub_url = ? AND hub_seat = ? AND state = 'active'").get(hubUrl, hubSeat) as { id: string } | undefined;
    if (taken) throw new NetworkBindingError("participant_already_connected", `${hubSeat} at ${hubUrl} is already connected (${taken.id}).`, 409);

    const id = this.newId();
    // The credential first, then the row; a failed row takes the credential with it. A file that was already at the path
    // is never touched, and a folder that was already there keeps its other files.
    const cleanup = writePrivateToken(networkCredentialFile(this.home, id), token);
    try {
      const at = this.now().toISOString();
      this.db.prepare(`INSERT INTO network_bindings (id, node_id, local_session, hub_url, hub_seat, allow_http, state, created_at, updated_at,
        installation_id, participant_name, account_installation_id) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
        .run(id, nodeId, session, hubUrl, hubSeat, allowHttp ? 1 : 0, at, at, input.installation?.id ?? null, input.installation?.name ?? null,
          input.installation?.account ?? null);
    } catch (error) {
      cleanup();
      throw error;
    }
    return this.get(id)!;
  }

  /** The person ends this binding here. No new work comes in through it; local rows, results and other bindings stay. The
   *  credential is removed, and the hub still lists the participant until it's removed there too. */
  disconnect(ref: string, reason?: string): NetworkBinding {
    return this.end(ref, "disconnected", reason?.trim() || "disconnected here");
  }

  /** The hub refused the credential: it was revoked there. Same effect as a local disconnect. */
  markRevoked(id: string, reason: string): NetworkBinding {
    return this.end(id, "revoked", reason);
  }

  /** Ends these active bindings' state only, so a caller can do it in one transaction with its own change. Their
   *  credentials stay until the caller ends each one again with `disconnect`, which removes them. */
  markDisconnected(ids: string[], reason: string): void {
    const end = this.db.prepare("UPDATE network_bindings SET state = 'disconnected', state_reason = ?, updated_at = ? WHERE id = ? AND state = 'active'");
    for (const id of ids) end.run(reason, this.now().toISOString(), id);
  }

  /** The account stopped listing this ended binding's participant. */
  markAccountRemoved(id: string): void {
    this.db.prepare("UPDATE network_bindings SET account_removed_at = ?, updated_at = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), id);
  }

  /** The connector reached the hub as this binding. */
  recordContact(id: string, at: Date = this.now()): void {
    this.db.prepare("UPDATE network_bindings SET last_contact_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(at.toISOString(), at.toISOString(), id);
  }

  /** The connector couldn't reach the hub as this binding, or the hub answered with an error; the binding stays active.
   *  Control characters are replaced, since the text can come from the hub and `rig network status` prints it. */
  recordError(id: string, message: string): void {
    this.db.prepare("UPDATE network_bindings SET last_error = ?, updated_at = ? WHERE id = ?")
      .run(message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500), this.now().toISOString(), id);
  }

  /** The binding ends first, so no new work comes in even if the credential can't be removed; removal is tried on every
   *  call, including again on an already ended binding, until its credential is gone. */
  private end(ref: string, state: "disconnected" | "revoked", reason: string): NetworkBinding {
    const binding = this.find(ref);
    if (!binding) throw new NetworkBindingError("binding_not_found", `No network binding or connected seat is named '${ref}'.`, 404);
    if (binding.state === "active") {
      this.db.prepare("UPDATE network_bindings SET state = ?, state_reason = ?, updated_at = ? WHERE id = ? AND state = 'active'")
        .run(state, reason, this.now().toISOString(), binding.id);
    }
    try {
      this.removeCredential(binding.id);
    } catch (error) {
      throw new NetworkBindingError("credential_cleanup_failed",
        `${binding.id} is ${this.get(binding.id)!.state}, but its credential at ${networkCredentialFile(this.home, binding.id)} couldn't be removed (${(error as Error).message}). Run \`rig network disconnect ${binding.id}\` again to retry.`, 500);
    }
    return this.get(binding.id)!;
  }

  /** Removes the credential folders whose binding isn't active: one a stop left between the credential write and its
   *  row, or one whose removal failed when its binding ended. Other names under the folder are left alone. */
  sweepCredentials(): { removed: string[]; failed: string[] } {
    const swept = { removed: [] as string[], failed: [] as string[] };
    let names: string[];
    try { names = readdirSync(join(this.home, "network-secrets")); } catch { return swept; }
    for (const name of names.sort()) {
      if (!/^netb-[0-9a-f]{20}$/.test(name) || this.get(name)?.state === "active") continue;
      try { this.removeCredential(name); swept.removed.push(name); } catch { swept.failed.push(name); }
    }
    return swept;
  }

  private removeCredential(id: string): void {
    const file = networkCredentialFile(this.home, id);
    if (existsSync(dirname(file))) rmSync(dirname(file), { recursive: true, force: true });
  }
}
