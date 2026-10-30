import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectionPlan } from "./projection-planner.js";
import type { NodeBinding, ProjectionResult, ResolvedStartupFile, StartupDeliveryResult, HarnessLaunchResult } from "./runtime-adapter.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { EnvironmentPlatform, EnvironmentError, regularBytes, sha256, type ProjectionFile, type ProjectionReceipt } from "./environment-platform.js";
import { OpenShellDriver } from "../adapters/openshell-driver.js";

export type EnvironmentActivity = (input: { nodeId: string; generation: string; seat: string; guestBaseUrl: string }) =>
  Promise<{ grantId: string; env: Record<string, string> }>;

/** One maintained consumer of RuntimeAdapter's optional environment operations; no host fallback when selected. */
export class EnvironmentStartup {
  constructor(readonly platform: EnvironmentPlatform, private readonly stageRoot: string, private readonly activity: EnvironmentActivity, private readonly checkActivityEndpoint?: (origin: string) => void) {}
  private selected(binding: NodeBinding) {
    const selected = this.platform.forNode(binding.nodeId, binding.tmuxSession ?? undefined);
    if (!selected || !selected.resource) throw new EnvironmentError("environment_binding_missing", "Select create or attach for this seat before starting its contained runtime");
    if (selected.nodeId && selected.nodeId !== binding.nodeId || selected.seat !== binding.tmuxSession)
      throw new EnvironmentError("environment_seat_changed", "The selected environment belongs to a different stable seat");
    if (!binding.launchGeneration) throw new EnvironmentError("environment_generation_missing", "An environment launch requires a reserved occupant generation");
    return { ...selected, nodeId: binding.nodeId };
  }
  async preflight(binding: NodeBinding, opts: { resumeToken?: string; forkSource?: unknown } = {}): Promise<void> {
    if (opts.resumeToken || opts.forkSource) throw new EnvironmentError("environment_restore_unsupported", "Native restore/fork is unsupported in v1; no guest input was replaced");
    this.preparation(binding);
  }
  private preparation(binding: NodeBinding) {
    const selected = this.selected(binding);
    // Check all saved launch states before claiming the binding or changing any guest input.
    const prior = this.platform.db.prepare("SELECT operation_id FROM environment_operations WHERE binding_id = ? AND kind = 'launch'").get(selected.bindingId);
    if (prior) throw new EnvironmentError("environment_prior_execution_unconfirmed", "A saved native execution must be reconciled before projection; its generation and files were preserved");
    this.checkActivityEndpoint?.(selected.guestBaseUrl);
    const saved = this.platform.get(selected.bindingId)!;
    if (!saved.nodeId) {
      const claimed = this.platform.db.prepare("UPDATE environment_bindings SET node_id = ? WHERE binding_id = ? AND node_id IS NULL").run(binding.nodeId, selected.bindingId);
      if (!claimed.changes) throw new EnvironmentError("environment_selection_changed", "The stable seat reservation changed before projection");
    }
    return selected;
  }
  private stage() { mkdirSync(this.stageRoot, { recursive: true, mode: 0o700 }); return mkdtempSync(join(this.stageRoot, "projection-")); }
  private walk(source: string, destination: string, required: boolean, out: ProjectionFile[]): void {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw new EnvironmentError("environment_projection_symlink", "A declared projection contains a symlink; select its regular destination explicitly");
    if (stat.isDirectory()) {
      for (const name of readdirSync(source).sort()) this.walk(join(source, name), posix.join(destination, name), required, out);
    } else {
      const bytes = regularBytes(source);
      out.push({ source, path: destination, sha256: sha256(bytes), required });
    }
  }
  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const selected = this.preparation(binding), files: ProjectionFile[] = [];
    const stage = this.stage();
    try {
      const guidance: string[] = [];
      for (const entry of plan.entries) {
        if (entry.classification === "operator_conflict" || entry.classification === "hash_conflict")
          throw new EnvironmentError("environment_projection_conflict", `Resolve the selected projection conflict for ${entry.effectiveId}`);
        const key = encodeURIComponent(entry.effectiveId);
        const destination = entry.category === "skill" ? `work/.claude/skills/${key}`
          : entry.category === "plugin" ? `work/.claude/plugins/${key}` : `work/.openrig/context/${key}`;
        this.walk(realpathSync(entry.absolutePath), destination, true, files);
        if (entry.category === "guidance") guidance.push(`Read ${posix.join(selected.guestRoot, destination)}.`);
        if (entry.category === "runtime_resource" || entry.category === "subagent")
          throw new EnvironmentError("environment_projection_unsupported", `The OpenShell Claude path does not yet map ${entry.category}; no cold launch was attempted`);
      }
      guidance.unshift("This execution is in OpenShell. Use the authenticated OpenRig MCP tools for team identity and queue work. Host-only CLI paths and endpoints are not guest paths.");
      {
        const local = join(stage, "CLAUDE.md"); writeFileSync(local, guidance.join("\n") + "\n", { mode: 0o600 });
        files.push({ source: local, path: "work/CLAUDE.md", sha256: sha256(regularBytes(local)), required: true, transient: true });
      }
      await this.platform.project(selected.bindingId, { operationId: `projection-${binding.launchGeneration}`, generation: binding.launchGeneration!, files });
      return { projected: plan.entries.map(e => e.effectiveId), skipped: [], failed: [] };
    } finally { rmSync(stage, { recursive: true }); }
  }
  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const selected = this.preparation(binding), stage = this.stage();
    try {
      const row = this.platform.db.prepare("SELECT projection_json FROM environment_bindings WHERE binding_id = ?").get(selected.bindingId) as { projection_json: string | null };
      const previous = row.projection_json ? JSON.parse(row.projection_json) : { files: [] };
      const staged: ProjectionFile[] = [];
      // Every applicable resolved input, including send_text inputs, is checked at the destination before native launch.
      for (const file of files) {
        const source = realpathSync(file.absolutePath), original = regularBytes(source);
        const text = original.toString("utf8").split(binding.cwd).join(posix.join(selected.guestRoot, "work"));
        const path = `work/.openrig/startup/${encodeURIComponent(file.path)}`;
        const local = join(stage, `startup-${staged.length}`); writeFileSync(local, text, { mode: 0o600 });
        staged.push({ source: local, path, sha256: sha256(text), required: file.required, sourceIdentity: { path: source, sha256: sha256(original) } });
      }
      const destinations = new Set<string>([...previous.files.filter((file: ProjectionReceipt) => file.path.startsWith("work/.openrig/")).map((file: ProjectionReceipt) => file.path), ...staged.map(file => file.path)]);
      const guidance = "This execution is in OpenShell. Use the authenticated OpenRig MCP tools for team identity and queue work. Host-only CLI paths and endpoints are not guest paths.\n"
        + [...destinations].sort().map(path => `Read ${posix.join(selected.guestRoot, path)}.`).join("\n") + "\n";
      const index = join(stage, "CLAUDE.md"); writeFileSync(index, guidance, { mode: 0o600 });
      staged.push({ source: index, path: "work/CLAUDE.md", sha256: sha256(guidance), required: true, transient: true });
      await this.platform.project(selected.bindingId, { operationId: `startup-${binding.launchGeneration}`, generation: binding.launchGeneration!, files: staged });
      return { delivered: files.length, failed: [] };
    } finally { rmSync(stage, { recursive: true }); }
  }
  async launch(binding: NodeBinding, opts: { resumeToken?: string; forkSource?: unknown; beforeNativeDispatch?: () => boolean }, tmux: Pick<TmuxAdapter, "sendShellCommand">): Promise<HarnessLaunchResult> {
    if (opts.resumeToken || opts.forkSource) return { ok: false, recovery: "attention_required", error: "Environment native restore/fork is not implemented by driver version 1; no fresh conversation was started." };
    const selected = this.selected(binding), generation = binding.launchGeneration!;
    const operationId = `launch-${generation}`;
    const prior = this.platform.db.prepare("SELECT binding_id, kind, state, request_json, receipt_json FROM environment_operations WHERE operation_id = ?").get(operationId) as { binding_id: string; kind: string; state: string; request_json: string; receipt_json: string | null } | undefined;
    if (prior) {
      const request = JSON.parse(prior.request_json);
      if (prior.binding_id !== selected.bindingId || prior.kind !== "launch" || request.nodeId !== binding.nodeId || request.generation !== generation || request.resourceId !== selected.resource!.id)
        throw new EnvironmentError("environment_operation_changed", "The saved native launch belongs to a different binding");
      // Reconcile the original execution before issuing grants or changing any guest inputs.
      // Intent is conservative too: a crash may have happened after any awaited write.
      if (!(this.platform.driver instanceof OpenShellDriver)) throw new EnvironmentError("environment_native_unconfirmed", "The saved execution needs live identity reconciliation");
      const observed = await this.platform.driver.guest(selected, ["--identity"]);
      if (observed.nativeId !== request.nativeId || observed.generation !== generation)
        throw new EnvironmentError("environment_native_unconfirmed", "The original native identity is unconfirmed; no grant or execution was replaced");
      const receipt = { ...request, nativeType: "community:openshell-claude", destinationCwd: posix.join(selected.guestRoot, "work"), nativeState: posix.join(selected.guestRoot, "native"), checkpoint: null };
      this.platform.db.prepare("UPDATE environment_operations SET state = 'confirmed', receipt_json = ? WHERE operation_id = ?").run(JSON.stringify(receipt), operationId);
      return { ok: true, resumeToken: request.nativeId, resumeType: "community:openshell-claude", resumeProvenance: "launcher", warnings: ["The original native identity was reconciled; viewer readiness still requires its existing observation and no viewer input was replayed."] };
    }
    const older = this.platform.db.prepare("SELECT operation_id FROM environment_operations WHERE binding_id = ? AND kind = 'launch' AND operation_id <> ? AND state IN ('requested','confirmed')").get(selected.bindingId, operationId);
    if (older) throw new EnvironmentError("environment_prior_execution_unconfirmed", "A prior native execution must be reconciled through lifecycle/restore before another launch");
    await this.platform.validate(selected.bindingId, generation);
    if (!selected.coordinationRef) throw new EnvironmentError("environment_coordination_missing", "Configure this binding's scoped MCP work connection before native launch");
    const connection = JSON.parse(regularBytes(selected.coordinationRef).toString("utf8")) as { version?: number; mcpUrl?: string; seat?: string; token?: string };
    if (connection.version !== 1 || connection.seat !== selected.seat || typeof connection.token !== "string" || !connection.token || typeof connection.mcpUrl !== "string")
      throw new EnvironmentError("environment_coordination_invalid", "The managed work connection does not belong to this bound seat");
    const coordination = Buffer.from(JSON.stringify({ mcpServers: { openrig: { type: "http", url: connection.mcpUrl, headers: { Authorization: `Bearer ${connection.token}` } } } }));
    const row = this.platform.db.prepare("SELECT projection_json FROM environment_bindings WHERE binding_id = ?").get(selected.bindingId) as { projection_json: string };
    const files = JSON.parse(row.projection_json).files as ProjectionReceipt[];
    const nativeId = randomUUID();
    const request = { version: 1, bindingId: selected.bindingId, nodeId: binding.nodeId, generation, resourceId: selected.resource!.id, nativeId };
    this.platform.db.prepare("INSERT OR IGNORE INTO environment_operations(operation_id,binding_id,kind,request_json,state) VALUES (?,?,'launch',?,'intent')")
      .run(operationId, selected.bindingId, JSON.stringify(request));
    const stage = this.stage();
    try {
      const activity = await this.activity({ nodeId: binding.nodeId, generation, seat: selected.seat, guestBaseUrl: selected.guestBaseUrl });
      const putPrivate = async (name: string, data: string) => {
        const local = join(stage, name); writeFileSync(local, data, { mode: 0o600 });
        const destination = posix.join(selected.guestRoot, "control", name);
        let previous: string | undefined;
        try { previous = sha256(await this.platform.driver.read(selected, destination)); }
        catch (error) { if (!(error instanceof EnvironmentError && error.code === "environment_file_missing")) throw error; }
        await this.platform.driver.upload(selected, local, destination, previous);
      };
      this.platform.db.prepare("UPDATE environment_operations SET request_json = ? WHERE operation_id = ? AND state = 'intent'").run(JSON.stringify({ ...request, activityGrantId: activity.grantId }), operationId);
      await putPrivate("activity.json", JSON.stringify(activity.env));
      await putPrivate("coordination.json", coordination.toString("utf8"));
      const descriptor = { ...request, files, model: binding.model, effort: binding.effort, permissionMode: binding.permissionMode,
        plugins: files.filter(file => file.path.includes("/.claude/plugins/") && file.path.endsWith("/.claude-plugin/plugin.json"))
          .map(file => posix.join(selected.guestRoot, file.path.slice(0, -"/.claude-plugin/plugin.json".length))) };
      await putPrivate("launch.pending.json", JSON.stringify(descriptor));
      await this.platform.validate(selected.bindingId, generation);
      if (opts.beforeNativeDispatch && !opts.beforeNativeDispatch()) throw new EnvironmentError("environment_selection_changed", "The selected launch changed before native dispatch");
      if (!(this.platform.driver instanceof OpenShellDriver)) throw new EnvironmentError("environment_launch_unsupported", "This driver does not implement native launch preparation");
      const claimed = this.platform.db.prepare("UPDATE environment_operations SET state = 'requested' WHERE operation_id = ? AND state = 'intent'").run(operationId);
      if (!claimed.changes) throw new EnvironmentError("environment_native_unconfirmed", "The saved native launch intent needs reconciliation; no second launch was attempted");
      await this.platform.driver.guest(selected, ["--prepare"]);
      const command = ["rig", "environment", "connect", selected.bindingId, "--generation", generation].map(shellQuote).join(" ");
      const sent = await tmux.sendShellCommand(binding.tmuxSession!, command, undefined, { stageIfLong: true, execInScript: true });
      if (!sent.ok) throw new EnvironmentError("environment_viewer_unconfirmed", "The native execution may have started; its viewer dispatch is unconfirmed");
      let observed: Record<string, any> | undefined;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try { observed = await this.platform.driver.guest(selected, ["--identity"]); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      if (observed?.nativeId !== nativeId || observed.generation !== generation) throw new EnvironmentError("environment_native_unconfirmed", "The native process identity is not confirmed; nothing was restarted");
      const receipt = { ...request, activityGrantId: activity.grantId, nativeType: "community:openshell-claude", destinationCwd: posix.join(selected.guestRoot, "work"), nativeState: posix.join(selected.guestRoot, "native"), checkpoint: null };
      this.platform.db.prepare("UPDATE environment_operations SET state = 'confirmed', receipt_json = ? WHERE operation_id = ?").run(JSON.stringify(receipt), operationId);
      return { ok: true, resumeToken: nativeId, resumeType: "community:openshell-claude", resumeProvenance: "launcher" };
    } finally { rmSync(stage, { recursive: true }); }
  }
}
