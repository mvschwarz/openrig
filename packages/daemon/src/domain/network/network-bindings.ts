// A selected local seat joined to one participant of a remote hub: the account's network rig, which this daemon reaches
// as an MCP client with that participant's own credential (an external grant). The binding names the local seat by its
// durable node id, so a renamed or relaunched seat keeps it; the hub address represents the seat and never renames it.
// The credential is a private file under the OpenRig home; this table only says where the binding stands.
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionNodeId } from "../queue-owner.js";

export type NetworkBindingState = "active" | "revoked" | "disconnected";

export interface NetworkBindingProvider {
  id: string;
  installation: string;
  participant: string;
  remoteInstallation?: string;
}
export type ProviderRemovalStatus = "pending" | "confirmed" | "unconfirmed" | "superseded";
export interface NetworkProviderRemoval {
  bindingId: string;
  credentialRevision: number;
  removalRevision: string;
  provider: NetworkBindingProvider;
  hubUrl: string;
  hubSeat: string;
  hasCapability: boolean;
  status: ProviderRemovalStatus;
  reason: string | null;
  attempts: number;
  nextAttemptAt: string;
}

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
  provider: NetworkBindingProvider | null;
  credentialRevision: number;
  credentialCleanup: "pending" | "complete";
  providerRemoval: ProviderRemovalStatus | null;
  providerRemovalRevision: string | null;
  providerRemovalReason: string | null;
  providerRemovalReceipt: Record<string, unknown> | null;
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
  provider_json: string | null; credential_revision: number; removal_revision: string | null; credential_cleanup_pending: number;
}

const project = (row: Row): NetworkBinding => ({
  id: row.id, nodeId: row.node_id, localSession: row.local_session, hubUrl: row.hub_url, hubSeat: row.hub_seat,
  allowHttp: row.allow_http === 1, unencrypted: row.hub_url.startsWith("http:"), state: row.state, stateReason: row.state_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  lastContactAt: row.last_contact_at, lastError: row.last_error,
  installationId: row.installation_id, participantName: row.participant_name, accountRemovedAt: row.account_removed_at,
  accountInstallationId: row.account_installation_id,
  provider: row.provider_json ? JSON.parse(row.provider_json) as NetworkBindingProvider : row.installation_id && row.participant_name
    ? { id: "account", installation: row.installation_id, participant: row.participant_name, ...(row.account_installation_id ? { remoteInstallation: row.account_installation_id } : {}) } : null,
  credentialRevision: row.credential_revision,
  credentialCleanup: row.credential_cleanup_pending === 1 ? "pending" : "complete",
  providerRemoval: row.account_removed_at ? "confirmed" : row.installation_id && row.state !== "active" ? "unconfirmed" : null,
  providerRemovalRevision: row.removal_revision,
  providerRemovalReason: null,
  providerRemovalReceipt: null,
});

const MAX_CREDENTIAL_BYTES = 16384;

/** Where a binding's credential lives: `<home>/network-secrets/<binding id>/credential.json`, private to this user. */
export function networkCredentialFile(home: string, bindingId: string, revision = 0): string {
  if (!/^netb-[0-9a-f]{20}$/.test(bindingId)) throw new NetworkBindingError("invalid_binding_id", `'${bindingId}' isn't a network binding id.`);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new NetworkBindingError("invalid_revision", "The credential revision must be a nonnegative integer.");
  return join(home, "network-secrets", bindingId, revision === 0 ? "credential.json" : `credential-${revision}.json`);
}

/** The participant's bearer, read from its private file. A file anyone else can read, a link or an oversized file is
 *  refused, with the path named and the value never shown. */
