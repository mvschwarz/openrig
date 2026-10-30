import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";

export const ENVIRONMENT_DRIVER_VERSION = 1;
export type EnvironmentResource = { id: string; name: string; workspace: string; fingerprint?: string; phase: string; operationId?: string };
export type Placement = { gateway: string; workspace: string; name: string; image: string; provider: string; policy: string; policySha256?: string };
export type EnvironmentConfig = {
  version: 1; bindingId: string; nodeId?: string; seat: string; coordinationRef?: string; artifactRoot?: string; baseRuntime: "claude-code";
  guestRoot: string; guestBaseUrl: string; placement: Placement;
};
export type EnvironmentBinding = EnvironmentConfig & {
  ownership: "owned" | "attached"; resource: EnvironmentResource | null; generation: string | null;
};
export type ProjectionFile = { source: string; path: string; sha256: string; required: boolean; transient?: boolean; sourceIdentity?: { path: string; sha256: string } };
export type ProjectionReceipt = { path: string; sha256: string; bytes: number; required: boolean; sourceFile?: string; sourceSha256?: string };

/** Version 1 trusted driver boundary. Providers own calls/path mapping; Core owns identity, intent and receipts. */
export interface EnvironmentDriver {
  readonly version: 1;
  list(placement: Placement): Promise<{ complete: boolean; resources: EnvironmentResource[] }>;
  create(input: { operationId: string; placement: Placement }): Promise<EnvironmentResource>;
  inspect(binding: EnvironmentBinding): Promise<EnvironmentResource>;
  upload(binding: EnvironmentBinding, source: string, destination: string, previousHash?: string, executable?: boolean): Promise<void>;
  read(binding: EnvironmentBinding, path: string): Promise<Buffer>;
  download(binding: EnvironmentBinding, source: string, destination: string): Promise<void>;
}
export class EnvironmentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
function fail(code: string, message: string, status = 409): never { throw new EnvironmentError(code, message, status); }
export function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) fail("invalid_environment_request", `${name} must be a short identifier`, 400);
  return value;
}
export function relativeGuestPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)
    || value.split("/").some(p => !p || p === "." || p === "..")) fail("invalid_environment_path", "A relative guest path without traversal is required", 400);
  return value;
}
export function regularBytes(file: string, limit = 1024 * 1024): Buffer {
  if (!isAbsolute(file)) fail("invalid_environment_path", "An absolute host file path is required", 400);
  let current = resolve(file);
  while (current !== resolve(current, "..")) {
    if (lstatSync(current).isSymbolicLink()) fail("environment_symlink", "Symlink components are not accepted");
    current = resolve(current, "..");
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > limit) fail("invalid_environment_file", "A bounded regular file is required");
  const data = readFileSync(file);
  if (data.length !== stat.size || data.length > limit) fail("environment_file_changed", "The file changed while reading");
  return data;
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

export class EnvironmentPlatform {
  readonly protocolVersion = 1 as const;
  constructor(readonly db: Database.Database, readonly driver: EnvironmentDriver) {
    if (driver.version !== 1) fail("environment_driver_unsupported", "Environment driver protocol 1 is required");
  }
  get(id: string): EnvironmentBinding | null {
    const row = this.db.prepare("SELECT * FROM environment_bindings WHERE binding_id = ?").get(id) as Record<string, any> | undefined;
    return row ? { ...JSON.parse(row.config_json), nodeId: row.node_id ?? undefined, ownership: row.ownership,
      resource: row.resource_json ? JSON.parse(row.resource_json) : null, generation: row.generation } : null;
  }
  forNode(nodeId: string, seat?: string): EnvironmentBinding | null {
    const row = this.db.prepare("SELECT binding_id FROM environment_bindings WHERE node_id = ? OR (node_id IS NULL AND seat = ?)")
      .get(nodeId, seat ?? "") as { binding_id: string } | undefined;
    return row ? this.get(row.binding_id) : null;
  }
  private config(input: EnvironmentConfig): EnvironmentConfig {
    if (!input || input.version !== 1 || input.baseRuntime !== "claude-code") fail("invalid_environment_request", "Version 1 and baseRuntime claude-code are required", 400);
    identifier(input.bindingId, "bindingId");
    if (typeof input.seat !== "string" || !/^[^\s@]+@[^\s@]+$/.test(input.seat)) fail("invalid_environment_request", "A canonical seat address is required", 400);
    if (input.guestRoot !== "/sandbox/openrig") fail("invalid_environment_path", "A normalized absolute guest root is required", 400);
    let url: URL; try { url = new URL(input.guestBaseUrl); } catch { fail("invalid_environment_request", "A guest-reachable daemon origin is required", 400); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      fail("invalid_environment_request", "The guest endpoint must be an HTTP(S) origin without credentials", 400);
    const place = input.placement;
    if (!place || !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(place.name)
      || !/^.+@sha256:[0-9a-f]{64}$/.test(place.image)) fail("invalid_environment_request", "An OpenShell name and digest-pinned image are required", 400);
    for (const key of ["gateway", "workspace", "provider"] as const)
      if (typeof place[key] !== "string" || !place[key] || /[\s\0]/.test(place[key])) fail("invalid_environment_request", `placement.${key} is required`, 400);
    const policySha256 = sha256(regularBytes(place.policy));
    if (input.nodeId && !this.db.prepare("SELECT id FROM nodes WHERE id = ?").get(input.nodeId)) fail("environment_node_missing", "The selected node is missing", 404);
    return { version: 1, bindingId: input.bindingId, ...(input.nodeId ? { nodeId: input.nodeId } : {}), seat: input.seat,
      ...(typeof input.coordinationRef === "string" ? { coordinationRef: input.coordinationRef } : {}),
      ...(typeof input.artifactRoot === "string" && isAbsolute(input.artifactRoot) ? { artifactRoot: resolve(input.artifactRoot) } : {}),
      baseRuntime: input.baseRuntime, guestRoot: input.guestRoot, guestBaseUrl: url.origin,
      placement: { gateway: place.gateway, workspace: place.workspace, name: place.name, image: place.image, provider: place.provider, policy: place.policy, policySha256 } };
  }
  private intent(id: string, kind: string, binding: EnvironmentConfig, ownership: "owned" | "attached", request: unknown): { fresh: boolean; state: string; effectId: string; receipt: any } {
    identifier(id, "operationId");
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM environment_operations WHERE operation_id = ?").get(id) as Record<string, any> | undefined;
      if (prior) {
        if (prior.binding_id !== binding.bindingId || prior.kind !== kind || prior.request_json !== stable(request))
          fail("environment_operation_changed", "An operation identity cannot be reused with different input");
        return { fresh: false, state: prior.state, effectId: prior.effect_id, receipt: prior.receipt_json ? JSON.parse(prior.receipt_json) : null };
      }
      const existing = this.get(binding.bindingId);
      if (existing) {
        const protectedOperation = this.db.prepare("SELECT 1 FROM environment_operations WHERE binding_id = ? AND state <> 'intent'").get(binding.bindingId);
        if (existing.resource || protectedOperation) fail("environment_binding_exists", "The existing binding has a provider effect; reconcile it before replacement");
        this.db.prepare("DELETE FROM environment_operations WHERE binding_id = ?").run(binding.bindingId);
        this.db.prepare("DELETE FROM environment_bindings WHERE binding_id = ?").run(binding.bindingId);
      }
      if (this.db.prepare("SELECT 1 FROM environment_bindings WHERE seat = ? OR (node_id IS NOT NULL AND node_id = ?)").get(binding.seat, binding.nodeId ?? null))
        fail("environment_seat_bound", "This stable seat or node already has another binding");
      this.db.prepare("INSERT INTO environment_bindings(binding_id,version,node_id,seat,ownership,config_json) VALUES (?,1,?,?,?,?)")
        .run(binding.bindingId, binding.nodeId ?? null, binding.seat, ownership, JSON.stringify(binding));
      const effectId = `env-${randomUUID()}`;
      this.db.prepare("INSERT INTO environment_operations(operation_id,binding_id,kind,request_json,effect_id,state) VALUES (?,?,?,?,?,'intent')")
        .run(id, binding.bindingId, kind, stable(request), effectId);
      return { fresh: true, state: "intent", effectId, receipt: null };
    })();
  }
  private confirm(operationId: string, bindingId: string, resource: EnvironmentResource): EnvironmentBinding {
    this.db.transaction(() => {
      this.db.prepare("UPDATE environment_bindings SET resource_json = ? WHERE binding_id = ?").run(JSON.stringify(resource), bindingId);
      this.db.prepare("UPDATE environment_operations SET state = 'confirmed', receipt_json = ? WHERE operation_id = ?").run(JSON.stringify(resource), operationId);
    })();
    return this.get(bindingId)!;
  }
  async create(input: EnvironmentConfig & { operationId: string }): Promise<{ status: number; binding: EnvironmentBinding | null; code?: string }> {
    const config = this.config(input), op = this.intent(input.operationId, "create", config, "owned", config);
    if (op.state === "confirmed") return { status: 200, binding: this.get(config.bindingId) };
    let listed: Awaited<ReturnType<EnvironmentDriver["list"]>>;
    try { listed = await this.driver.list(config.placement); } catch { return { status: 202, binding: this.get(config.bindingId), code: "environment_unconfirmed" }; }
    if (!listed.complete) return { status: 202, binding: this.get(config.bindingId), code: "environment_listing_incomplete" };
    const matches = listed.resources.filter(r => r.operationId === op.effectId);
    if (matches.length > 1) fail("environment_duplicate_resources", "More than one resource matches the saved create operation");
    if (matches.length === 1) {
      const found = matches[0]!;
      if (found.name !== config.placement.name || found.workspace !== config.placement.workspace || !found.id) fail("environment_identity_changed", "The operation resource does not match the selected placement");
      return { status: 200, binding: this.confirm(input.operationId, config.bindingId, found) };
    }
    // A complete empty listing after a requested effect is still not permission to repeat an asynchronous create.
    if (op.state !== "intent") return { status: 202, binding: this.get(config.bindingId), code: "environment_create_unconfirmed" };
    if (listed.resources.some(r => r.name === config.placement.name)) fail("environment_name_in_use", "The selected name already belongs to another resource");
    const claimed = this.db.prepare("UPDATE environment_operations SET state = 'requested' WHERE operation_id = ? AND state = 'intent'").run(input.operationId);
    if (!claimed.changes) return { status: 202, binding: this.get(config.bindingId), code: "environment_create_unconfirmed" };
    try {
      const resource = await this.driver.create({ operationId: op.effectId, placement: config.placement });
      if (!resource.id || resource.name !== config.placement.name || resource.workspace !== config.placement.workspace || resource.operationId !== op.effectId)
        return { status: 202, binding: this.get(config.bindingId), code: "environment_create_unconfirmed" };
      return { status: 201, binding: this.confirm(input.operationId, config.bindingId, resource) };
    } catch { return { status: 202, binding: this.get(config.bindingId), code: "environment_create_unconfirmed" }; }
  }
  async attach(input: EnvironmentConfig & { operationId: string; resourceId: string; fingerprint?: string }): Promise<{ status: number; binding: EnvironmentBinding }> {
    const config = this.config(input); identifier(input.operationId, "operationId");
    if (typeof input.resourceId !== "string" || !input.resourceId) fail("invalid_environment_request", "An immutable resource ID is required", 400);
    const candidate = { ...config, ownership: "attached" as const, resource: { id: input.resourceId, name: config.placement.name,
      workspace: config.placement.workspace, fingerprint: input.fingerprint, phase: "unknown" }, generation: null };
    const observed = await this.driver.inspect(candidate);
    this.assertResource(candidate, observed);
    const op = this.intent(input.operationId, "attach", config, "attached", { config, resourceId: input.resourceId, fingerprint: input.fingerprint });
    return { status: op.state === "confirmed" ? 200 : 201, binding: this.confirm(input.operationId, config.bindingId, observed) };
  }
  assertResource(binding: EnvironmentBinding, resource: EnvironmentResource, ready = false): void {
    const expected = binding.resource;
    if (!expected || resource.id !== expected.id || resource.name !== expected.name || resource.workspace !== expected.workspace
      || expected.fingerprint && resource.fingerprint !== expected.fingerprint) fail("environment_identity_changed", "The provider resource no longer matches the immutable binding");
    if (ready && resource.phase !== "Ready") fail("environment_not_ready", "Projection and export require the bound environment to be Ready");
  }
  async current(id: string, ready = false): Promise<EnvironmentBinding> {
    const binding = this.get(id); if (!binding) fail("environment_binding_missing", "No selected environment binding", 404);
    this.assertResource(binding, await this.driver.inspect(binding), ready); return binding;
  }
  async project(id: string, input: { operationId: string; generation: string; files: ProjectionFile[] }): Promise<{ version: 1; bindingId: string; generation: string; files: ProjectionReceipt[] }> {
    identifier(input.operationId, "operationId"); identifier(input.generation, "generation");
    if (!Array.isArray(input.files) || input.files.length > 4096) fail("invalid_environment_request", "A bounded explicit file list is required", 400);
    const binding = await this.current(id, true);
    const planned = input.files.map(file => {
      const path = relativeGuestPath(file.path), data = regularBytes(file.source);
      if (!/^[0-9a-f]{64}$/.test(file.sha256) || sha256(data) !== file.sha256) fail("environment_projection_changed", "A selected source file changed");
      return { file, path, data };
    });
    if (planned.reduce((bytes, item) => bytes + item.data.length, 0) > 32 * 1024 * 1024) fail("environment_projection_too_large", "The selected projection exceeds 32 MiB");
    if (new Set(planned.map(p => p.path)).size !== planned.length) fail("invalid_environment_request", "Duplicate projection destinations", 400);
    const saved = this.db.prepare("SELECT projection_json FROM environment_bindings WHERE binding_id = ?").get(id) as { projection_json: string | null };
    const previous = new Map<string, ProjectionReceipt>((saved.projection_json ? JSON.parse(saved.projection_json).files : []).map((f: ProjectionReceipt) => [f.path, f]));
    const changedPaths = new Set(planned.map(item => item.path));
    const retained = [...previous.values()].filter(file => !changedPaths.has(file.path));
    if (retained.length + planned.length > 4096 || retained.reduce((sum, file) => sum + file.bytes, 0) + planned.reduce((sum, item) => sum + item.data.length, 0) > 32 * 1024 * 1024)
      fail("environment_projection_too_large", "The combined destination projection exceeds its file or byte cap");
    const receipt: ProjectionReceipt[] = [];
    for (const { file, path, data } of planned) {
      const destination = posix.join(binding.guestRoot, path);
      this.assertResource(binding, await this.driver.inspect(binding), true);
      let existing: Buffer | undefined;
      try { existing = await this.driver.read(binding, destination); } catch (error) {
        if (!(error instanceof EnvironmentError && error.code === "environment_file_missing")) throw error;
      }
      if (existing && sha256(existing) !== file.sha256 && sha256(existing) !== previous.get(path)?.sha256)
        fail("environment_projection_conflict", "An unmanaged or changed destination file was preserved");
      if (!existing || sha256(existing) !== file.sha256) await this.driver.upload(binding, file.source, destination, existing ? sha256(existing) : undefined, Boolean(lstatSync(file.source).mode & 0o111));
      const actual = await this.driver.read(binding, destination);
      if (!actual.equals(data)) fail("environment_projection_changed", "The destination bytes do not match the resolved source");
      receipt.push({ path, sha256: file.sha256, bytes: data.length, required: file.required,
        ...(!file.transient ? { sourceFile: file.sourceIdentity?.path ?? file.source, sourceSha256: file.sourceIdentity?.sha256 ?? file.sha256 } : {}) });
    }
    const result = { version: 1 as const, bindingId: id, generation: input.generation,
      files: retained.concat(receipt) };
    this.db.prepare("UPDATE environment_bindings SET projection_json = ?, generation = ? WHERE binding_id = ?")
      .run(JSON.stringify(result), input.generation, id);
    return result;
  }
  async validate(id: string, generation: string): Promise<void> {
    const binding = await this.current(id, true);
    if (binding.generation !== generation) fail("environment_generation_changed", "The prepared environment belongs to another launch generation");
    const row = this.db.prepare("SELECT projection_json FROM environment_bindings WHERE binding_id = ?").get(id) as { projection_json: string | null };
    if (!row.projection_json) fail("environment_projection_missing", "No validated destination projection is available");
    for (const file of JSON.parse(row.projection_json).files as ProjectionReceipt[]) {
      try {
        if (file.sourceFile && sha256(regularBytes(file.sourceFile)) !== file.sourceSha256) fail("environment_projection_source_changed", "A resolved projection source changed before launch");
        const data = await this.driver.read(binding, posix.join(binding.guestRoot, file.path));
        if (sha256(data) !== file.sha256 || data.length !== file.bytes) fail("environment_projection_changed", "A prepared destination file changed before launch");
      } catch (error) { if (file.required) throw error; }
    }
  }
  effect(id: string, effect: string): never {
    const binding = this.get(id); if (!binding) fail("environment_binding_missing", "No environment binding", 404);
    if (binding.ownership === "attached") fail("environment_attached_preserved", "Attached native, storage and compute are preserved");
    fail("environment_effect_unsupported", `Effect ${effect} is not implemented by this version 1 driver`, 501);
  }
}
