import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "./rigspec-schema.js";
import { parseAgentSpec, validateAgentSpec } from "./agent-manifest.js";
import type { ValidationResult } from "./types.js";

// -- Shared types --

export type SourceState = "draft" | "file_preview" | "library_item";

export interface SpecGraphData {
  nodes: Array<{ id: string; label: string; pod?: string; runtime: string; kind: "agent" | "infrastructure" }>;
  edges: Array<{ source: string; target: string; kind: string }>;
}

// -- RigSpec review --

export interface RigSpecServicesReview {
  kind: "compose";
  composeFile: string;
  projectName?: string;
  downPolicy?: string;
  waitFor: Array<{
    service?: string;
    url?: string;
    tcp?: string;
    condition?: "healthy";
  }>;
  surfaces?: {
    urls?: Array<{ name: string; url: string }>;
    commands?: Array<{ name: string; command: string }>;
  };
  composePreview?: {
    services: Array<{ name: string; image?: string }>;
  };
}

interface RigSpecReviewBase {
  sourceState: SourceState;
  kind: "rig";
  name: string;
  version: string;
  summary?: string;
  cultureFile?: string;
  services?: RigSpecServicesReview;
  graph: SpecGraphData;
  raw: string;
}

export interface PodAwareRigSpecReview extends RigSpecReviewBase {
  format: "pod_aware";
  pods: Array<{
    id: string;
    namespace?: string;
    label?: string;
    members: Array<{ id: string; agentRef: string; runtime: string; profile?: string }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

export interface LegacyRigSpecReview extends RigSpecReviewBase {
  format: "legacy";
  nodes: Array<{ id: string; runtime: string; role?: string; model?: string }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

export type RigSpecReview = PodAwareRigSpecReview | LegacyRigSpecReview;

// -- AgentSpec review --

export interface AgentSpecReview {
  sourceState: SourceState;
  kind: "agent";
  name: string;
  version: string;
  description?: string;
  profiles: Array<{ name: string; description?: string }>;
  resources: {
    skills: string[];
    guidance: string[];
    plugins: string[];
    subagents: string[];
  };
  startup: {
    files: Array<{ path: string; required: boolean }>;
    actions: Array<{ type: string; value: string }>;
  };
  raw: string;
}

// -- Review errors --

export class SpecReviewError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Spec validation failed: ${errors.join("; ")}`);
    this.name = "SpecReviewError";
  }
}

// -- Service --

function isPodAware(raw: Record<string, unknown>): boolean {
  return Array.isArray(raw["pods"]);
}

function inferNodeKind(runtime: string): "agent" | "infrastructure" {
  return runtime === "terminal" ? "infrastructure" : "agent";
}

export class SpecReviewService {
  reviewRigSpec(yaml: string, sourceState: SourceState): RigSpecReview {
    let raw: unknown;
    try {
      raw = RigSpecCodec.parse(yaml);
    } catch (err) {
      throw new SpecReviewError([`YAML parse error: ${(err as Error).message}`]);
    }
    if (!raw || typeof raw !== "object") {
      throw new SpecReviewError(["Failed to parse YAML"]);
    }

    const obj = raw as Record<string, unknown>;

    if (isPodAware(obj)) {
      return this.reviewPodAwareRigSpec(obj, yaml, sourceState);
    }
    return this.reviewLegacyRigSpec(obj, yaml, sourceState);
  }

  private reviewPodAwareRigSpec(
    obj: Record<string, unknown>,
    yaml: string,
    sourceState: SourceState,
  ): PodAwareRigSpecReview {
    const validation = RigSpecSchema.validate(obj);
    if (!validation.valid) {
      throw new SpecReviewError(validation.errors);
    }

    const name = obj["name"] as string;
    const version = obj["version"] as string;
    const summary = obj["summary"] as string | undefined;
    const cultureFile = obj["culture_file"] as string | undefined;
    const rawPods = (obj["pods"] as Record<string, unknown>[]) ?? [];
    const rawCrossPodEdges = (obj["edges"] as Record<string, unknown>[]) ?? [];

    const pods = rawPods.map((pod) => {
      const members = ((pod["members"] as Record<string, unknown>[]) ?? []).map((m) => ({
        id: m["id"] as string,
        agentRef: m["agent_ref"] as string,
        runtime: m["runtime"] as string,
        profile: m["profile"] as string | undefined,
      }));
      const podEdges = ((pod["edges"] as Record<string, unknown>[]) ?? []).map((e) => ({
        from: e["from"] as string,
        to: e["to"] as string,
        kind: e["kind"] as string,
      }));
      return {
        id: pod["id"] as string,
        namespace: pod["namespace"] as string | undefined,
        label: pod["label"] as string | undefined,
        members,
        edges: podEdges,
      };
    });

    const crossPodEdges = rawCrossPodEdges.map((e) => ({
      from: e["from"] as string,
      to: e["to"] as string,
      kind: e["kind"] as string,
    }));

    // Build graph
    const graphNodes: SpecGraphData["nodes"] = [];
    const graphEdges: SpecGraphData["edges"] = [];

    for (const pod of pods) {
      for (const member of pod.members) {
        const qualifiedId = `${pod.id}.${member.id}`;
        graphNodes.push({
          id: qualifiedId,
          label: member.id,
          pod: pod.id,
          runtime: member.runtime,
          kind: inferNodeKind(member.runtime),
        });
      }
      for (const edge of pod.edges) {
        graphEdges.push({
          source: `${pod.id}.${edge.from}`,
          target: `${pod.id}.${edge.to}`,
          kind: edge.kind,
        });
      }
    }
    for (const edge of crossPodEdges) {
      graphEdges.push({ source: edge.from, target: edge.to, kind: edge.kind });
    }

    // Extract services metadata if present
    let services: RigSpecServicesReview | undefined;
    const rawServices = obj["services"] as Record<string, unknown> | undefined;
    if (rawServices && typeof rawServices === "object" && rawServices["kind"] === "compose") {
      const rawWaitFor = (rawServices["wait_for"] as Array<Record<string, unknown>>) ?? [];
      const rawSurfaces = rawServices["surfaces"] as Record<string, unknown> | undefined;

      services = {
        kind: "compose",
        composeFile: rawServices["compose_file"] as string,
        projectName: rawServices["project_name"] as string | undefined,
        downPolicy: rawServices["down_policy"] as string | undefined,
        waitFor: rawWaitFor.map((w) => ({
          service: w["service"] as string | undefined,
          url: w["url"] as string | undefined,
          tcp: w["tcp"] as string | undefined,
          condition: w["condition"] as "healthy" | undefined,
        })),
        ...(rawSurfaces ? {
          surfaces: {
            urls: (rawSurfaces["urls"] as Array<{ name: string; url: string }>) ?? undefined,
            commands: (rawSurfaces["commands"] as Array<{ name: string; command: string }>) ?? undefined,
          },
        } : {}),
      };
    }

    return {
      sourceState,
      kind: "rig",
      name,
      version,
      summary,
      cultureFile,
      ...(services ? { services } : {}),
      format: "pod_aware",
      pods,
      edges: crossPodEdges,
      graph: { nodes: graphNodes, edges: graphEdges },
      raw: yaml,
    };
  }

  private reviewLegacyRigSpec(
    obj: Record<string, unknown>,
    yaml: string,
    sourceState: SourceState,
  ): LegacyRigSpecReview {
    const validation = LegacyRigSpecSchema.validate(obj);
    if (!validation.valid) {
      throw new SpecReviewError(validation.errors);
    }

    const name = obj["name"] as string;
    const version = obj["version"] as string;
    const rawNodes = (obj["nodes"] as Record<string, unknown>[]) ?? [];
    const rawEdges = (obj["edges"] as Record<string, unknown>[]) ?? [];

    const nodes = rawNodes.map((n) => ({
      id: n["id"] as string,
      runtime: n["runtime"] as string,
      role: n["role"] as string | undefined,
      model: n["model"] as string | undefined,
    }));

    const edges = rawEdges.map((e) => ({
      from: (e["source"] ?? e["from"]) as string,
      to: (e["target"] ?? e["to"]) as string,
      kind: e["kind"] as string,
    }));

    const graphNodes = nodes.map((n) => ({
      id: n.id,
      label: n.id,
      runtime: n.runtime,
      kind: inferNodeKind(n.runtime),
    }));

    const graphEdges = edges.map((e) => ({
      source: e.from,
      target: e.to,
      kind: e.kind,
    }));

    return {
      sourceState,
      kind: "rig",
      name,
      version,
      format: "legacy",
      nodes,
      edges,
      graph: { nodes: graphNodes, edges: graphEdges },
      raw: yaml,
    };
  }

  reviewAgentSpec(yaml: string, sourceState: SourceState): AgentSpecReview {
    let raw: Record<string, unknown>;
    try {
      raw = parseAgentSpec(yaml);
    } catch (err) {
      throw new SpecReviewError([`YAML parse error: ${(err as Error).message}`]);
    }
    const validation = validateAgentSpec(raw);
    if (!validation.valid) {
      throw new SpecReviewError(validation.errors);
    }

    const obj = raw as Record<string, unknown>;
    const name = obj["name"] as string;
    const version = obj["version"] as string;
    const description = obj["description"] as string | undefined;

    // Profiles — AgentSpec stores profiles as a map, not an array
    const rawProfiles = (obj["profiles"] ?? {}) as Record<string, unknown>;
    const profiles = Object.entries(rawProfiles).map(([name, value]) => ({
      name,
      description: (value as Record<string, unknown> | null)?.["description"] as string | undefined,
    }));

    // Resources
    const rawResources = (obj["resources"] ?? {}) as Record<string, unknown>;
    const extractPaths = (arr: unknown): string[] => {
      if (!Array.isArray(arr)) return [];
      return arr.map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null) return (item as Record<string, unknown>)["path"] as string ?? "";
        return "";
      }).filter(Boolean);
    };

    // Plugin entries have a different shape: { id, source: { kind, path } }.
    // The id is the human-readable handle for the review surface (operator
    // recognizes "openrig-core" not "/Users/op/.openrig/plugins/openrig-core").
    const extractPluginIds = (raw: unknown): string[] => {
      if (!Array.isArray(raw)) return [];
      return raw.map((item) => {
        if (typeof item === "object" && item !== null) {
          return (item as Record<string, unknown>)["id"] as string ?? "";
        }
        return "";
      }).filter(Boolean);
    };

    const resources = {
      skills: extractPaths(rawResources["skills"]),
      guidance: extractPaths(rawResources["guidance"]),
      plugins: extractPluginIds(rawResources["plugins"]),
      subagents: extractPaths(rawResources["subagents"]),
    };

    // Startup
    const rawStartup = (obj["startup"] ?? {}) as Record<string, unknown>;
    const startupFiles = ((rawStartup["files"] as Record<string, unknown>[]) ?? []).map((f) => ({
      path: f["path"] as string,
      required: (f["required"] as boolean) ?? false,
    }));
    const startupActions = ((rawStartup["actions"] as Record<string, unknown>[]) ?? []).map((a) => ({
      type: a["type"] as string,
      value: a["value"] as string,
    }));

    return {
      sourceState,
      kind: "agent",
      name,
      version,
      description,
      profiles,
      resources,
      startup: { files: startupFiles, actions: startupActions },
      raw: yaml,
    };
  }
}
