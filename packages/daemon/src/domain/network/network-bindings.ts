// A selected local seat joined to one participant of a remote hub: the account's network rig, which this daemon reaches
// as an MCP client with that participant's own credential (an external grant). The binding names the local seat by its
// durable node id, so a renamed or relaunched seat keeps it; the hub address represents the seat and never renames it.
// The credential is a private file under the OpenRig home; this table only says where the binding stands.
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  state: NetworkBindingState;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastContactAt: string | null;
  lastError: string | null;
}

export class NetworkBindingError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

interface Row {
  id: string; node_id: string; local_session: string; hub_url: string; hub_seat: string; state: NetworkBindingState;
  state_reason: string | null; created_at: string; updated_at: string; last_contact_at: string | null; last_error: string | null;
}

const project = (row: Row): NetworkBinding => ({
  id: row.id, nodeId: row.node_id, localSession: row.local_session, hubUrl: row.hub_url, hubSeat: row.hub_seat,
  state: row.state, stateReason: row.state_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  lastContactAt: row.last_contact_at, lastError: row.last_error,
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
  const file = networkCredentialFile(home, bindingId);
  let stat;
  try { stat = lstatSync(file); } catch {
    throw new NetworkBindingError("credential_missing", `The credential for ${bindingId} isn't at ${file}. Connect the seat again with its token file.`, 404);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES || (stat.mode & 0o077) !== 0) {
    throw new NetworkBindingError("credential_unsafe", `${file} must be a regular file readable only by this user.`);
  }
  const value = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; token?: unknown };
  if (value.version !== 1 || typeof value.token !== "string" || !value.token) {
    throw new NetworkBindingError("credential_invalid", `${file} isn't a network credential.`);
  }
  return value.token;
}

function validHubUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new NetworkBindingError("invalid_hub_url", "A hub URL is required.");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new NetworkBindingError("invalid_hub_url", `'${raw}' isn't a URL.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new NetworkBindingError("invalid_hub_url", "The hub URL must use https (or http).");
  // A credential in the URL would be stored in plain text in this table and shown in status.
  if (url.username || url.password) throw new NetworkBindingError("invalid_hub_url", "Put the participant's token in its token file, not in the hub URL.");
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
  constructor(private readonly db: Database.Database, private readonly home: string, private readonly now: () => Date = () => new Date()) {}

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
   *  and private; the row follows in one transaction, so a refused bind leaves no credential behind. */
  create(input: { session: unknown; hubUrl: unknown; hubSeat: unknown; token: unknown }): NetworkBinding {
    const session = typeof input.session === "string" ? input.session.trim() : "";
    if (!session) throw new NetworkBindingError("invalid_seat", "Name the local seat to connect.");
    const nodeId = resolveSessionNodeId(this.db, session);
    if (!nodeId) throw new NetworkBindingError("seat_not_found", `No local seat is named '${session}'.`, 404);
    const hubUrl = validHubUrl(input.hubUrl);
    const hubSeat = validHubSeat(input.hubSeat);
    const token = validToken(input.token);
    const bound = this.db.prepare("SELECT id FROM network_bindings WHERE node_id = ? AND state = 'active'").get(nodeId) as { id: string } | undefined;
    if (bound) throw new NetworkBindingError("seat_already_connected", `${session} is already connected (${bound.id}). Disconnect it first.`, 409);
    const taken = this.db.prepare("SELECT id FROM network_bindings WHERE hub_url = ? AND hub_seat = ? AND state = 'active'").get(hubUrl, hubSeat) as { id: string } | undefined;
    if (taken) throw new NetworkBindingError("participant_already_connected", `${hubSeat} at ${hubUrl} is already connected (${taken.id}).`, 409);

    const id = `netb-${randomBytes(10).toString("hex")}`;
    const file = networkCredentialFile(this.home, id);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ version: 1, token })}\n`, { flag: "wx", mode: 0o600 });
    const at = this.now().toISOString();
    try {
      this.db.prepare(`INSERT INTO network_bindings (id, node_id, local_session, hub_url, hub_seat, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(id, nodeId, session, hubUrl, hubSeat, at, at);
    } catch (error) {
      this.removeCredential(id);
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

  /** The connector reached the hub as this binding. */
  recordContact(id: string, at: Date = this.now()): void {
    this.db.prepare("UPDATE network_bindings SET last_contact_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(at.toISOString(), at.toISOString(), id);
  }

  /** The connector couldn't reach the hub as this binding, or the hub answered with an error; the binding stays active. */
  recordError(id: string, message: string): void {
    this.db.prepare("UPDATE network_bindings SET last_error = ?, updated_at = ? WHERE id = ?")
      .run(message.slice(0, 500), this.now().toISOString(), id);
  }

  private end(ref: string, state: "disconnected" | "revoked", reason: string): NetworkBinding {
    const binding = this.find(ref);
    if (!binding) throw new NetworkBindingError("binding_not_found", `No network binding or connected seat is named '${ref}'.`, 404);
    if (binding.state !== "active") return binding;
    this.db.prepare("UPDATE network_bindings SET state = ?, state_reason = ?, updated_at = ? WHERE id = ? AND state = 'active'")
      .run(state, reason, this.now().toISOString(), binding.id);
    this.removeCredential(binding.id);
    return this.get(binding.id)!;
  }

  private removeCredential(id: string): void {
    const file = networkCredentialFile(this.home, id);
    if (existsSync(dirname(file))) rmSync(dirname(file), { recursive: true, force: true });
  }
}
