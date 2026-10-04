import { posix as path } from "node:path";
import { parse as parseYaml } from "yaml";
import { packageDigest, type PackageDigest } from "./bundle-identity.js";
import { parseAgentSpec, normalizeAgentSpec } from "./agent-manifest.js";
import { parsePolicySpec, validatePolicySpec } from "./permission-policy/policy-spec.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import type { AgentSpec, StartupBlock } from "./types.js";
import { normalizePreconditionsBlock } from "./bundle-types.js";

type ObjectValue = Record<string, unknown>;
type SourceRef = { path: string; field?: string };
type Resolution = "archive" | "host_at_launch" | "unresolved";
type Assembler = { openrigVersion: string; commit?: string };
export interface BehaviourIdentity {
  source: ObjectValue | null;
  configurationId: string | null;
  packageDigest: PackageDigest | null;
  assembler: Assembler | null;
  generator: Assembler;
  compatibility?: ObjectValue;
  statedProvenance?: ObjectValue;
  integrity: { digestValid: boolean; filesVerified: boolean };
}
interface FileFact {
  seat?: string;
  kind: string;
  pathOrRef: string;
  resolution: Resolution;
  sourceRefs: SourceRef[];
  delivery?: string;
  trigger?: string;
}
interface WriteFact {
  seat?: string;
  kind: string;
  destinationBase: string;
  path: string;
  operation: string;
  phase: string;
  condition?: string;
  sourceRefs: SourceRef[];
}
interface GeneratedBehaviour {
  schema: "openrig.bundle-behaviour/v1";
  state: "generated";
  identity: BehaviourIdentity;
  team: Array<{ seat: string; pod: string; member: string; agentRef: string; profile: string; runtime: string; model?: string; cwd: string }>;
  posture: Array<{ seat: string; shellAccess: string; selection: string; basis: "explicit" | "product_default" | "unresolved"; permissionPrompts?: "off" | "on" | "default"; nativeEffect: "unknown"; sourceRefs: SourceRef[] }>;
  toldFiles: FileFact[];
  alsoRuns: FileFact[];
  writes: WriteFact[];
  outsideAddresses: Array<{ domain: string; sourceRefs: SourceRef[] }>;
  needs: Array<{ kind: string; name: string; commands?: string[]; versionConstraint?: string; status: "not_checked"; sourceRefs: SourceRef[] }>;
  unknownBeforeLaunch: Array<{ subject: string; reason: string; sourceRefs: SourceRef[] }>;
}
export type BundleBehaviour = GeneratedBehaviour | {
  schema: "openrig.bundle-behaviour/v1";
  state: "not_generated";
  identity: BehaviourIdentity;
  reason: string;
  localInspectCommand: string;
};
export interface DescribeBundleInput {
  /** Only regular members of the inspected archive. No host filesystem reader. */
  files: ReadonlyMap<string, string>;
  manifest: ObjectValue;
  generator: Assembler;
  digestValid: boolean;
  filesVerified: boolean;
  /** Binary, oversized or unreadable members omitted by the inspection wrapper. */
  omittedFiles?: string[];
  source?: ObjectValue | null;
  configurationId?: string | null;
  assembler?: Assembler | null;
}

const object = (v: unknown): ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : {};
const text = (v: unknown): string | undefined => typeof v === "string" && v.length > 0 ? v : undefined;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

