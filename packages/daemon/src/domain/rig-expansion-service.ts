import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { PodRigInstantiator } from "./rigspec-instantiator.js";
import type { SessionRegistry } from "./session-registry.js";
import type { ExpansionRequest, ExpansionResult, ExpansionNodeOutcome } from "./types.js";
import { stringify as stringifyYaml } from "yaml";

interface RigExpansionServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  podInstantiator: PodRigInstantiator;
  sessionRegistry: SessionRegistry;
}

/**
 * Orchestrates live rig expansion by composing PodRigInstantiator.materialize()
 * for topology persistence and NodeLauncher for launching new nodes.
 */
export class RigExpansionService {
  private deps: RigExpansionServiceDeps;

  constructor(deps: RigExpansionServiceDeps) {
    this.deps = deps;
  }

  async expand(request: ExpansionRequest): Promise<ExpansionResult> {
    // 1. Validate rig exists
    const rig = this.deps.rigRepo.getRig(request.rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: `Rig "${request.rigId}" not found` };
    }

    // 2. Build synthetic rig spec YAML for the new pod
    const pod = request.pod;
    const syntheticSpec = this.buildSyntheticSpec(rig.rig.name, pod, request.crossPodEdges);

    // 3. Materialize topology (suppress rig.imported event)
    const materializeResult = await this.deps.podInstantiator.materialize(
      syntheticSpec,
      request.rigRoot ?? ".",
      { targetRigId: request.rigId, suppressSummaryEvent: true },
    );

    if (!materializeResult.ok) {
      const code = materializeResult.code;
      const message = "message" in materializeResult
        ? materializeResult.message
        : "errors" in materializeResult
          ? materializeResult.errors.join("; ")
          : "materialization failed";
      return { ok: false, code, error: message };
    }

    // 4. Find the newly created pod and nodes
    const updatedRig = this.deps.rigRepo.getRig(request.rigId)!;
    const newNodes = materializeResult.result.nodes;
    const newPod = updatedRig.nodes
      .filter((n) => newNodes.some((nn) => nn.logicalId === n.logicalId))
      .map((n) => n.podId)
      .find((id) => id !== null);

    const podId = newPod ?? "";
    const podNamespace = pod.id;

    // 5. Launch and fully start the newly created nodes via the pod-aware seam
    const launchOutcome = await this.deps.podInstantiator.launchMaterialized(
      syntheticSpec,
      request.rigRoot ?? ".",
      request.rigId,
    );
    if (!launchOutcome.ok) {
      const message = "message" in launchOutcome
        ? launchOutcome.message
        : "errors" in launchOutcome
          ? launchOutcome.errors.join("; ")
          : "launch failed";
      return { ok: false, code: launchOutcome.code, error: message };
    }

    const nodeOutcomes: ExpansionNodeOutcome[] = launchOutcome.result.nodes.map((node) => ({
      logicalId: node.logicalId,
      nodeId: node.nodeId,
      status: node.status,
      error: node.error,
      sessionName: node.sessionName,
    }));
    const warnings = launchOutcome.result.warnings ?? [];
    const retryTargets = nodeOutcomes
      .filter((node) => node.status === "failed")
      .map((node) => node.logicalId);

    // 6. Determine overall status
    const launched = nodeOutcomes.filter((n) => n.status === "launched").length;
    const failed = nodeOutcomes.filter((n) => n.status === "failed").length;
    const status: "ok" | "partial" | "failed" = failed === 0 ? "ok" : launched > 0 ? "partial" : "failed";

    // 7. Emit rig.expanded event
    this.deps.eventBus.emit({
      type: "rig.expanded",
      rigId: request.rigId,
      podId,
      podNamespace,
      nodes: nodeOutcomes,
      status,
    });

    return {
      ok: true,
      status,
      podId,
      podNamespace,
      nodes: nodeOutcomes,
      warnings,
      retryTargets,
    };
  }

  private buildSyntheticSpec(
    rigName: string,
    pod: ExpansionRequest["pod"],
    crossPodEdges?: ExpansionRequest["crossPodEdges"],
  ): string {
    const syntheticSpec: Record<string, unknown> = {
      version: "0.2",
      name: rigName,
      pods: [
        {
          id: pod.id,
          label: pod.label,
          ...(pod.summary ? { summary: pod.summary } : {}),
          members: pod.members.map((member) => ({
            id: member.id,
            runtime: member.runtime,
            ...(member.agentRef ? { agent_ref: member.agentRef } : {}),
            ...(member.profile ? { profile: member.profile } : {}),
            ...(member.codexConfigProfile ? { codex_config_profile: member.codexConfigProfile } : {}),
            ...(member.cwd ? { cwd: member.cwd } : {}),
            ...(member.model ? { model: member.model } : {}),
            ...(member.restorePolicy ? { restore_policy: member.restorePolicy } : {}),
            ...(member.label ? { label: member.label } : {}),
            ...(member.sessionSource ? {
              session_source: {
                mode: member.sessionSource.mode,
                ref: {
                  kind: member.sessionSource.ref.kind,
                  ...(member.sessionSource.ref.value !== undefined ? { value: member.sessionSource.ref.value } : {}),
                },
              },
            } : {}),
          })),
          edges: pod.edges.map((edge) => ({
            kind: edge.kind,
            from: edge.from,
            to: edge.to,
          })),
        },
      ],
      edges: (crossPodEdges ?? []).map((edge) => ({
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
      })),
    };

    return stringifyYaml(syntheticSpec, {
      lineWidth: 0,
    });
  }
}
