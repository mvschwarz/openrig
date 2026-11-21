import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { QueueRepository } from "./queue-repository.js";
import { resolveRegisteredHumanAddress } from "./gateway/human-registry.js";

export class CoreAppError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503, readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}
export interface CoreAppCredential { credentialId: string; appId: string; actors: string[] }
interface CredentialRow { credential_id: string; app_id: string; actors_json: string }
export const appHash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Independent app access: hash-only secrets, fixed credential scope, app-scoped submissions. */
export class CoreAppAccess {
  constructor(readonly db: Database.Database, private readonly queue: QueueRepository) {}

  assertAvailable(): void {
    const count = this.db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name IN
      ('core_app_credentials', 'core_app_submissions', 'queue_items', 'mission_control_actions', 'events', 'events_retention_marks')`).get() as { n: number };
    if (count.n !== 6) throw new CoreAppError("app_job_unavailable", 503);
  }

  actor(address: unknown): string {
    if (typeof address !== "string" || !address) throw new CoreAppError("actor_required", 400);
    let registry: ReturnType<QueueRepository["humanRegistry"]>;
    try { registry = this.queue.humanRegistry(); } catch { throw new CoreAppError("app_job_unavailable", 503); }
    if (!registry.ok) throw new CoreAppError("app_job_unavailable", 503);
    const canonical = resolveRegisteredHumanAddress(address, registry.entities);
    if (!canonical || !registry.entities.some(entity => entity.address === canonical && entity.class === "human") || this.queue.isSharedChannel(canonical)) {
      throw new CoreAppError("actor_not_registered", 422);
    }
    return canonical;
  }

  authorizeActor(credential: CoreAppCredential, address: unknown): string {
    const actor = this.actor(address);
    if (!credential.actors.includes(actor)) throw new CoreAppError("actor_outside_scope", 403);
    return actor;
  }

  issue(input: Record<string, unknown>) {
    this.assertAvailable();
    exactKeys(input, ["appId", "actors", "job", "attribution"]);
    if (input.job !== "human-answer") throw new CoreAppError("unsupported_job", 422);
    if (input.attribution !== "app-attributed") throw new CoreAppError("unsupported_actor_assurance", 422);
    if (typeof input.appId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.appId)) throw new CoreAppError("invalid_app_id", 422);
    if (!Array.isArray(input.actors) || input.actors.length < 1 || input.actors.length > 16) throw new CoreAppError("invalid_actors", 422);
    const actors = input.actors.map(actor => this.actor(actor));
    if (new Set(actors).size !== actors.length) throw new CoreAppError("invalid_actors", 422);
    const token = `orapp_${randomBytes(32).toString("hex")}`, credentialId = randomUUID();
    this.db.prepare("INSERT INTO core_app_credentials (credential_id, app_id, token_hash, actors_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(credentialId, input.appId, appHash(token), JSON.stringify(actors), new Date().toISOString());
    return { credentialId, appId: input.appId, token, scope: { job: "human-answer", actors, read: "instance-human-questions-and-linked-results" }, attribution: "app-attributed" };
  }

  authenticate(header: string | undefined): CoreAppCredential {
    const match = /^Bearer (orapp_[a-f0-9]{64})$/.exec(header ?? "");
    if (match) this.assertAvailable();
    const row = match ? this.db.prepare("SELECT credential_id, app_id, actors_json FROM core_app_credentials WHERE token_hash = ? AND revoked_at IS NULL")
      .get(appHash(match[1]!)) as CredentialRow | undefined : undefined;
    if (!row) throw new CoreAppError("unauthorized", 401);
    const actors = JSON.parse(row.actors_json) as string[];
    for (const actor of actors) this.actor(actor); // current registration is checked on every call, including streams
    return { credentialId: row.credential_id, appId: row.app_id, actors };
  }

  revoke(id: string) {
    this.db.prepare("UPDATE core_app_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE credential_id = ?").run(new Date().toISOString(), id);
  }
}

export function exactKeys(input: Record<string, unknown>, keys: string[]): void {
  const unknown = Object.keys(input).find(key => !keys.includes(key));
  if (unknown) throw new CoreAppError("unknown_write_field", 400, { field: unknown });
}
export function appObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CoreAppError("invalid_body", 400);
  return input as Record<string, unknown>;
}

export interface CoreAppSubmission {
  app_id: string; answer_id: string; request_id: string; binding_hash: string;
  binding_json: string | null; checkpoint_json: string | null; receipt_json: string | null; erased_at: string | null;
}


/** Participate in the queue erasure batch transaction, including databases that predate app access. */
export function redactCoreAppSubmissions(db: Database.Database, requestIds: string[], erasedAt: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'core_app_submissions'").get()) return;
  db.prepare(`UPDATE core_app_submissions SET binding_hash = '', binding_json = NULL, checkpoint_json = NULL, receipt_json = NULL,
    erased_at = COALESCE(erased_at, ?) WHERE request_id IN (SELECT value FROM json_each(?))`)
    .run(erasedAt, JSON.stringify(requestIds));
}
