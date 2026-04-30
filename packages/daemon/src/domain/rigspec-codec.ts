import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RigSpec, LegacyRigSpec } from "./types.js";

/**
 * Pod-aware RigSpec codec. Canonical contract for the AgentSpec reboot.
 */
export class RigSpecCodec {
  static parse(yamlString: string): unknown {
    return parseYaml(yamlString);
  }

  static serialize(spec: RigSpec): string {
    const doc: Record<string, unknown> = {
      version: spec.version,
      name: spec.name,
    };
    if (spec.summary) doc["summary"] = spec.summary;
    if (spec.cultureFile) doc["culture_file"] = spec.cultureFile;
    if (spec.docs && spec.docs.length > 0) doc["docs"] = spec.docs.map((d) => ({ path: d.path }));
    if (spec.startup) doc["startup"] = serializeStartupBlock(spec.startup);

    doc["pods"] = spec.pods.map((pod) => {
      const p: Record<string, unknown> = {
        id: pod.id,
        label: pod.label,
      };
      if (pod.summary) p["summary"] = pod.summary;
      if (pod.continuityPolicy) {
        const cp: Record<string, unknown> = { enabled: pod.continuityPolicy.enabled };
        if (pod.continuityPolicy.syncTriggers) cp["sync_triggers"] = pod.continuityPolicy.syncTriggers;
        if (pod.continuityPolicy.artifacts) {
          const a: Record<string, unknown> = {};
          if (pod.continuityPolicy.artifacts.sessionLog !== undefined) a["session_log"] = pod.continuityPolicy.artifacts.sessionLog;
          if (pod.continuityPolicy.artifacts.restoreBrief !== undefined) a["restore_brief"] = pod.continuityPolicy.artifacts.restoreBrief;
          if (pod.continuityPolicy.artifacts.quiz !== undefined) a["quiz"] = pod.continuityPolicy.artifacts.quiz;
          cp["artifacts"] = a;
        }
        if (pod.continuityPolicy.restoreProtocol) {
          const rp: Record<string, unknown> = {};
          if (pod.continuityPolicy.restoreProtocol.peerDriven !== undefined) rp["peer_driven"] = pod.continuityPolicy.restoreProtocol.peerDriven;
          if (pod.continuityPolicy.restoreProtocol.verifyViaQuiz !== undefined) rp["verify_via_quiz"] = pod.continuityPolicy.restoreProtocol.verifyViaQuiz;
          cp["restore_protocol"] = rp;
        }
        p["continuity_policy"] = cp;
      }
      if (pod.startup) p["startup"] = serializeStartupBlock(pod.startup);

      p["members"] = pod.members.map((m) => {
        const member: Record<string, unknown> = {
          id: m.id,
          agent_ref: m.agentRef,
          profile: m.profile,
          runtime: m.runtime,
          cwd: m.cwd,
        };
        if (m.label) member["label"] = m.label;
        if (m.codexConfigProfile) member["codex_config_profile"] = m.codexConfigProfile;
        if (m.model) member["model"] = m.model;
        if (m.restorePolicy) member["restore_policy"] = m.restorePolicy;
        if (m.startup) member["startup"] = serializeStartupBlock(m.startup);
        if (m.sessionSource) {
          const ref: Record<string, unknown> = { kind: m.sessionSource.ref.kind };
          if (m.sessionSource.ref.value !== undefined) ref["value"] = m.sessionSource.ref.value;
          member["session_source"] = { mode: m.sessionSource.mode, ref };
        }
        // (rebuild ref.value is an array; the codec re-emits it as-is via the
        //  same `ref.value` slot — the YAML serializer handles array emission.)
        return member;
      });

      p["edges"] = pod.edges.map((e) => ({ kind: e.kind, from: e.from, to: e.to }));
      return p;
    });

    doc["edges"] = spec.edges.map((e) => ({ kind: e.kind, from: e.from, to: e.to }));

    return stringifyYaml(doc);
  }
}

function serializeStartupBlock(startup: import("./types.js").StartupBlock): Record<string, unknown> {
  return {
    files: startup.files.map((f) => {
      const file: Record<string, unknown> = { path: f.path };
      if (f.deliveryHint !== "auto") file["delivery_hint"] = f.deliveryHint;
      if (!f.required) file["required"] = false;
      if (f.appliesOn.length !== 2 || !f.appliesOn.includes("fresh_start") || !f.appliesOn.includes("restore")) {
        file["applies_on"] = f.appliesOn;
      }
      return file;
    }),
    actions: startup.actions.map((a) => {
      const action: Record<string, unknown> = {
        type: a.type,
        value: a.value,
        phase: a.phase,
        idempotent: a.idempotent,
      };
      if (a.appliesOn.length !== 2 || !a.appliesOn.includes("fresh_start") || !a.appliesOn.includes("restore")) {
        action["applies_on"] = a.appliesOn;
      }
      return action;
    }),
  };
}

/**
 * Legacy flat-node RigSpec codec (pre-reboot).
 * TODO: Remove when AS-T08b/AS-T12 migrate all consumers.
 */
export class LegacyRigSpecCodec {
  static parse(yamlString: string): unknown {
    return parseYaml(yamlString);
  }

  static serialize(spec: LegacyRigSpec): string {
    const doc = {
      schema_version: spec.schemaVersion,
      name: spec.name,
      version: spec.version,
      nodes: spec.nodes.map((node) => {
        const n: Record<string, unknown> = { id: node.id, runtime: node.runtime };
        if (node.role != null) n["role"] = node.role;
        if (node.model != null) n["model"] = node.model;
        if (node.cwd != null) n["cwd"] = node.cwd;
        if (node.surfaceHint != null) n["surface_hint"] = node.surfaceHint;
        if (node.workspace != null) n["workspace"] = node.workspace;
        if (node.restorePolicy != null) n["restore_policy"] = node.restorePolicy;
        if (node.packageRefs && node.packageRefs.length > 0) n["package_refs"] = node.packageRefs;
        return n;
      }),
      edges: spec.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    };

    return stringifyYaml(doc);
  }
}