/** Resolve an archive reference, never an OS path. Internal ../ imports are allowed only while contained. */
function memberPath(base: string, ref: string): string | undefined {
  if (ref.startsWith("/") || ref.startsWith("~") || ref.includes("\\") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return undefined;
  const resolved = path.normalize(path.join(base, ref));
  return resolved === ".." || resolved.startsWith("../") ? undefined : resolved;
}

/** Read archive declarations only. This function has no process, filesystem, network or database dependency. */
export function describeBundleBehaviour(input: DescribeBundleInput): BundleBehaviour {
  const { manifest, files } = input;
  const integrityFiles = object(object(manifest.integrity).files);
  const digests = Object.entries(integrityFiles).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const identity: BehaviourIdentity = {
    source: input.source ?? null,
    configurationId: input.configurationId ?? null,
    packageDigest: manifest.integrity ? packageDigest(Object.fromEntries(digests)) : null,
    assembler: input.assembler ?? null,
    generator: input.generator,
    compatibility: {
      ...(text(object(manifest.compatibility).min_daemon_version) ? { minDaemonVersion: object(manifest.compatibility).min_daemon_version } : {}),
      ...(text(object(manifest.compatibility).min_cli_version) ? { minCliVersion: object(manifest.compatibility).min_cli_version } : {}),
    },
    statedProvenance: object(manifest.provenance),
    integrity: { digestValid: input.digestValid, filesVerified: input.filesVerified },
  };
  const unavailable = (reason: string): BundleBehaviour => ({
    schema: "openrig.bundle-behaviour/v1", state: "not_generated", identity, reason,
    localInspectCommand: "rig bundle inspect <archive> --json",
  });
  if (manifest.schema_version !== 2) return unavailable("A schema-1 archive has no pods or agent refs to describe.");
  try {
    const rigPath = memberPath("", text(manifest.rig_spec) ?? "rig.yaml");
    if (!rigPath || !files.has(rigPath)) return unavailable("The rig spec is not readable inside this archive.");
    const rig = object(parseYaml(files.get(rigPath)!));
    if (!Array.isArray(rig.pods)) return unavailable("This archive has no pod-aware rig spec to describe.");
    const rigRoot = path.dirname(rigPath);
    const view: GeneratedBehaviour = {
      schema: "openrig.bundle-behaviour/v1", state: "generated", identity,
      team: [], posture: [], toldFiles: [], alsoRuns: [], writes: [], outsideAddresses: [], needs: [], unknownBeforeLaunch: [],
    };
    const unknown = (subject: string, reason: string, sourceRefs: SourceRef[] = []) => {
      view.unknownBeforeLaunch.push({ subject, reason, sourceRefs });
    };
    const fileFact = (seat: string | undefined, kind: string, ref: string, base: string, sourceRefs: SourceRef[]): FileFact => {
      const resolved = memberPath(base, ref);
      const present = resolved !== undefined && (files.has(resolved) || [...files.keys()].some(p => p.startsWith(resolved + "/")));
      const resolution: Resolution = present ? "archive" : resolved === undefined ? "host_at_launch" : "unresolved";
      if (!present) unknown(ref, resolution === "host_at_launch" ? "Resolved on the installing host at launch; contents were not read." : "Not present in the inspected archive.", sourceRefs);
      return { ...(seat ? { seat } : {}), kind, pathOrRef: resolved ?? ref, resolution, sourceRefs };
    };
    const write = (seat: string | undefined, kind: string, destinationBase: string, target: string, sourceRefs: SourceRef[], operation = "project", phase = "before_launch") => {
      view.writes.push({ ...(seat ? { seat } : {}), kind, destinationBase, path: target, operation, phase,
        condition: "Subject to configured destinations, runtime support and existing-file conflicts at installation or launch.", sourceRefs });
    };
    const hooks = (fact: FileFact) => {
      if (fact.resolution !== "archive") return;
      const candidates = [...files].filter(([p]) => p === fact.pathOrRef || (p.startsWith(fact.pathOrRef + "/") && /hooks.*\.(json|ya?ml)$/.test(p)));
      const visit = (value: unknown, p: string, field: string) => {
        if (Array.isArray(value)) { value.forEach((v, i) => visit(v, p, `${field}[${i}]`)); return; }
        for (const [key, val] of Object.entries(object(value))) {
          const location = field ? `${field}.${key}` : key;
          if ((key === "command" || key === "script") && typeof val === "string") {
            view.alsoRuns.push({ seat: fact.seat, kind: "hook_command", pathOrRef: val, resolution: "archive",
              trigger: field || "declared hook; native loading determines execution", sourceRefs: [{ path: p, field: location }] });
          } else visit(val, p, location);
        }
      };
      for (const [p, content] of candidates) {
        try { visit(parseYaml(content), p, ""); } catch { unknown(p, "Hook declarations could not be parsed; no code was executed.", [{ path: p }]); }
      }
    };
    const loadAgent = (ref: string, base: string): { spec: AgentSpec; dir: string; file: string } | undefined => {
      if (!ref.startsWith("local:")) return undefined;
      const dir = memberPath(base, ref.slice(6));
      if (!dir) return undefined;
      const file = path.join(dir, "agent.yaml");
      const content = files.get(file);
      if (content === undefined) return undefined;
      return { spec: normalizeAgentSpec(parseAgentSpec(content)), dir, file };
    };
    for (const podValue of rig.pods) {
      const pod = object(podValue);
      for (const memberValue of list(pod.members)) {
        const member = object(memberValue);
        if (!text(pod.id) || !text(member.id) || !text(member.agent_ref)) return unavailable("A member is missing its pod, id or agent reference.");
        const seat = `${pod.id}.${member.id}`;
        const sourceRefs = [{ path: rigPath, field: `pods.${pod.id}.members.${member.id}` }];
        const agentRef = String(member.agent_ref);
        const agent = loadAgent(agentRef, rigRoot);
        if (!agent && agentRef !== "builtin:terminal" && !text(member.runtime)) {
          return unavailable(`Runtime for ${seat} depends on an AgentSpec that is not readable in this archive.`);
        }
        const profileName = text(member.profile) ?? "default";
        const profile = agent?.spec.profiles[profileName];
        const runtime = text(member.runtime) ?? profile?.preferences?.runtime ?? agent?.spec.defaults?.runtime ?? (agentRef === "builtin:terminal" ? "terminal" : "claude-code");
        const model = text(member.model) ?? profile?.preferences?.model ?? agent?.spec.defaults?.model;
        view.team.push({ seat, pod: String(pod.id), member: String(member.id), agentRef, profile: profileName, runtime, ...(model ? { model } : {}), cwd: text(member.cwd) ?? "." });
        view.needs.push({ kind: "runtime", name: runtime, status: "not_checked", sourceRefs });
        if (runtime !== "terminal") view.needs.push({ kind: "login", name: `${runtime}: the user's own runtime account or provider configuration`, status: "not_checked", sourceRefs });
        let posture: "floor" | "full_bypass" | undefined;
        let policySurface: "flag" | "config" | undefined;
        const policy = text(member.permission_policy) ?? text(rig.permission_policy);
        let basis: "explicit" | "product_default" | "unresolved" = policy ? "explicit" : "product_default";
        if (policy === "builtin:yolo") { posture = "full_bypass"; policySurface = "flag"; }
        else if (["builtin:locked", "builtin:standard", "builtin:open"].includes(policy ?? "")) policySurface = "config";
        else if (policy === "none") posture = "floor";
        else if (policy) {
          const p = memberPath(rigRoot, policy);
          const raw = p ? files.get(p) : undefined;
          const parsed = raw === undefined ? undefined : parsePolicySpec(raw);
          if (parsed && !("error" in parsed) && validatePolicySpec(parsed.frontmatter).ok) {
            policySurface = parsed.frontmatter.surface as "flag" | "config";
            if (policySurface === "flag") posture = parsed.frontmatter.launch_posture as "floor" | "full_bypass";
          } else { basis = "unresolved"; unknown(policy, "Permission policy could not be resolved from the archive.", sourceRefs); }
        }
        const access = runtime === "terminal" ? "Terminal shell; no native agent permission flag"
          : basis === "unresolved" ? `unresolved policy: ${policy}`
          : runtime === "pi" ? `${posture === "full_bypass" ? "Permission prompts: off; Pi gets full resource trust (full_bypass / approve)" : "resource trust resolved at launch"}; not a native permission policy`
          : posture === "full_bypass" ? runtime === "claude-code" ? "Permission prompts: off; Claude bypasses permissions (full_bypass)"
            : runtime === "codex" ? "Permission prompts: off; Codex runs with full access and never asks (full_bypass)"
            : "full_bypass: native permission bypass / unrestricted sandbox requested"
          : policySurface === "config" ? "Action-specific permission configuration; prompt behavior resolved at launch"
          : runtime === "claude-code" ? "acceptEdits (conditional launch floor)"
          : runtime === "codex" ? (text(member.codex_config_profile) ? `native profile ${member.codex_config_profile}; sandbox and approvals resolved at launch` : "workspace-write (conditional launch floor); approval policy resolved at launch")
          : "runtime-specific access; resolved at launch";
        const selection = policy && basis !== "unresolved" ? `${access}; declared policy: ${policy}` : access;
        const hostCodexProfile = runtime === "codex" && text(member.codex_config_profile);
        const nativePermissionSurface = runtime === "claude-code" || runtime === "codex";
        const permissionPrompts = posture === "full_bypass" ? "off"
          : !nativePermissionSurface || hostCodexProfile || policySurface === "config" ? undefined
          : policySurface === "flag" && posture === "floor" ? "on"
          : basis === "product_default" ? "default" : undefined;
        view.posture.push({ seat, shellAccess: "Can run shell commands as the launching user, subject to runtime and host policy.", selection, basis, ...(permissionPrompts ? { permissionPrompts } : {}), nativeEffect: "unknown", sourceRefs });
        const managed = runtime === "claude-code" ? text(object(rig.managed_blocks)["claude-code"]) ?? "CLAUDE.md" : runtime === "codex" ? "AGENTS.md" : undefined;
        if (managed) write(seat, "managed_guidance", "seat_cwd", managed, sourceRefs, "merge managed blocks");
        const startup = (block: StartupBlock | undefined, base: string, refs: SourceRef[]) => {
          for (const f of block?.files ?? []) {
            const fact = fileFact(seat, "startup", f.path, base, refs);
            const content = fact.resolution === "archive" ? files.get(fact.pathOrRef) : undefined;
            fact.delivery = f.deliveryHint === "auto" && content !== undefined ? resolveConcreteHint(f.path, content) : f.deliveryHint;
            view.toldFiles.push(fact);
            if (fact.delivery === "skill_install" && (runtime === "claude-code" || runtime === "codex")) {
              const root = runtime === "claude-code" ? ".claude" : ".agents";
              write(seat, "startup_skill", "seat_cwd", `${root}/skills/${path.basename(path.dirname(f.path))}/${path.basename(f.path)}`, refs);
            }
          }
          for (const [index, action] of (block?.actions ?? []).entries()) view.alsoRuns.push({ seat, kind: `startup_${action.type}`,
            pathOrRef: action.type === "send_text" ? `${refs[0]?.path}#${refs[0]?.field}.actions[${index}]` : action.value,
            resolution: "archive", trigger: `${action.phase}; ${action.appliesOn.join(", ")}`, sourceRefs: refs });
        };
        if (agent) {
          startup(agent.spec.startup, agent.dir, [{ path: agent.file, field: "startup" }]);
          startup(profile?.startup, agent.dir, [{ path: agent.file, field: `profiles.${profileName}.startup` }]);
          if (!profile) unknown(seat, `Profile ${profileName} is not in the packaged AgentSpec.`, [{ path: agent.file }]);
          const imports: NonNullable<typeof agent>[] = [];
          const visited = new Set([agent.file]);
          const walk = (current: NonNullable<typeof agent>) => {
            for (const imp of current.spec.imports) {
              const child = loadAgent(imp.ref, current.dir);
              if (!child) { unknown(imp.ref, "Imported AgentSpec is not readable in this archive.", [{ path: current.file, field: "imports" }]); continue; }
              if (visited.has(child.file)) continue;
              visited.add(child.file); imports.push(child); walk(child);
            }
          };
          walk(agent);
          for (const category of ["skills", "guidance", "subagents", "plugins", "runtimeResources"] as const) {
            for (const selected of profile?.uses[category] ?? []) {
              const local = agent.spec.resources[category].filter(r => r.id === selected).map(resource => ({ owner: agent, resource }));
              const imported = imports.flatMap(owner => owner.spec.resources[category].filter(r => `${owner.spec.name}:${r.id}` === selected || (!selected.includes(":") && r.id === selected)).map(resource => ({ owner, resource })));
              const candidates = local.length ? local : imported;
              const selectedRefs = [{ path: agent.file, field: `profiles.${profileName}.uses.${category}` }];
              if (candidates.length !== 1) {
                const discoveredSkill = !candidates.length && category === "skills";
                const fact: FileFact = { seat, kind: category, pathOrRef: selected, resolution: discoveredSkill ? "host_at_launch" : "unresolved", sourceRefs: selectedRefs };
                (category === "plugins" || category === "runtimeResources" ? view.alsoRuns : view.toldFiles).push(fact);
                unknown(selected, candidates.length ? "Ambiguous packaged resource selection." : discoveredSkill
                  ? "Selected skill may come from the host catalog; not resolved before launch."
                  : "Selected resource is not declared in the packaged AgentSpecs.", selectedRefs);
                continue;
              }
              const { owner, resource } = candidates[0]!;
              if ("runtime" in resource && resource.runtime !== runtime) continue;
              if (category === "plugins" && "pluginType" in resource &&
                ((resource.pluginType === "codex" && runtime === "claude-code") || (resource.pluginType === "claude" && runtime === "codex"))) continue;
              const ref = "source" in resource ? resource.source.path : resource.path;
              const fact = fileFact(seat, category, ref, owner.dir, [{ path: owner.file, field: `resources.${category}.${resource.id}` }]);
              if (category === "plugins" || category === "runtimeResources") {
                view.alsoRuns.push({ ...fact, trigger: "if selected runtime supports and loads this resource" });
                hooks(fact);
              }
              else view.toldFiles.push(fact);
              if (category === "guidance") continue; // the managed destination is listed once per seat
              const root = runtime === "claude-code" ? ".claude" : runtime === "codex" ? ".agents" : undefined;
              if (root && category === "skills") write(seat, category, "seat_cwd", `${root}/skills/${selected}`, fact.sourceRefs);
              else if (root && category === "plugins") write(seat, category, "seat_cwd", `${runtime === "codex" ? ".codex" : root}/plugins/${selected}`, fact.sourceRefs);
              else if (root && category === "subagents") write(seat, category, "seat_cwd", `${runtime === "claude-code" ? ".claude/agents" : ".agents"}/${path.basename(ref)}`, fact.sourceRefs);
              else if (root && category === "runtimeResources" && "type" in resource) {
                // Match the adapters' declared destinations without calling them or reading host settings.
                if (runtime === "codex" && resource.type === "codex_config_fragment") {
                  write(seat, category, "codex_home", "config.toml", fact.sourceRefs, "merge managed configuration fragment");
                } else if (runtime === "claude-code" && ["claude_settings_fragment", "claude_activity_hooks"].includes(resource.type)) {
                  write(seat, category, "seat_cwd", ".claude/settings.local.json", fact.sourceRefs, "merge settings or managed hooks");
                } else if (runtime === "claude-code" && resource.type === "claude_mcp_fragment") {
                  write(seat, category, "seat_cwd", ".mcp.json", fact.sourceRefs, "merge MCP configuration fragment");
                } else write(seat, category, "seat_cwd", `${root}/extensions/${selected}`, fact.sourceRefs);
              }
              else unknown(selected, "Projection destination depends on the installed runtime adapter.", fact.sourceRefs);
            }
          }
        } else if (agentRef !== "builtin:terminal") unknown(agentRef, "AgentSpec is not readable in this archive; its selected resources are unknown.", sourceRefs);
        if (text(rig.culture_file)) {
          const fact = fileFact(seat, "culture", String(rig.culture_file), rigRoot, [{ path: rigPath, field: "culture_file" }]);
          const content = fact.resolution === "archive" ? files.get(fact.pathOrRef) : undefined;
          view.toldFiles.push({ ...fact, delivery: content === undefined ? "auto" : resolveConcreteHint(fact.pathOrRef, content) });
        }
        // These overlays use the RigSpec directory, unlike AgentSpec/profile startup.
        for (const [raw, field] of [[rig.startup, "startup"], [pod.startup, `pods.${pod.id}.startup`], [member.startup, `pods.${pod.id}.members.${member.id}.startup`]] as const) {
          if (raw) startup(normalizeAgentSpec({ name: "overlay", version: "1", startup: raw }).startup, rigRoot, [{ path: rigPath, field }]);
        }
        if (member.session_source || member.starter_ref) unknown(seat, "Prior conversation, starter and rebuild inputs are resolved at launch.", sourceRefs);
      }
    }
    if (rig.services) {
      const services = object(rig.services);
      const refs = [{ path: rigPath, field: "services" }];
      view.alsoRuns.push({ ...fileFact(undefined, "services", text(services.compose_file) ?? "compose.yaml", rigRoot, refs), trigger: "before agent launch; existing health checks still apply" });
      view.needs.push({ kind: "tool", name: "Docker Compose and the declared services", status: "not_checked", sourceRefs: refs });
      for (const hook of list(services.checkpoints)) {
        for (const field of ["export_command", "import_command"]) {
          const command = text(object(hook)[field]);
          if (command) view.alsoRuns.push({ kind: "service_checkpoint", pathOrRef: command, resolution: "archive", trigger: field, sourceRefs: refs });
        }
      }
    }
    const preconditions = normalizePreconditionsBlock(manifest.preconditions);
    if (manifest.preconditions !== undefined && !preconditions) unknown("Bundle preconditions", "The archive's setup declarations could not be described; no setup was checked or executed.", [{ path: "bundle.yaml", field: "preconditions" }]);
    for (const [index, precondition] of (preconditions ?? []).entries()) {
      view.needs.push({ kind: "precondition", ...precondition, status: "not_checked", sourceRefs: [{ path: "bundle.yaml", field: `preconditions[${index}]` }] });
    }
    for (const [key, name] of [["min_daemon_version", "OpenRig daemon"], ["min_cli_version", "OpenRig CLI"]] as const) {
      const versionConstraint = text(object(manifest.compatibility)[key]);
      if (versionConstraint) view.needs.push({ kind: "version", name, versionConstraint: `>=${versionConstraint}`, status: "not_checked", sourceRefs: [{ path: "bundle.yaml", field: `compatibility.${key}` }] });
    }
    write(undefined, "bundle_files", "install_target", ".", [{ path: "bundle.yaml" }], "materialize archive");
    for (const [key, destinationBase] of Object.entries({ skills: "openrig_home/packages", plugins: "openrig_home/plugins", workflow_specs: "workspace.specs/workflows", context_packs: "context.root", agent_images: "openrig_home/agent-images" })) {
      for (const entry of list(manifest[key])) {
        const ref = text(entry) ?? text(object(object(entry).source).path);
        if (ref) {
          const destination = key === "plugins" ? text(object(entry).id) ?? ref
            : key === "context_packs" ? path.basename(path.dirname(ref))
            : key === "skills" ? ref.replace(/^(packages|skills)\//, "") : path.basename(ref);
          write(undefined, key, destinationBase, destination, [{ path: "bundle.yaml", field: key }], "add to configured library");
        }
      }
    }
    if (text(object(manifest.project).id)) {
      const refs = [{ path: "bundle.yaml", field: "project" }];
      write(undefined, "project_files", "workspace.projects_root", String(object(manifest.project).id), refs, "materialize carried project if absent");
      write(undefined, "project_registration", "workspace.catalog_path", ".", refs, "register carried project and associate installed rig");
    }
    const domains = new Map<string, SourceRef[]>();
    for (const [p, content] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      for (const match of content.matchAll(/https?:\/\/[^\s<>"'`\])}]+/g)) {
        try {
          const domain = new URL(match[0]).hostname;
          const refs = domains.get(domain) ?? [];
          if (!refs.some(r => r.path === p)) refs.push({ path: p });
          domains.set(domain, refs);
        } catch { /* Literal text that is not a URL carries no inferred destination. */ }
      }
    }
    view.outsideAddresses = [...domains].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([domain, sourceRefs]) => ({ domain, sourceRefs }));
    unknown("host and native settings", "Effective permissions, login, model availability, runtime versions, host catalogs/plugins and configured paths are not checked before launch.");
    unknown("runtime behavior", "Scripts and agents can compute other actions and addresses. Literal URL occurrences are not a prediction of network traffic.");
    unknown("built-in and host integration", "The installed OpenRig/runtime adds culture, onboarding, session identity and host context, and can provision runtime hook/settings files. Those bytes and effects are outside this archive.");
    if (input.omittedFiles?.length) unknown("unread text", "Binary, oversized or unreadable members were not scanned; this view cannot account for their contents.", input.omittedFiles.map(p => ({ path: p })));
    return view;
  } catch (error) {
    return unavailable(`Archive declarations could not be described: ${error instanceof Error ? error.message : String(error)}`);
  }
}
