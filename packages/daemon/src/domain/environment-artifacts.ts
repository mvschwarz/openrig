import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { QueueRepository } from "./queue-repository.js";
import type { QueueUpdateInput } from "./queue-repository.js";
import type { PersistedEvent } from "./types.js";
import { EnvironmentError, EnvironmentPlatform, identifier, regularBytes, relativeGuestPath, sha256 } from "./environment-platform.js";

export type ArtifactSchema = { format: "json-object/v1"; fields: Record<string, "string" | "number" | "boolean">; required: string[] };
export type EnvironmentArtifactRequest = { operationId: string; taskId: string; generation: string; path: string;
  sha256: string; bytes: number; schema: ArtifactSchema; context: Record<string, string | number | boolean> };
export type ArtifactCaller = { actor: string; identityProvenance: QueueUpdateInput["identityProvenance"]; identityPrincipal: string | null };
export type EnvironmentArtifactReceipt = { version: 1; operationId: string; bindingId: string; nodeId: string;
  generation: string; taskId: string; path: string; guestPath: string; sha256: string; bytes: number; actor: string;
  identityProvenance: QueueUpdateInput["identityProvenance"]; identityPrincipal: string | null };
const stable = (v: unknown): string => JSON.stringify(v, (_key, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
function refuse(code: string, message: string, status = 409): never { throw new EnvironmentError(code, message, status); }

/** Transfers and verifies actual bytes; publication and the existing work note reconcile on the same operation. */
export class EnvironmentArtifacts {
  constructor(private readonly platform: EnvironmentPlatform, private readonly queue: QueueRepository, private readonly root: string) {}
  private contract(input: EnvironmentArtifactRequest): void {
    identifier(input.operationId, "operationId"); identifier(input.taskId, "taskId"); identifier(input.generation, "generation");
    relativeGuestPath(input.path);
    if (!/^[0-9a-f]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 1024 * 1024)
      refuse("invalid_artifact_contract", "Expected SHA256 and byte count (1 through 1048576) are required", 400);
    const schema = input.schema;
    if (!schema || schema.format !== "json-object/v1" || !schema.fields || Array.isArray(schema.fields)
      || !Array.isArray(schema.required) || Object.keys(schema.fields).length > 100
      || !Object.values(schema.fields).every(v => ["string", "number", "boolean"].includes(v))
      || !schema.required.every(v => typeof v === "string" && Object.hasOwn(schema.fields, v)))
      refuse("invalid_artifact_schema", "A supported json-object/v1 artifact contract is required", 400);
    if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)
      || Object.keys(input.context).length > 100 || !Object.entries(input.context).every(([key, v]) =>
        Object.hasOwn(schema.fields, key) && ["string", "number", "boolean"].includes(typeof v)))
      refuse("invalid_artifact_context", "Context must select declared scalar fields", 400);
  }
  private validate(data: Buffer, input: EnvironmentArtifactRequest): void {
    if (data.length !== input.bytes || sha256(data) !== input.sha256) refuse("artifact_bytes_changed", "Returned bytes do not match the selected artifact");
    let body: Record<string, unknown>;
    try { body = JSON.parse(data.toString("utf8")); } catch { refuse("artifact_schema_mismatch", "The artifact is not JSON"); }
    if (!body! || typeof body! !== "object" || Array.isArray(body!)) refuse("artifact_schema_mismatch", "The artifact must be a JSON object");
    for (const key of input.schema.required) if (!Object.hasOwn(body!, key)) refuse("artifact_schema_mismatch", `Required artifact field ${key} is missing`);
    for (const [key, type] of Object.entries(input.schema.fields))
      if (Object.hasOwn(body!, key) && typeof body![key] !== type) refuse("artifact_schema_mismatch", `Artifact field ${key} has the wrong type`);
    for (const [key, value] of Object.entries(input.context)) if (body![key] !== value) refuse("artifact_context_mismatch", `Artifact field ${key} does not match the selected work context`);
  }
  async export(bindingId: string, input: EnvironmentArtifactRequest, caller: ArtifactCaller): Promise<EnvironmentArtifactReceipt> {
    this.contract(input);
    const binding = this.platform.get(bindingId);
    if (!binding?.resource || !binding.nodeId) refuse("environment_binding_missing", "Export requires a confirmed node binding", 404);
    if (binding.generation !== input.generation) refuse("environment_generation_changed", "This export does not belong to the selected launch generation");
    const task = this.queue.getById(input.taskId);
    if (!task || task.destinationSession !== binding.seat) refuse("artifact_task_mismatch", "The selected work row is not owned by this bound seat");
    if (caller.actor !== task.destinationSession && caller.actor !== task.sourceSession) refuse("artifact_caller_mismatch", "Only the work owner or its assigning caller may request its export", 403);
    const db = this.platform.db;
    const request = stable(input);
    db.transaction(() => {
      const old = db.prepare("SELECT binding_id, kind, request_json FROM environment_operations WHERE operation_id = ?").get(input.operationId) as Record<string, string> | undefined;
      if (old && (old.binding_id !== bindingId || old.kind !== "export" || old.request_json !== request)) refuse("environment_operation_changed", "The export operation input changed");
      if (!old) db.prepare("INSERT INTO environment_operations(operation_id,binding_id,kind,request_json,state) VALUES (?,?,'export',?,'requested')")
        .run(input.operationId, bindingId, request);
    })();
    const targetDir = join(resolve(binding.artifactRoot ?? this.root), bindingId);
    let current = targetDir;
    while (current !== resolve(current, "..")) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) refuse("artifact_publication_conflict", "The publication root contains a symlink");
      current = resolve(current, "..");
    }
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const unchanged = () => {
      const now = this.platform.get(bindingId), taskNow = this.queue.getById(input.taskId);
      if (now?.generation !== input.generation || now.resource?.id !== binding.resource!.id || now.nodeId !== binding.nodeId || taskNow?.destinationSession !== binding.seat)
        refuse("environment_selection_changed", "The binding or work owner changed during export");
    };
    const target = join(targetDir, `${input.taskId}-${input.operationId}.json`);
    // Reconcile existing validated host bytes BEFORE touching a guest that may already have exited.
    if (existsSync(target) || (() => { try { return lstatSync(target).isSymbolicLink(); } catch { return false; } })()) this.validate(regularBytes(target), input);
    else {
      const stage = mkdtempSync(join(targetDir, ".transfer-"));
      try {
        await this.platform.current(bindingId, true);
        const staged = join(stage, "artifact.json");
        await this.platform.driver.download(binding, posix.join(binding.guestRoot, "work/artifacts", input.path), staged);
        this.validate(regularBytes(staged), input);
        unchanged();
        const fd = openSync(staged, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(staged, target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; this.validate(regularBytes(target), input); }
      } finally { rmSync(stage, { recursive: true }); }
    }
    this.validate(regularBytes(target), input);
    unchanged();
    const directory = openSync(targetDir, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    const receipt: EnvironmentArtifactReceipt = { version: 1, operationId: input.operationId, bindingId, nodeId: binding.nodeId,
      generation: input.generation, taskId: input.taskId, path: target, guestPath: posix.join(binding.guestRoot, "work/artifacts", input.path),
      sha256: input.sha256, bytes: input.bytes, actor: caller.actor, identityProvenance: caller.identityProvenance, identityPrincipal: caller.identityPrincipal };
    let events: PersistedEvent[] = [];
    const saved = db.transaction(() => {
      unchanged();
      const old = db.prepare("SELECT receipt_json FROM environment_operations WHERE operation_id = ?").get(input.operationId) as { receipt_json: string | null };
      if (old.receipt_json) return JSON.parse(old.receipt_json) as EnvironmentArtifactReceipt;
      const note = `Environment artifact ${input.operationId}: ${JSON.stringify(receipt)}`;
      // Only the receipt/note changes; never close the child's work on behalf of its owner.
      const result = this.queue.updateWithinTransaction({ qitemId: input.taskId, actorSession: caller.actor, transitionNote: note,
        identityProvenance: caller.identityProvenance, identityPrincipal: caller.identityPrincipal });
      events = result.persistedEvents;
      db.prepare("UPDATE environment_operations SET state = 'confirmed', receipt_json = ? WHERE operation_id = ?").run(JSON.stringify(receipt), input.operationId);
      return receipt;
    })();
    this.queue.notifyCommitted(events);
    return saved;
  }
}