export function readNetworkCredential(home: string, bindingId: string, revision = 0): string {
  return readPrivateToken(networkCredentialFile(home, bindingId, revision),
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
    try { writeFileSync(fd, `${JSON.stringify({ version: 1, token })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    // Flush the directory entry before a DB revision can select this immutable file.
    if (process.platform !== "win32") {
      const folder = openSync(dirname(file), "r");
      try { fsyncSync(folder); } finally { closeSync(folder); }
    }
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

function validProvider(value: unknown): NetworkBindingProvider | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new NetworkBindingError("invalid_provider", "The provider must name its id, installation and participant.");
  const v = value as Record<string, unknown>;
  for (const key of ["id", "installation", "participant"]) {
    if (typeof v[key] !== "string" || !(v[key] as string).trim()) throw new NetworkBindingError("invalid_provider", `The provider needs ${key}.`);
  }
  if (v.remoteInstallation !== undefined && (typeof v.remoteInstallation !== "string" || !v.remoteInstallation.trim())) throw new NetworkBindingError("invalid_provider", "The remote installation must be a nonempty reference.");
  return { id: (v.id as string).trim(), installation: (v.installation as string).trim(), participant: (v.participant as string).trim(),
    ...(v.remoteInstallation === undefined ? {} : { remoteInstallation: (v.remoteInstallation as string).trim() }) };
}
function validRemoval(value: unknown): { revision: string; token: string } | null {
  if (value === undefined || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || Array.isArray(v) || typeof v.revision !== "string" || !v.revision.trim()) throw new NetworkBindingError("invalid_removal", "Removal needs an opaque revision and its separate token.");
  return { revision: v.revision.trim(), token: validToken(v.token) };
}
function removalFile(home: string, id: string, revision: number): string {
  return join(dirname(networkCredentialFile(home, id, revision)), `removal-${revision}.json`);
}
interface RemovalRow {
  binding_id: string; credential_revision: number; removal_revision: string; provider_json: string; hub_url: string; hub_seat: string;
  has_capability: number; status: ProviderRemovalStatus; reason: string | null; receipt_json: string | null; attempts: number; next_attempt_at: string;
}
const projectRemoval = (r: RemovalRow): NetworkProviderRemoval => ({ bindingId: r.binding_id, credentialRevision: r.credential_revision,
  removalRevision: r.removal_revision, provider: JSON.parse(r.provider_json) as NetworkBindingProvider, hubUrl: r.hub_url, hubSeat: r.hub_seat,
  hasCapability: r.has_capability === 1, status: r.status, reason: r.reason, attempts: r.attempts, nextAttemptAt: r.next_attempt_at });

export class NetworkBindingStore {
  constructor(
    private readonly db: Database.Database,
    private readonly home: string,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => `netb-${randomBytes(10).toString("hex")}`,
  ) {}

  list(): NetworkBinding[] {
    return (this.db.prepare("SELECT * FROM network_bindings ORDER BY created_at, id").all() as Row[]).map((row) => this.project(row));
  }

  active(): NetworkBinding[] {
    return (this.db.prepare("SELECT * FROM network_bindings WHERE state = 'active' ORDER BY created_at, id").all() as Row[]).map((row) => this.project(row));
  }

  get(id: string): NetworkBinding | null {
    const row = this.db.prepare("SELECT * FROM network_bindings WHERE id = ?").get(id) as Row | undefined;
    return row ? this.project(row) : null;
  }

  /** A binding by its id, or the active binding of a local seat named by its address. */
  find(ref: string): NetworkBinding | null {
    const byId = this.get(ref);
    if (byId) return byId;
    const nodeId = resolveSessionNodeId(this.db, ref);
    const row = nodeId ? this.db.prepare("SELECT * FROM network_bindings WHERE node_id = ? AND state = 'active'").get(nodeId) as Row | undefined : undefined;
    return row ? this.project(row) : null;
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
    installation?: { id: string; name: string; account: string }; provider?: unknown; removal?: unknown }): NetworkBinding {
    const { session, nodeId } = this.freeSeat(input.session);
    const allowHttp = input.allowHttp === true;
    const hubUrl = validHubUrl(input.hubUrl, allowHttp);
    const hubSeat = validHubSeat(input.hubSeat);
    const token = validToken(input.token);
    const provider = validProvider(input.provider);
    const removal = validRemoval(input.removal);
    if (removal && !provider) throw new NetworkBindingError("invalid_removal", "A removal capability needs its provider metadata.");
    const taken = this.db.prepare("SELECT id FROM network_bindings WHERE hub_url = ? AND hub_seat = ? AND state = 'active'").get(hubUrl, hubSeat) as { id: string } | undefined;
    if (taken) throw new NetworkBindingError("participant_already_connected", `${hubSeat} at ${hubUrl} is already connected (${taken.id}).`, 409);

    const id = this.newId();
    // The credential first, then the row; a failed row takes the credential with it. A file that was already at the path
    // is never touched, and a folder that was already there keeps its other files.
    const cleanup = writePrivateToken(networkCredentialFile(this.home, id), token);
    let cleanupRemoval: (() => void) | undefined;
    try {
      if (removal) cleanupRemoval = writePrivateToken(removalFile(this.home, id, 0), removal.token);
      const at = this.now().toISOString();
      this.db.prepare(`INSERT INTO network_bindings (id, node_id, local_session, hub_url, hub_seat, allow_http, state, created_at, updated_at,
        installation_id, participant_name, account_installation_id, provider_json, removal_revision) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, nodeId, session, hubUrl, hubSeat, allowHttp ? 1 : 0, at, at, input.installation?.id ?? null, input.installation?.name ?? null,
          input.installation?.account ?? null, provider ? JSON.stringify(provider) : null, removal?.revision ?? null);
    } catch (error) {
      cleanupRemoval?.(); cleanup();
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
    this.db.transaction(() => {
      for (const id of ids) {
        const binding = this.get(id);
        if (!binding || binding.state !== "active") continue;
        this.recordRemovalIntent(binding);
        this.db.prepare("UPDATE network_bindings SET state = 'disconnected', state_reason = ?, credential_cleanup_pending = 1, updated_at = ? WHERE id = ? AND state = 'active'")
          .run(reason, this.now().toISOString(), id);
      }
    })();
  }

  /** The account stopped listing this ended binding's participant. */
  markAccountRemoved(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE network_bindings SET account_removed_at = ?, updated_at = ? WHERE id = ?").run(this.now().toISOString(), this.now().toISOString(), id);
      this.db.prepare("UPDATE network_binding_removals SET status = 'confirmed', reason = NULL, updated_at = ? WHERE binding_id = ? AND status = 'pending'").run(this.now().toISOString(), id);
    })();
    this.sweepSecretFiles(id);
  }

  private project(row: Row): NetworkBinding {
    const binding = project(row);
    const removal = this.db.prepare("SELECT * FROM network_binding_removals WHERE binding_id = ? AND credential_revision = ?").get(binding.id, binding.credentialRevision) as RemovalRow | undefined;
    return removal ? { ...binding, providerRemoval: removal.status, providerRemovalRevision: removal.removal_revision, providerRemovalReason: removal.reason, providerRemovalReceipt: removal.receipt_json ? JSON.parse(removal.receipt_json) as Record<string, unknown> : null } : binding;
  }

  /** Stage immutable files, then select them in one DB commit. A stop before the commit leaves the old revision usable;
   *  a stop after it leaves unused files for the existing credential sweep. Binding and receipt identities never move. */
  rotateCredential(id: string, input: { expectedRevision: unknown; provider?: unknown; token: unknown; removal?: unknown }): NetworkBinding {
    const binding = this.get(id);
    if (!binding) throw new NetworkBindingError("binding_not_found", "No network binding has that id.", 404);
    if (binding.state !== "active" || input.expectedRevision !== binding.credentialRevision) throw new NetworkBindingError("binding_revision_changed", "Read the current active binding and retry with its credential revision.", 409);
    if (JSON.stringify(validProvider(input.provider)) !== JSON.stringify(binding.provider)) throw new NetworkBindingError("provider_revision_changed", "Use the binding's original provider references.", 409);
    const token = validToken(input.token); const removal = validRemoval(input.removal);
    if (binding.provider && (!removal || removal.revision === binding.providerRemovalRevision)) throw new NetworkBindingError("invalid_removal", "Provider rotation needs a new removal revision and its separate token.");
    if (!binding.provider && removal) throw new NetworkBindingError("invalid_removal", "A direct binding has no provider removal capability.");
    this.sweepSecretFiles(id); // Recover files staged by an interrupted earlier attempt before choosing the next revision.
    const revision = binding.credentialRevision + 1;
    const cleanup = writePrivateToken(networkCredentialFile(this.home, id, revision), token);
    let cleanupRemoval: (() => void) | undefined;
    try {
      if (removal) cleanupRemoval = writePrivateToken(removalFile(this.home, id, revision), removal.token);
      this.db.transaction(() => {
        const changed = this.db.prepare("UPDATE network_bindings SET credential_revision = ?, removal_revision = ?, credential_cleanup_pending = 1, updated_at = ? WHERE id = ? AND state = 'active' AND credential_revision = ?")
          .run(revision, removal?.revision ?? null, this.now().toISOString(), id, binding.credentialRevision);
        if (changed.changes !== 1) throw new NetworkBindingError("binding_revision_changed", "The binding changed during rotation; read it again.", 409);
      })();
    } catch (error) { cleanupRemoval?.(); cleanup(); throw error; }
    // The commit succeeded. Failure to remove an obsolete file must not turn a completed rotation into a failed one.
    try { this.sweepSecretFiles(id); } catch { /* Existing startup sweep retries unused secret cleanup. */ }
    return this.get(id)!;
  }

  private recordRemovalIntent(binding: NetworkBinding): void {
    if (!binding.provider) return;
    const at = this.now().toISOString();
    this.db.prepare(`INSERT INTO network_binding_removals
      (binding_id,credential_revision,removal_revision,provider_json,hub_url,hub_seat,has_capability,status,next_attempt_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?,?)
      ON CONFLICT(binding_id,credential_revision) DO UPDATE SET
        has_capability = MAX(network_binding_removals.has_capability, excluded.has_capability)
      WHERE network_binding_removals.status = 'pending'`).run(binding.id, binding.credentialRevision,
        binding.providerRemovalRevision ?? `local-${binding.credentialRevision}`, JSON.stringify(binding.provider), binding.hubUrl, binding.hubSeat,
        binding.providerRemovalRevision ? 1 : 0, at, at);
  }

  pendingProviderRemovals(): NetworkProviderRemoval[] {
    return (this.db.prepare("SELECT * FROM network_binding_removals WHERE status = 'pending' ORDER BY next_attempt_at,binding_id").all() as RemovalRow[]).map(projectRemoval);
  }
  readRemovalToken(removal: NetworkProviderRemoval): string {
    return readPrivateToken(removalFile(this.home, removal.bindingId, removal.credentialRevision), () => "The binding's removal credential is missing.");
  }
  deferProviderRemoval(removal: NetworkProviderRemoval, reason: string, delayMs: number): void {
    this.db.prepare("UPDATE network_binding_removals SET attempts = attempts + 1, reason = ?, next_attempt_at = ?, updated_at = ? WHERE binding_id = ? AND credential_revision = ? AND removal_revision = ? AND status = 'pending'")
      .run(reason, new Date(this.now().getTime() + delayMs).toISOString(), this.now().toISOString(), removal.bindingId, removal.credentialRevision, removal.removalRevision);
  }
  reportProviderRemoval(id: string, input: { provider: unknown; removalRevision: unknown; status: unknown; reason?: unknown; receipt?: Record<string, unknown> }): NetworkBinding {
    const binding = this.get(id);
    if (!binding) throw new NetworkBindingError("binding_not_found", "No network binding has that id.", 404);
    const row = this.db.prepare("SELECT * FROM network_binding_removals WHERE binding_id = ? AND credential_revision = ?").get(id, binding.credentialRevision) as RemovalRow | undefined;
    if (binding.state === "active" || !row || row.removal_revision !== input.removalRevision || JSON.stringify(validProvider(input.provider)) !== row.provider_json) throw new NetworkBindingError("provider_revision_changed", "The receipt must name this ended binding's original provider and removal revision.", 409);
    if (!["confirmed", "unconfirmed", "superseded"].includes(String(input.status))) throw new NetworkBindingError("invalid_removal_status", "Report confirmed, unconfirmed or superseded.");
    if ((row.status === "confirmed" || row.status === "superseded") && row.status !== input.status) throw new NetworkBindingError("provider_revision_changed", "A terminal receipt is already recorded for this revision.", 409);
    const reason = typeof input.reason === "string" ? input.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500) : null;
    this.db.prepare("UPDATE network_binding_removals SET status = ?, reason = ?, receipt_json = COALESCE(?,receipt_json), updated_at = ? WHERE binding_id = ? AND credential_revision = ?")
      .run(input.status, reason, input.receipt ? JSON.stringify(input.receipt) : null, this.now().toISOString(), id, binding.credentialRevision);
    try { this.sweepSecretFiles(id); } catch { /* Retry secret cleanup at the next sweep. Receipt stays durable. */ }
    return this.get(id)!;
  }

  private sweepSecretFiles(id: string): void {
    const folder = dirname(networkCredentialFile(this.home, id));
    if (!existsSync(folder)) { this.db.prepare("UPDATE network_bindings SET credential_cleanup_pending = 0 WHERE id = ?").run(id); return; }
    const binding = this.get(id);
    for (const name of readdirSync(folder)) {
      const work = /^(?:credential|credential-(\d+))\.json$/.exec(name);
      const removal = /^removal-(\d+)\.json$/.exec(name);
      if (work) {
        const revision = Number(work[1] ?? 0);
        if (binding?.state !== "active" || binding.credentialRevision !== revision) rmSync(join(folder, name), { force: true });
      } else if (removal) {
        const revision = Number(removal[1]);
        const owed = this.db.prepare("SELECT 1 FROM network_binding_removals WHERE binding_id = ? AND credential_revision = ? AND status = 'pending'").get(id, revision);
        if (!(binding?.state === "active" && binding.credentialRevision === revision) && !owed) rmSync(join(folder, name), { force: true });
      }
    }
    if (readdirSync(folder).length === 0) rmdirSync(folder);
    this.db.prepare("UPDATE network_bindings SET credential_cleanup_pending = 0 WHERE id = ?").run(id);
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
      this.db.transaction(() => {
        this.recordRemovalIntent(binding);
        this.db.prepare("UPDATE network_bindings SET state = ?, state_reason = ?, credential_cleanup_pending = 1, updated_at = ? WHERE id = ? AND state = 'active'")
          .run(state, reason, this.now().toISOString(), binding.id);
      })();
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
    for (const removal of this.pendingProviderRemovals()) {
      const binding = this.get(removal.bindingId);
      if (binding && binding.credentialRevision === removal.credentialRevision) this.recordRemovalIntent(binding);
    }
    let names: string[];
    try { names = readdirSync(join(this.home, "network-secrets")); } catch { return swept; }
    for (const name of names.sort()) {
      if (!/^netb-[0-9a-f]{20}$/.test(name)) continue;
      if (this.get(name)?.state !== "active") this.db.prepare("UPDATE network_bindings SET credential_cleanup_pending = 1 WHERE id = ?").run(name);
      try { this.sweepSecretFiles(name); if (this.get(name)?.state !== "active") swept.removed.push(name); } catch { swept.failed.push(name); }
    }
    return swept;
  }

  private removeCredential(id: string): void {
    this.sweepSecretFiles(id);
  }
}
