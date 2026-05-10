// Phase 3a slice 3.3 — UI client for the plugin discovery API.
//
// Wraps GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by
// in @tanstack/react-query hooks for consumption by Library Explorer
// (plugins category) + PluginDetailPage + AgentSpec plugin sections.
//
// Types mirror the daemon's PluginEntry / PluginDetail / AgentReference
// shapes from packages/daemon/src/domain/plugin-discovery-service.ts.
// Kept in lockstep at v0; if the daemon shapes evolve, update both sides.

import { useQuery } from "@tanstack/react-query";

export type PluginRuntime = "claude" | "codex";
export type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache";

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: PluginSourceKind;
  sourceLabel: string;
  runtimes: PluginRuntime[];
  path: string;
  lastSeenAt: string | null;
}

export interface PluginManifestSummary {
  raw: Record<string, unknown>;
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

export interface PluginSkillSummary {
  name: string;
  relativePath: string;
}

export interface PluginHookSummary {
  runtime: PluginRuntime;
  relativePath: string;
  events: string[];
}

export interface PluginDetail {
  entry: PluginEntry;
  claudeManifest: PluginManifestSummary | null;
  codexManifest: PluginManifestSummary | null;
  skills: PluginSkillSummary[];
  hooks: PluginHookSummary[];
}

export interface PluginAgentReference {
  agentName: string;
  sourcePath: string;
  profiles: string[];
}

export interface UsePluginsOpts {
  runtime?: PluginRuntime;
  source?: PluginSourceKind;
}

function buildListUrl(opts: UsePluginsOpts | undefined): string {
  const params = new URLSearchParams();
  if (opts?.runtime) params.append("runtime", opts.runtime);
  if (opts?.source) params.append("source", opts.source);
  const qs = params.toString();
  return qs.length === 0 ? "/api/plugins" : `/api/plugins?${qs}`;
}

async function fetchPlugins(opts: UsePluginsOpts | undefined): Promise<PluginEntry[]> {
  const res = await fetch(buildListUrl(opts));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PluginEntry[]>;
}

async function fetchPlugin(id: string): Promise<PluginDetail> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PluginDetail>;
}

async function fetchPluginUsedBy(id: string): Promise<PluginAgentReference[]> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/used-by`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PluginAgentReference[]>;
}

export function usePlugins(opts: UsePluginsOpts = {}) {
  return useQuery<PluginEntry[]>({
    queryKey: ["plugins", "list", opts.runtime ?? "all", opts.source ?? "all"],
    queryFn: () => fetchPlugins(opts),
    staleTime: 30_000,
  });
}

export function usePlugin(id: string | null) {
  return useQuery<PluginDetail>({
    queryKey: ["plugins", "detail", id],
    queryFn: () => fetchPlugin(id!),
    enabled: id !== null,
    staleTime: 30_000,
  });
}

export function usePluginUsedBy(id: string | null) {
  return useQuery<PluginAgentReference[]>({
    queryKey: ["plugins", "used-by", id],
    queryFn: () => fetchPluginUsedBy(id!),
    enabled: id !== null,
    staleTime: 30_000,
  });
}
