import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenShellPodmanObserver, type PodmanCleanupSelection } from "./openshell-podman-observer.js";
import type { NativeObservation } from "../domain/environment-lifecycle.js";
import { EnvironmentError, regularBytes, sha256, type EnvironmentBinding, type EnvironmentDriver, type EnvironmentResource, type Placement } from "../domain/environment-platform.js";

const runFile = promisify(execFile);
export type OpenShellCommand = (args: string[]) => Promise<string>;
/** Maintained OpenShell 0.1.6 CLI driver. No shell, dynamic plugin loader or credential copying. */
export class OpenShellDriver implements EnvironmentDriver {
  readonly version = 1 as const;
  constructor(private readonly command: OpenShellCommand = async args => {
    try { return (await runFile("openshell", args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
    catch { throw new EnvironmentError("openshell_transport_unconfirmed", "OpenShell did not return a confirmed result; reconcile the saved operation", 503); }
  }) {}
  private prefix(place: Placement): string[] { return ["--gateway", place.gateway, "--workspace", place.workspace, "sandbox"]; }
  private resource(value: unknown): EnvironmentResource {
    const row = value as Record<string, any>;
    if (!row || typeof row.id !== "string" || !row.id || typeof row.name !== "string" || typeof row.workspace !== "string"
      || typeof row.phase !== "string") throw new EnvironmentError("openshell_response_invalid", "OpenShell returned an incomplete resource identity");
    return { id: row.id, name: row.name, workspace: row.workspace, phase: row.phase,
      ...(typeof row.host_key_fingerprint === "string" ? { fingerprint: row.host_key_fingerprint } : {}),
      ...(typeof row.labels?.openrigoperation === "string" ? { operationId: row.labels.openrigoperation } : {}) };
  }
  async list(place: Placement): Promise<{ complete: boolean; resources: EnvironmentResource[] }> {
    const page = JSON.parse(await this.command([...this.prefix(place), "list", "--output", "json", "--page-size", "100"]));
    if (!page || !Array.isArray(page.sandboxes) || page.sandboxes.length > 100 || typeof page.next_page_token !== "string")
      throw new EnvironmentError("openshell_listing_invalid", "OpenShell returned an invalid resource listing");
    return { complete: page.next_page_token === "", resources: page.sandboxes.map((row: unknown) => this.resource(row)) };
  }
  async create(input: { operationId: string; placement: Placement }): Promise<EnvironmentResource> {
    const p = input.placement, bytes = regularBytes(p.policy);
    if (sha256(bytes) !== p.policySha256) throw new EnvironmentError("environment_policy_changed", "The selected provider policy changed before create");
    const stage = mkdtempSync(join(tmpdir(), "openrig-policy-"));
    const policy = join(stage, "policy.yaml"); writeFileSync(policy, bytes, { mode: 0o600 });
    try { return this.resource(JSON.parse(await this.command([...this.prefix(p), "create", "--name", p.name, "--from", p.image,
      "--provider", p.provider, "--no-auto-providers", "--cpu", "1", "--memory", "2Gi", "--policy", policy,
      "--label", `openrigoperation=${input.operationId}`, "--tty", "--detach", "--restart-policy", "never", "--output", "json",
      "--", "python3", "/opt/openrig/guest.py"]))); } finally { rmSync(stage, { recursive: true }); }
  }
  async inspect(binding: EnvironmentBinding): Promise<EnvironmentResource> {
    return this.resource(JSON.parse(await this.command([...this.prefix(binding.placement), "get", binding.placement.name, "--output", "json"])));
  }
  private async checked(binding: EnvironmentBinding, ready = true): Promise<void> {
    const actual = await this.inspect(binding), saved = binding.resource;
    if (!saved || actual.id !== saved.id || actual.name !== saved.name || actual.workspace !== saved.workspace
      || saved.fingerprint && actual.fingerprint !== saved.fingerprint) throw new EnvironmentError("environment_identity_changed", "The live OpenShell resource does not match the saved binding");
    if (ready && actual.phase !== "Ready") throw new EnvironmentError("environment_not_ready", "The bound OpenShell resource is not Ready");
  }
  async guest(binding: EnvironmentBinding, args: string[], beforeDispatch?: () => boolean): Promise<Record<string, any>> {
    await this.checked(binding);
    if (beforeDispatch && !beforeDispatch()) throw new EnvironmentError("environment_selection_changed", "The selected stop is no longer eligible; no command was dispatched");
    const result = JSON.parse(await this.command([...this.prefix(binding.placement), "exec", binding.placement.name,
      "--no-login-shell", "--timeout", "20", "--", "python3", "/opt/openrig/guest.py", "--root", binding.guestRoot, ...args]));
    if (!result || result.ok !== true) throw new EnvironmentError(result?.code ?? "environment_guest_refused", "The guest operation was not confirmed");
    return result;
  }
  async upload(binding: EnvironmentBinding, source: string, destination: string, previousHash?: string, executable = false): Promise<void> {
    const transfer = randomUUID();
    const stage = posix.join(binding.guestRoot, "control", `transfer-${transfer}`);
    await this.guest(binding, ["--stage", stage]);
    await this.checked(binding);
    await this.command([...this.prefix(binding.placement), "upload", binding.placement.name, source, stage, "--no-git-ignore"]);
    await this.guest(binding, ["--install", stage, "--destination", destination, "--previous", previousHash ?? "missing", "--mode", executable ? "0700" : "0600"]);
  }
  async read(binding: EnvironmentBinding, path: string): Promise<Buffer> {
    const result = await this.guest(binding, ["--read", path]);
    if (typeof result.base64 !== "string" || result.base64.length > 4 * Math.ceil(1024 * 1024 / 3)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64) || result.base64.length % 4 !== 0)
      throw new EnvironmentError("environment_file_invalid", "A bounded single-file response is required");
    const bytes = Buffer.from(result.base64, "base64");
    if (bytes.length > 1024 * 1024) throw new EnvironmentError("environment_file_invalid", "The returned file exceeds the byte cap");
    return bytes;
  }
  async download(binding: EnvironmentBinding, source: string, destination: string): Promise<void> {
    const bytes = await this.read(binding, source);
    writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  async captureCleanup(binding: EnvironmentBinding, socket: string): Promise<PodmanCleanupSelection> {
    await this.checked(binding, false);
    return new OpenShellPodmanObserver().capture(binding, socket);
  }
  async cleanupState(binding: EnvironmentBinding, selection?: PodmanCleanupSelection) {
    return new OpenShellPodmanObserver().observe(binding, selection);
  }
  async nativeIdentity(binding: EnvironmentBinding): Promise<NativeObservation> {
    const observed = await this.guest(binding, ["--identity"]);
    if (typeof observed.running !== "boolean" || typeof observed.nativeId !== "string" || typeof observed.generation !== "string")
      throw new EnvironmentError("environment_native_unconfirmed", "The exact native execution is not observed");
    return observed as NativeObservation;
  }
  async stopNative(binding: EnvironmentBinding, native: NativeObservation, _operationId: string, beforeDispatch?: () => boolean): Promise<void> {
    await this.guest(binding, ["--stop-native", native.nativeId, "--generation", native.generation], beforeDispatch);
  }
  async checkpointFiles(binding: EnvironmentBinding, _native: NativeObservation): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
    const result = await this.guest(binding, ["--checkpoint-files"]);
    if (!Array.isArray(result.files) || result.files.length !== 1) throw new EnvironmentError("environment_checkpoint_invalid", "The guest did not return one exact history contract");
    return result.files;
  }
  async stopCompute(binding: EnvironmentBinding, _operationId: string, beforeDispatch?: () => boolean): Promise<void> {
    await this.checked(binding, false);
    if (beforeDispatch && !beforeDispatch()) throw new EnvironmentError("environment_selection_changed", "The selected stop is no longer eligible; no command was dispatched");
    await this.command([...this.prefix(binding.placement), "stop", binding.placement.name]);
  }
  async deleteEnvironment(binding: EnvironmentBinding, _operationId: string): Promise<void> {
    const actual = await this.inspect(binding);
    if (!binding.resource || actual.id !== binding.resource.id || actual.name !== binding.resource.name || actual.workspace !== binding.resource.workspace
      || binding.resource.fingerprint && actual.fingerprint !== binding.resource.fingerprint)
      throw new EnvironmentError("environment_identity_changed", "The selected compute changed before deletion");
    await this.command([...this.prefix(binding.placement), "delete", binding.placement.name]);
  }
  connectArgs(binding: EnvironmentBinding): string[] { return [...this.prefix(binding.placement), "connect", binding.placement.name]; }
}
