import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EnvironmentPlatform, EnvironmentError, identifier, regularBytes, relativeGuestPath, sha256, type EnvironmentBinding, type EnvironmentDriver, type Placement } from "./environment-platform.js";
import type { PodmanCleanupSelection } from "../adapters/openshell-podman-observer.js";
import type { QueueRepository } from "./queue-repository.js";

export type EnvironmentEffect = "close-viewer" | "stop-native" | "stop-compute" | "delete-owned";
export type NativeObservation = { nativeId: string; generation: string; running: boolean };
export type DependentObservation = { workload: boolean; supervisor: boolean; volumes: boolean };
export type EnvironmentLifecycleDriver = EnvironmentDriver & {
  nativeIdentity?(binding: EnvironmentBinding): Promise<NativeObservation>;
  stopNative?(binding: EnvironmentBinding, native: NativeObservation, operationId: string, beforeDispatch?: () => boolean): Promise<void>;
  stopCompute?(binding: EnvironmentBinding, operationId: string, beforeDispatch?: () => boolean): Promise<void>;
  deleteEnvironment?(binding: EnvironmentBinding, operationId: string): Promise<void>;
  captureCleanup?(binding: EnvironmentBinding, socket: string): Promise<PodmanCleanupSelection>;
  cleanupState?(binding: EnvironmentBinding, selection?: PodmanCleanupSelection): Promise<DependentObservation>;
  checkpointFiles?(binding: EnvironmentBinding, native: NativeObservation): Promise<Array<{ path: string; sha256: string; bytes: number }>>;
};
export type EnvironmentCheckpoint = {
  version: 1; checkpointId: string; bindingId: string; nodeId: string; seat: string; generation: string;
  nativeType: "community:openshell-claude"; nativeId: string; predecessorResourceId: string;
  destinationCwd: string; nativeState: string; artifacts: Array<{ path: string; source: string; sha256: string; bytes: number; taskId: string }>; files: Array<{ path: string; source: string; sha256: string; bytes: number }>;
};
export type EffectReceipt = { version: 1; operationId: string; bindingId: string; generation: string; resourceId: string;
  effect: EnvironmentEffect; state: "confirmed" | "pending" | "unconfirmed"; remaining?: DependentObservation; detail?: string };
