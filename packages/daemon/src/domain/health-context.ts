import { readFileSync, statSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { resolveAllowedFile } from "./files/path-safety.js";
import type { HealthRecord } from "./health-projection.js";
import { healthEpisodeId } from "./health-projection.js";
import type { AuthorityReference } from "./health-diagnosis.js";
import type { HealthCheckpointSource } from "./health-checkpoints.js";
import { parseAddress, resolveAddress } from "./markdown-address.js";
import { loadHumanRegistry } from "./gateway/human-registry.js";
import { loadConfig } from "./gateway/slack/config.js";
import { resolveSecret } from "./gateway/slack/secrets.js";
import { resolveHumanDeliveryReadiness } from "./gateway/human-readiness.js";

/** Local evidence files only. Unsupported addresses retain unavailable truth.
 * Reuse the file surface's realpath resolver; callers choose whether to embed bytes. */
export function readHealthArtifact(workspace: string, path: string, maxBytes = 1048576, embed = false): AuthorityReference {
  try {
    const root = realpathSync(workspace);
    const canonical = resolveAllowedFile([{ name: "workspace", canonicalPath: root }], "workspace", relative(resolve(workspace), resolve(workspace, path)));
    const size = statSync(canonical).size;
    if (size === 0 || size > maxBytes) return { path, state: "unavailable" };
    const bytes = readFileSync(canonical);
    return { path, state: "available", ...(embed ? { content: bytes.toString("utf8") } : {}), sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { return { path, state: "unavailable" }; }
}

type AuthorityLevel = NonNullable<AuthorityReference["level"]>;

/** Only read a canonical file at the selected work-tree node; aliases are unavailable. */
function readAuthorityFile(workspace: string, path: string): AuthorityReference {
  try {
    const selected = relative(resolve(workspace), resolve(workspace, path));
    const actual = relative(realpathSync(workspace), realpathSync(resolve(workspace, path)));
    if (actual !== selected) return { path, state: "unavailable" };
    return readHealthArtifact(workspace, path, 65536, true);
  } catch { return { path, state: "unavailable" }; }
}

/** Reuse authored context selections, including project planning before a mission exists.
 * No filename guesses, recursive link following, or executable workflow adoption. */
export function healthSelectedContext(workspace: string, missionRoot?: string): AuthorityReference[] {
  const result: AuthorityReference[] = [];
  let remaining = 131072;
  let count = 0;
  const add = (refs: unknown, source: string, root: string) => {
    if (refs === undefined) return;
    if (!Array.isArray(refs) || refs.some(r => typeof r !== "string" || !r.trim()) || (count += refs.length) > 32) {
      result.push({ path: source, state: "unavailable", role: "selected context", reason: "Context selection must contain at most 32 non-empty addresses in total." });
      return;
    }
    for (const address of refs as string[]) {
      const base = { path: address, role: "selected context", selectedBy: source };
      try {
        const { ref, headerPath } = parseAddress(address);
        // Only explicitly selected local project files; unsupported transports stay visible.
        if (/^(?:[a-z]+:|\$)/i.test(ref)) throw Error("Unsupported local context address");
        const path = resolve(root, ref);
        const file = readAuthorityFile(workspace, path);
        if (!file.content) throw Error("Selected file unavailable, aliased, outside project, or larger than 64 KiB");
        const content = headerPath.length ? resolveAddress(file.content, headerPath).text : file.content;
        if (Buffer.byteLength(content) > remaining) throw Error("Selected context exceeds 128 KiB total read budget");
        remaining -= Buffer.byteLength(content);
        result.push({ ...base, path: path + (headerPath.length ? "#" + headerPath.join("/") : ""), state: "available", content,
          sha256: createHash("sha256").update(content).digest("hex") });
      } catch (error) { result.push({ ...base, state: "unavailable", reason: String(error) }); }
    }
  };
  for (const [root, name] of [[workspace, "project.yaml"], ...(missionRoot ? [[missionRoot, "mission.yaml"]] : [])] as Array<[string, string]>) {
    const path = join(root, name);
    try {
      const file = readAuthorityFile(workspace, path);
      if (!file.content) throw Error("Selection manifest unavailable");
      const doc = parseYaml(file.content);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw Error("Invalid selection manifest");
      if (name === "project.yaml") {
        add(doc.install?.context, path + "#install.context", root);
        if (doc.lifecycle?.profiles !== undefined) {
          const profile = doc.lifecycle.profiles[doc.lifecycle.profile];
          if (!profile) throw Error("Selected lifecycle profile unavailable");
          add(profile.workflow?.context_refs, path + "#lifecycle.profiles." + doc.lifecycle.profile + ".workflow.context_refs", root);
        }
      } else add(doc.lifecycle?.workflow?.context_refs, path + "#lifecycle.workflow.context_refs", root);
    } catch (error) { result.push({ path, state: "unavailable", role: "context selection", reason: String(error) }); }
  }
  return result;
}

export function healthAuthority(workspace: string, checkpoints: HealthCheckpointSource, record: HealthRecord): AuthorityReference[] {
  if (record.operatingPosture?.posture === "unknown") return [{ path: "operatingPosture", state: "unavailable", role: "scope", reason: record.operatingPosture.reason }];
  // The shared reader has already resolved the declared project catalog and real paths.
  const paths = record.operatingPosture?.context?.paths;
  workspace = paths?.project ?? workspace;
  const checkpoint = record.detector === "process.ceremony-amplification" ? checkpoints.entries().find((c) => healthEpisodeId(record.detector, c.checkpoint.scope, c.episodeStartedAt) === record.id)?.checkpoint : undefined;
  const scope = record.scope;
  const mission = (scope.type === "mission" || scope.type === "slice") && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(scope.missionId) ? scope.missionId : null;
  const missionDir = mission ? paths?.mission ?? join(workspace, "missions", mission) : null;
  const groups: Record<AuthorityLevel, string[]> = {
    project: [join(workspace, "SPEC.md"), join(workspace, "project.yaml"), ...checkpoint?.authorityPaths.project ?? []],
    mission: [...(missionDir ? [join(missionDir, "SPEC.md"), join(missionDir, "mission.yaml")] : []), ...checkpoint?.authorityPaths.mission ?? []],
    slice: [...checkpoint?.authorityPaths.slice ?? [], ...record.ceremony?.context.filter((r) => r.role.startsWith("slice authority")).map((r) => r.path).filter((p) => /(?:SPEC\.md|slice\.yaml)$/.test(p)) ?? []],
  };
  const belongs = (level: AuthorityLevel, path: string): boolean => {
    const parts = relative(resolve(workspace), resolve(workspace, path)).split("/");
    if (level === "project") return parts.length === 1 && ["SPEC.md", "project.yaml"].includes(parts[0]!);
    if (!missionDir) return false;
    const workParts = relative(missionDir, resolve(workspace, path)).split("/");
    if (level === "mission") return workParts.length === 1 && ["SPEC.md", "mission.yaml"].includes(workParts[0]!);
    if (scope.type !== "slice" || workParts.length !== 3 || workParts[0] !== "slices" || !["SPEC.md", "slice.yaml"].includes(workParts[2]!)) return false;
    // Directory names are not slice IDs. The canonical sibling SPEC owns identity.
    const spec = readAuthorityFile(workspace, join(missionDir, ...workParts.slice(0, 2), "SPEC.md"));
    const frontmatter = spec.content?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!frontmatter) return false;
    const identity = parseYaml(frontmatter) as { id?: unknown; mission?: unknown } | null;
    return identity?.id === scope.sliceId && (identity.mission === undefined || identity.mission === mission);
  };
  const authority = (Object.keys(groups) as AuthorityLevel[]).flatMap((level) => [...new Set(groups[level])].map((path) => {
    try {
      return { ...(belongs(level, path) ? readAuthorityFile(workspace, path) : { path, state: "unavailable" as const }), level };
    } catch { return { path, state: "unavailable" as const, level }; }
  }));
  return [...authority, ...healthSelectedContext(workspace, missionDir ?? undefined)];
}

/** Connector-specific readiness lives behind the transport-neutral diagnosis port.
 * No notification is posted here; the existing gateway owns posting and receipts. */
export async function healthHumanReadiness(home: string, address: string, gatewayActive: boolean) {
  const registry = loadHumanRegistry(home);
  const human = registry.ok ? registry.entities.find((h) => h.address === address) : undefined;
  if (!human) return { ready: false, reason: "registered human primary connector unavailable" };
  if (human.connectorBindings.find((b) => b.role === "primary")?.kind === "matrix") {
    const { matrixHumanReadiness } = await import("./gateway/matrix/readiness.js");
    const readiness = matrixHumanReadiness(home, human, gatewayActive ? "active" : "inactive");
    return { ready: readiness.ready, reason: readiness.reason };
  }
  const cfg = loadConfig(home);
  const token = resolveSecret("SLACK_BOT_TOKEN", { envFile: cfg.secretsEnvFile ?? undefined });
  const readiness = await resolveHumanDeliveryReadiness({
    human,
    config: cfg,
    gatewayState: gatewayActive ? "active" : "inactive",
    botToken: token,
  });
  return { ready: readiness.ready, reason: readiness.reason };
}
