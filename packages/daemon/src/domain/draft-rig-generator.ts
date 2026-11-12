import type { DiscoveredSession, RuntimeHint } from "./discovery-types.js";
import { RigSpecCodec } from "./rigspec-codec.js";
import type { RigSpec, RigSpecPod, RigSpecPodMember } from "./types.js";
import { basename } from "node:path";

const VALID_ID_CHARS = /^[a-zA-Z0-9\-_]+$/;

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9\-_]/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "node";
}

function dedupeId(id: string, existing: Set<string>): string {
  if (!existing.has(id)) { existing.add(id); return id; }
  for (let i = 2; ; i++) {
    const candidate = `${id}-${i}`;
    if (!existing.has(candidate)) { existing.add(candidate); return candidate; }
  }
}

function mapRuntime(hint: RuntimeHint): string {
  switch (hint) {
    case "claude-code": return "claude-code";
    case "codex": return "codex";
    case "terminal": return "terminal";
    default: return "claude-code"; // unreachable — unknowns excluded before this
  }
}

export interface DraftResult {
  yaml: string;
  warnings: string[];
}

export function generateDraftRig(sessions: DiscoveredSession[]): DraftResult {
  const warnings: string[] = [];

  // Exclude unknown runtime sessions
  const usable = sessions.filter((s) => {
    if (s.runtimeHint === "unknown") {
      warnings.push(`Excluded session '${s.tmuxSession}': runtime could not be determined. Investigate manually.`);
      return false;
    }
    return true;
  });

  if (usable.length === 0) {
    const yaml = warnings.map((w) => `# WARNING: ${w}`).join("\n") + "\n# No sessions with known runtime found.\n";
    return { yaml, warnings };
  }

  // Group by CWD
  const cwdGroups = new Map<string, DiscoveredSession[]>();
  for (const s of usable) {
    const key = s.cwd ?? "__no-cwd__";
    if (!cwdGroups.has(key)) cwdGroups.set(key, []);
    cwdGroups.get(key)!.push(s);
  }

  // Build pods
  const podIds = new Set<string>();
  const pods: RigSpecPod[] = [];

  for (const [cwd, groupSessions] of cwdGroups) {
    const baseName = cwd !== "__no-cwd__" ? basename(cwd) : "default";
    const podId = dedupeId(sanitizeId(baseName), podIds);

    const memberIds = new Set<string>();
    const members: RigSpecPodMember[] = groupSessions.map((s) => {
      const rawName = s.tmuxSession.split(":")[0] ?? s.tmuxSession;
      const memberId = dedupeId(sanitizeId(rawName), memberIds);
      const runtime = mapRuntime(s.runtimeHint);
      const isTerminal = runtime === "terminal";

      return {
        id: memberId,
        agentRef: isTerminal ? "builtin:terminal" : `local:agents/${memberId}`,
        profile: isTerminal ? "none" : "default",
        runtime,
        cwd: s.cwd ?? ".",
      };
    });

    pods.push({
      id: podId,
      label: podId.charAt(0).toUpperCase() + podId.slice(1),
      members,
      edges: [],
    });
  }

  const rigSpec: RigSpec = {
    version: "0.2",
    name: "discovered-rig",
    pods,
    edges: [],
  };

  const yamlBody = RigSpecCodec.serialize(rigSpec);
  const commentPreamble = warnings.map((w) => `# WARNING: ${w}`).join("\n");
  const yaml = commentPreamble ? `${commentPreamble}\n${yamlBody}` : yamlBody;

  return { yaml, warnings };
}