type Operation = { binding_id: string; kind: string; request_json: string; state: string; receipt_json: string | null; effect_id: string | null };
const stable = (v: unknown): string => JSON.stringify(v, (_key, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
function refuse(code: string, message: string, status = 409): never { throw new EnvironmentError(code, message, status); }
function privateDirectory(path: string): void {
  let current = resolve(path);
  while (current !== resolve(current, "..")) {
    try { if (lstatSync(current).isSymbolicLink()) refuse("environment_state_symlink", "Private environment state has a symlink component"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    current = resolve(current, "..");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
function syncFile(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** Existing binding/effect journal, with no task duplication or provider-wide policy engine. */
export class EnvironmentLifecycle {
  private readonly driver: EnvironmentLifecycleDriver;
  constructor(readonly platform: EnvironmentPlatform, private readonly queue: QueueRepository | undefined, private readonly stateRoot: string,
    private readonly viewer?: (binding: EnvironmentBinding) => Promise<{ confirmed: boolean }>) { this.driver = platform.driver; }
  private selected(id: string, generation: string): EnvironmentBinding {
    identifier(generation, "generation"); const binding = this.platform.get(id);
    if (!binding?.resource || !binding.nodeId) refuse("environment_binding_missing", "A confirmed node and compute binding is required");
    if (binding.generation !== generation) refuse("environment_generation_changed", "The selected execution generation changed");
    return binding;
  }
  private operation(id: string): Operation | undefined { return this.platform.db.prepare("SELECT * FROM environment_operations WHERE operation_id = ?").get(id) as Operation | undefined; }
  private intent(binding: EnvironmentBinding, id: string, kind: string, request: unknown): Operation {
    identifier(id, "operationId");
    return this.platform.db.transaction(() => {
      const existing = this.operation(id), text = stable(request);
      if (existing) {
        if (existing.binding_id !== binding.bindingId || existing.kind !== kind || existing.request_json !== text) refuse("environment_operation_changed", "The saved effect identity has different input");
        return existing;
      }
      this.platform.db.prepare("INSERT INTO environment_operations(operation_id,binding_id,kind,request_json,effect_id,state) VALUES (?,?,?,?,?,'intent')")
        .run(id, binding.bindingId, kind, text, `env-${randomUUID()}`);
      return this.operation(id)!;
    })();
  }
  private save(id: string, receipt: unknown): void {
    this.platform.db.prepare("UPDATE environment_operations SET state='confirmed',receipt_json=? WHERE operation_id=?").run(JSON.stringify(receipt), id);
  }
  private claim(id: string): boolean { return this.platform.db.prepare("UPDATE environment_operations SET state='requested' WHERE operation_id=? AND state='intent'").run(id).changes === 1; }
  native(binding: EnvironmentBinding): { nativeId: string; generation: string; nativeType: "community:openshell-claude" } {
    const rows = this.platform.db.prepare("SELECT receipt_json FROM environment_operations WHERE binding_id=? AND kind='launch' AND state='confirmed' ORDER BY rowid DESC").all(binding.bindingId) as Array<{ receipt_json: string }>;
    const native = rows.map(row => JSON.parse(row.receipt_json)).find(row => row.resourceId === binding.resource!.id && row.generation === binding.generation);
    if (!native || native.nativeType !== "community:openshell-claude" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(native.nativeId)) refuse("environment_native_unconfirmed", "The selected compute has no confirmed exact native identity");
    return native;
  }
  async effect(id: string, input: { operationId: string; generation: string; effect: EnvironmentEffect; engineSocket?: string; requestedBy?: string }, beforeDispatch?: () => boolean): Promise<EffectReceipt> {
    if (!["close-viewer", "stop-native", "stop-compute", "delete-owned"].includes(input.effect)) refuse("environment_effect_unsupported", "Select close-viewer, stop-native, stop-compute or delete-owned", 400);
    const binding = this.selected(id, input.generation);
    if (input.effect !== "close-viewer" && binding.ownership !== "owned") refuse("environment_attached_preserved", "Attached native, storage and compute are preserved; close only this consumer's viewer");
    const request = { ...input, resourceId: binding.resource!.id }, op = this.intent(binding, input.operationId, "effect", request);
    if (op.receipt_json) return JSON.parse(op.receipt_json);
    const base = { version: 1 as const, operationId: input.operationId, bindingId: id, generation: input.generation, resourceId: binding.resource!.id, effect: input.effect, ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}) };
    const result = (state: EffectReceipt["state"], extra: Partial<EffectReceipt> = {}): EffectReceipt => ({ ...base, state, ...extra });
    const confirm = (extra: Partial<EffectReceipt> = {}) => { const receipt = result("confirmed", extra); this.save(input.operationId, receipt); return receipt; };
    // Re-check at Core's call boundary AND inside the driver's final identity await.
    // Only a known pre-dispatch refusal releases the claim; transport uncertainty never does.
    const dispatch = async (run: (allowed: () => boolean) => Promise<void>): Promise<boolean> => {
      if (!this.claim(input.operationId)) return true;
      let refused = false;
      const allowed = () => {
        const current = this.platform.get(id);
        const eligible = current?.generation === input.generation && current.resource?.id === binding.resource!.id && (!beforeDispatch || beforeDispatch());
        if (!eligible) refused = true;
        return eligible;
      };
      try { if (!allowed()) throw new Error("selection changed"); await run(allowed); }
      catch { if (refused) { this.platform.db.prepare("UPDATE environment_operations SET state='intent' WHERE operation_id=? AND state='requested'").run(input.operationId); return false; } }
      return true;
    };
    try {
      if (input.effect === "close-viewer") {
        if (!this.viewer) refuse("environment_effect_unsupported", "This daemon has no managed viewer close operation", 501);
        // Viewer cleanup is repeatably observational at the exact owned seat; it never reaches the guest provider.
        return (await this.viewer(binding)).confirmed ? confirm() : result("unconfirmed", { detail: "Viewer absence is not confirmed; native and compute are unchanged" });
      }
      if (input.effect === "delete-owned") {
        if (!this.driver.deleteEnvironment || !this.driver.cleanupState) refuse("environment_effect_unsupported", "This driver cannot verify workload/supervisor/volume cleanup", 501);
        let listed = await this.driver.list(binding.placement);
        if (!listed.complete) return result("unconfirmed", { detail: "Provider listing is incomplete" });
        if (listed.resources.some(row => row.name === binding.resource!.name && row.id !== binding.resource!.id)) refuse("environment_identity_changed", "The resource name was reused; nothing was deleted");
        const inventoryId = `inventory-${binding.resource!.id}`;
        let inventory = this.operation(inventoryId)?.receipt_json;
        if (this.driver.captureCleanup && !inventory) {
          if (!input.engineSocket) refuse("environment_engine_required", "Select the local provider's rootless Podman socket before delete", 400);
          const captured = await this.driver.captureCleanup(binding, input.engineSocket);
          this.intent(binding, inventoryId, "cleanup-inventory", { resourceId: binding.resource!.id, engineSocket: input.engineSocket });
          this.save(inventoryId, captured); inventory = JSON.stringify(captured);
        }
        const found = listed.resources.find(row => row.id === binding.resource!.id);
        if (found) {
          this.platform.assertResource(binding, found);
          this.selected(id, input.generation);
          if (this.claim(input.operationId)) { try { await this.driver.deleteEnvironment(binding, op.effect_id!); } catch { /* observe original effect, never repeat */ } }
          listed = await this.driver.list(binding.placement);
        }
        if (!listed.complete || listed.resources.some(row => row.id === binding.resource!.id || row.name === binding.resource!.name)) return result("pending", { detail: "Exact provider absence is not confirmed" });
        const remaining = await this.driver.cleanupState(binding, inventory ? JSON.parse(inventory) : undefined);
        if (Object.values(remaining).some(value => value !== false)) return result("unconfirmed", { remaining, detail: "Provider absence does not establish dependent cleanup" });
        return confirm({ remaining });
      }
      const actual = await this.platform.current(id);
      if (input.effect === "stop-compute") {
        if (!this.driver.stopCompute) refuse("environment_effect_unsupported", "Compute stop is unsupported", 501);
        if (actual.resource!.phase === "Stopped") return confirm();
        // current() checks identity but retains stored phase; observe the fresh phase explicitly.
        if ((await this.driver.inspect(binding)).phase === "Stopped") return confirm();
        if (!await dispatch(allowed => this.driver.stopCompute!(binding, op.effect_id!, allowed))) return result("pending", { detail: "The selection changed before dispatch; no stop was sent" });
        const after = await this.driver.inspect(binding); this.platform.assertResource(binding, after);
        return after.phase === "Stopped" ? confirm() : result("pending", { detail: "Compute stop was requested; Stopped is not yet observed" });
      }
      if (!this.driver.nativeIdentity || !this.driver.stopNative) refuse("environment_effect_unsupported", "Exact native stop is unsupported", 501);
      const native = this.native(binding), before = await this.driver.nativeIdentity(binding);
      if (before.nativeId !== native.nativeId || before.generation !== input.generation) refuse("environment_native_changed", "The observed native execution differs; no signal was sent");
      if (!before.running) return confirm();
      if (!await dispatch(allowed => this.driver.stopNative!(binding, before, op.effect_id!, allowed))) return result("pending", { detail: "The selection changed before dispatch; no stop was sent" });
      const after = await this.driver.nativeIdentity(binding);
      if (after.nativeId !== native.nativeId || after.generation !== input.generation) return result("unconfirmed", { detail: "The native observation changed during stop" });
      return !after.running ? confirm() : result("pending", { detail: "Native TERM requested; execution is still present" });
    } catch (error) {
      if (error instanceof EnvironmentError) throw error;
      return result("unconfirmed", { detail: "The original effect could not be observed; its intent remains, and it was not retried" });
    }
  }
  checkpointRecord(id: string): EnvironmentCheckpoint | null {
    const row = this.operation(id); return row?.kind === "checkpoint" && row.receipt_json ? JSON.parse(row.receipt_json) : null;
  }
  verifyCheckpoint(checkpoint: EnvironmentCheckpoint): void {
    if ((checkpoint.artifacts?.length ?? 0) > 128 || (checkpoint.artifacts ?? []).reduce((sum, file) => sum + file.bytes, 0) > 32 * 1024 * 1024)
      refuse("environment_checkpoint_invalid", "Retained artifacts exceed 128 files or 32 MiB");
    for (const artifact of checkpoint.artifacts ?? []) {
      relativeGuestPath(artifact.path);
      if (!artifact.path.startsWith("work/artifacts/")) refuse("environment_checkpoint_invalid", "A retained artifact must stay beneath the work artifact root");
      const data = regularBytes(artifact.source);
      if (data.length !== artifact.bytes || sha256(data) !== artifact.sha256) refuse("environment_checkpoint_changed", "A retained required artifact changed before restore");
    }
    if (checkpoint.nativeType !== "community:openshell-claude" || !Array.isArray(checkpoint.files) || checkpoint.files.length < 1 || checkpoint.files.length > 128) refuse("environment_checkpoint_invalid", "A complete native checkpoint is required");
    let bytes = 0;
    for (const file of checkpoint.files) {
      const path = relativeGuestPath(file.path);
      if (!path.startsWith("native/projects/") || !path.endsWith(`/${checkpoint.nativeId}.jsonl`)) refuse("environment_checkpoint_invalid", "The checkpoint does not select this exact native history");
      const data = regularBytes(file.source, 1024 * 1024); bytes += data.length;
      if (data.length !== file.bytes || sha256(data) !== file.sha256 || bytes > 1024 * 1024) refuse("environment_checkpoint_changed", "Retained native bytes changed or are missing; no fresh conversation was started");
      const lines = data.toString("utf8").trimEnd().split("\n");
      if (!lines.length || !lines.some(line => { try { const row = JSON.parse(line); return row.sessionId === checkpoint.nativeId && ["user", "assistant"].includes(row.type); } catch { return false; } })) refuse("environment_checkpoint_identity_mismatch", "The retained native history does not identify the selected conversation");
      for (const line of lines) { let row: Record<string, unknown>; try { row = JSON.parse(line); } catch { refuse("environment_checkpoint_invalid", "History must end at a complete JSONL record"); }
        if (row.sessionId !== undefined && row.sessionId !== checkpoint.nativeId) refuse("environment_checkpoint_identity_mismatch", "Another conversation appeared in the selected history"); }
    }
  }
  async checkpoint(id: string, input: { operationId: string; generation: string }): Promise<EnvironmentCheckpoint> {
    const binding = this.selected(id, input.generation), native = this.native(binding);
    const op = this.intent(binding, input.operationId, "checkpoint", { ...input, resourceId: binding.resource!.id, nativeId: native.nativeId });
    if (op.receipt_json) { const saved = JSON.parse(op.receipt_json); this.verifyCheckpoint(saved); return saved; }
    if (!this.driver.checkpointFiles || !this.driver.nativeIdentity) refuse("environment_checkpoint_unsupported", "This driver cannot retain exact native history", 501);
    await this.platform.current(id, true);
    const observed = await this.driver.nativeIdentity(binding);
    if (observed.nativeId !== native.nativeId || observed.generation !== input.generation) refuse("environment_native_changed", "The checkpoint source native identity changed");
    const selectionId = `selection-${sha256(input.operationId).slice(0, 48)}`;
    let selection = this.operation(selectionId)?.receipt_json;
    if (!selection) {
      const files = await this.driver.checkpointFiles(binding, observed);
      if (files.length !== 1) refuse("environment_checkpoint_invalid", "One exact native history file is required");
      const exports = this.platform.db.prepare("SELECT receipt_json FROM environment_operations WHERE binding_id=? AND kind='export' AND state='confirmed' AND json_extract(receipt_json,'$.generation')=? LIMIT 129").all(id, input.generation) as Array<{ receipt_json: string }>;
      if (exports.length > 128) refuse("environment_checkpoint_invalid", "Retained artifacts exceed 128 files");
      const artifacts: EnvironmentCheckpoint["artifacts"] = [];
      for (const row of exports) {
        const receipt = JSON.parse(row.receipt_json);
        if (receipt.generation !== input.generation) continue;
        const path = posix.relative(binding.guestRoot, receipt.guestPath), data = regularBytes(receipt.path);
        if (!path.startsWith("work/artifacts/") || data.length !== receipt.bytes || sha256(data) !== receipt.sha256) refuse("environment_checkpoint_changed", "A required verified export changed before checkpoint");
        artifacts.push({ path, source: receipt.path, sha256: receipt.sha256, bytes: receipt.bytes, taskId: receipt.taskId });
      }
      selection = this.platform.db.transaction(() => {
        const op = this.intent(binding, selectionId, "checkpoint-selection", { checkpointId: input.operationId, generation: input.generation, resourceId: binding.resource!.id, nativeId: native.nativeId });
        if (op.receipt_json) return op.receipt_json;
        const selected = { files, artifacts }; this.save(selectionId, selected); return JSON.stringify(selected);
      })();
    }
    const selected = JSON.parse(selection) as { files: Array<{ path: string; sha256: string; bytes: number }>; artifacts: EnvironmentCheckpoint["artifacts"] };
    const directory = join(resolve(this.stateRoot), id, input.operationId); privateDirectory(directory);
    const stage = mkdtempSync(join(directory, ".capture-"));
    try {
      const files: EnvironmentCheckpoint["files"] = [];
      for (const [index, file] of selected.files.entries()) {
        relativeGuestPath(file.path);
        if (!file.path.startsWith("native/projects/") || !file.path.endsWith(`/${native.nativeId}.jsonl`) || file.bytes < 1 || file.bytes > 1024 * 1024 || !/^[0-9a-f]{64}$/.test(file.sha256)) refuse("environment_checkpoint_invalid", "The selected native history contract is invalid");
        // Driver read is a bounded regular-file byte operation, never a vendor archive extraction.
        const data = (await this.driver.read(binding, posix.join(binding.guestRoot, file.path))).subarray(0, file.bytes);
        if (data.length !== file.bytes || sha256(data) !== file.sha256) refuse("environment_checkpoint_changed", "History changed during capture; retain the original operation and capture a stable complete prefix");
        const source = join(directory, `history-${index}.jsonl`), temp = join(stage, `history-${index}`);
        writeFileSync(temp, data, { mode: 0o600 }); syncFile(temp);
        try { linkSync(temp, source); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        files.push({ ...file, source });
      }
      const checkpoint: EnvironmentCheckpoint = { version: 1, checkpointId: input.operationId, bindingId: id, nodeId: binding.nodeId!, seat: binding.seat,
        generation: input.generation, nativeType: native.nativeType, nativeId: native.nativeId, predecessorResourceId: binding.resource!.id,
        destinationCwd: posix.join(binding.guestRoot, "work"), nativeState: posix.join(binding.guestRoot, "native"), artifacts: selected.artifacts, files };
      this.verifyCheckpoint(checkpoint); this.selected(id, input.generation); syncFile(directory); this.save(input.operationId, checkpoint); return checkpoint;
    } finally { rmSync(stage, { recursive: true }); }
  }
  async recreate(id: string, input: { operationId: string; generation: string; checkpointId: string; resumeType: string; resumeToken: string; placement: Placement }): Promise<Record<string, unknown>> {
    identifier(input.generation, "generation"); const binding = this.platform.get(id);
    if (!binding?.resource || binding.ownership !== "owned") refuse("environment_attached_preserved", "Only a creator may explicitly recreate its compute; attached state is preserved");
    const cp = this.checkpointRecord(input.checkpointId);
    if (!cp || cp.bindingId !== id || cp.nodeId !== binding.nodeId || cp.seat !== binding.seat || input.resumeType !== cp.nativeType || input.resumeToken !== cp.nativeId) refuse("environment_checkpoint_missing", "Select this binding's exact retained checkpoint and native type/id; no fresh fallback exists");
    this.verifyCheckpoint(cp);
    if (input.generation !== cp.generation) refuse("environment_generation_changed", "Recreation must select the predecessor checkpoint generation");
    if (!input.placement || input.placement.gateway !== binding.placement.gateway || input.placement.workspace !== binding.placement.workspace
      || input.placement.image !== binding.placement.image || typeof input.placement.provider !== "string" || !input.placement.provider || /[\s\0]/.test(input.placement.provider) || !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(input.placement.name)) refuse("environment_recreate_changed", "Recreation must use the same qualified host/workspace/image and an explicit provider reference and a selected name");
    const policy = regularBytes(input.placement.policy);
    const request = { ...input, placement: { ...input.placement, policySha256: sha256(policy) }, predecessorResourceId: cp.predecessorResourceId };
    const op = this.intent(binding, input.operationId, "recreate", request);
    if (op.receipt_json) return JSON.parse(op.receipt_json);
    const listing = await this.driver.list(binding.placement);
    if (!listing.complete) refuse("environment_listing_incomplete", "A complete provider listing is required before successor compute");
    if (listing.resources.some(row => row.id === cp.predecessorResourceId)) refuse("environment_predecessor_present", "Stop and delete the predecessor explicitly before creating successor compute");
    if (!this.driver.cleanupState || Object.values(await this.driver.cleanupState({ ...binding, resource: { ...binding.resource, id: cp.predecessorResourceId } }, (() => { const saved = this.operation(`inventory-${cp.predecessorResourceId}`)?.receipt_json; return saved ? JSON.parse(saved) : undefined; })())).some(value => value !== false)) refuse("environment_cleanup_unconfirmed", "Predecessor workload/supervisor/volume absence is unconfirmed");
    const matches = listing.resources.filter(row => row.operationId === op.effect_id);
    if (matches.length > 1) refuse("environment_duplicate_resources", "Multiple successor resources match this operation");
    let resource = matches[0];
    if (!resource) {
      if (listing.resources.some(row => row.name === input.placement.name)) refuse("environment_name_in_use", "The successor name is already in use");
      if (!this.claim(input.operationId)) return { state: "unconfirmed", operationId: input.operationId, checkpointId: cp.checkpointId };
      try { resource = await this.driver.create({ operationId: op.effect_id!, placement: request.placement }); }
      catch { return { state: "unconfirmed", operationId: input.operationId, checkpointId: cp.checkpointId }; }
    }
    if (!resource.id || resource.id === cp.predecessorResourceId || resource.name !== input.placement.name || resource.workspace !== binding.placement.workspace || resource.operationId !== op.effect_id) refuse("environment_identity_changed", "The successor resource does not match the frozen recreation");
    if (this.driver.captureCleanup) {
      const predecessor = this.operation(`inventory-${cp.predecessorResourceId}`)?.receipt_json;
      if (!predecessor) refuse("environment_cleanup_unconfirmed", "The predecessor's actual provider host is not retained");
      const previous = JSON.parse(predecessor) as PodmanCleanupSelection;
      const captured = await this.driver.captureCleanup({ ...binding, resource, placement: request.placement }, previous.socket);
      if (captured.host !== previous.host || captured.uid !== previous.uid || captured.socketDevice !== previous.socketDevice || captured.socketInode !== previous.socketInode)
        refuse("environment_restore_host_changed", "The successor is not on the selected predecessor host/engine");
      const inventoryId = `inventory-${resource.id}`;
      this.intent(binding, inventoryId, "cleanup-inventory", { resourceId: resource.id, engineSocket: previous.socket }); this.save(inventoryId, captured);
    }
    const receipt = { version: 1, state: "confirmed", operationId: input.operationId, bindingId: id, checkpointId: cp.checkpointId,
      nativeType: cp.nativeType, nativeId: cp.nativeId, predecessorResourceId: cp.predecessorResourceId, successorResourceId: resource.id, predecessorGeneration: input.generation, successorGeneration: null,
      destinationCwd: cp.destinationCwd, nativeState: cp.nativeState };
    this.platform.db.transaction(() => {
      const current = this.platform.get(id)!;
      if (current.resource!.id !== cp.predecessorResourceId) refuse("environment_selection_changed", "The compute binding changed during recreation");
      this.platform.db.prepare("UPDATE environment_bindings SET resource_json=?,config_json=?,projection_json=NULL,generation=NULL WHERE binding_id=?")
        .run(JSON.stringify(resource), JSON.stringify({ ...current, placement: request.placement, resource: undefined, ownership: undefined, generation: undefined }), id);
      this.save(input.operationId, receipt);
    })();
    return receipt;
  }
  selectCompletion(id: string, input: { operationId: string; generation: string; taskId: string; exportOperationId: string; effect: "stop-native" | "stop-compute"; requestedBy?: string }): Record<string, unknown> {
    const binding = this.selected(id, input.generation);
    identifier(input.taskId, "taskId"); identifier(input.exportOperationId, "exportOperationId");
    if (binding.ownership !== "owned" || !["stop-native", "stop-compute"].includes(input.effect)) refuse("environment_completion_invalid", "Finite completion needs one owned execution and a selected native or compute stop");
    const task = this.queue?.getById(input.taskId);
    if (!task || task.destinationSession !== binding.seat) refuse("environment_task_changed", "Finite completion selects work owned by this exact seat");
    const op = this.intent(binding, input.operationId, "completion", { ...input, resourceId: binding.resource!.id });
    return { ...input, state: op.state === "confirmed" ? "confirmed" : "pending", ...(op.receipt_json ? { lastAttempt: JSON.parse(op.receipt_json) } : {}) };
  }
  private completionEligible(id: string, input: { taskId: string; generation: string; resourceId: string; exportOperationId: string }): boolean {
    const task = this.queue?.getById(input.taskId), binding = this.platform.get(id);
    if (!task || task.state !== "done" || task.closureReason !== "no-follow-on" || task.destinationSession !== binding?.seat || binding.generation !== input.generation || binding.resource?.id !== input.resourceId) return false;
    const exported = this.operation(input.exportOperationId);
    if (!exported || exported.binding_id !== id || exported.kind !== "export" || exported.state !== "confirmed" || !exported.receipt_json) return false;
    try {
      const receipt = JSON.parse(exported.receipt_json);
      if (receipt.bindingId !== id || receipt.generation !== input.generation || receipt.taskId !== input.taskId) return false;
      const bytes = regularBytes(receipt.path);
      return bytes.length === receipt.bytes && sha256(bytes) === receipt.sha256;
    } catch { return false; }
  }
  async checkCompletions(): Promise<void> {
    const rows = this.platform.db.prepare("SELECT operation_id, binding_id, request_json, receipt_json FROM environment_operations WHERE kind='completion' AND state IN ('intent','requested')").all() as Array<{ operation_id: string; binding_id: string; request_json: string; receipt_json: string | null }>;
    for (const row of rows) {
      const input = JSON.parse(row.request_json), now = Date.now(), previous = row.receipt_json ? JSON.parse(row.receipt_json) : undefined;
      // Queue traffic is not a provider polling loop. A manual/boot/event check observes at most once per minute.
      if (previous?.lastAttemptAt !== undefined && now - previous.lastAttemptAt < 60_000) continue;
      if (!this.completionEligible(row.binding_id, input)) continue;
      const attempt = { state: "pending", lastAttemptAt: now, taskId: input.taskId, exportOperationId: input.exportOperationId, detail: "Checking the selected stop" };
      const claimed = this.platform.db.prepare("UPDATE environment_operations SET state='requested',receipt_json=? WHERE operation_id=? AND state IN ('intent','requested') AND receipt_json IS ?")
        .run(JSON.stringify(attempt), row.operation_id, row.receipt_json);
      if (!claimed.changes) continue;
      try {
        const effect = await this.effect(row.binding_id, { operationId: `completion-stop-${sha256(row.operation_id).slice(0, 48)}`, generation: input.generation, effect: input.effect, requestedBy: input.requestedBy },
          () => this.completionEligible(row.binding_id, input));
        const receipt = { ...effect, lastAttemptAt: now, taskId: input.taskId, exportOperationId: input.exportOperationId };
        if (effect.state === "confirmed") this.save(row.operation_id, receipt);
        else this.platform.db.prepare("UPDATE environment_operations SET receipt_json=? WHERE operation_id=? AND state='requested'").run(JSON.stringify(receipt), row.operation_id);
      } catch (error) {
        this.platform.db.prepare("UPDATE environment_operations SET receipt_json=? WHERE operation_id=? AND state='requested'")
          .run(JSON.stringify({ ...attempt, state: "unconfirmed", detail: "Selected completion remains unconfirmed; no unrelated work was selected", ...(error instanceof EnvironmentError ? { code: error.code } : {}) }), row.operation_id);
      }
    }
  }
}
