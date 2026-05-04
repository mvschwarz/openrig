// Preview Terminal v0 (PL-018) — UI hook for live terminal preview.
//
// Polls /api/rigs/:rigId/nodes/:logicalId/preview at the operator-
// configured interval (`ui.preview.refresh_interval_seconds`, default
// 3s; read from /api/config). Honest fallback when the daemon doesn't
// have the new route (cross-CLI-version drift): consumers see
// `unavailable: true` instead of an exception.

import { useQuery } from "@tanstack/react-query";
import { useSettings } from "./useSettings.js";

export interface NodePreviewResponse {
  content: string;
  lines: number;
  sessionName: string;
  capturedAt: string;
}

export interface NodePreviewUnavailable {
  unavailable: true;
  reason: string;
  hint?: string;
}

async function fetchNodePreview(
  rigId: string,
  logicalId: string,
  lines: number,
): Promise<NodePreviewResponse | NodePreviewUnavailable> {
  const url = `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/preview?lines=${lines}`;
  const res = await fetch(url);
  // 404 from a daemon without the route OR with no such node → unavailable.
  if (res.status === 404) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable" };
  }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "session_unbound", hint: body.hint };
  }
  if (res.status === 502) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "capture_failed", hint: body.hint };
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NodePreviewResponse;
}

export interface UseNodePreviewOpts {
  rigId: string | null;
  logicalId: string | null;
  /** Override line count; defaults to ui.preview.default_lines. */
  lines?: number;
  /** Pause polling (e.g., when the drawer is collapsed). */
  paused?: boolean;
}

export function useNodePreview(opts: UseNodePreviewOpts) {
  const { data: settings } = useSettings();
  const intervalSeconds = settings?.settings?.["ui.preview.refresh_interval_seconds"]?.value as number | undefined;
  const defaultLines = settings?.settings?.["ui.preview.default_lines"]?.value as number | undefined;
  const lines = opts.lines ?? defaultLines ?? 50;
  const refetchInterval = opts.paused ? false : ((intervalSeconds ?? 3) * 1000);

  return useQuery({
    queryKey: ["node-preview", opts.rigId, opts.logicalId, lines],
    queryFn: () => fetchNodePreview(opts.rigId!, opts.logicalId!, lines),
    enabled: !!opts.rigId && !!opts.logicalId && !opts.paused,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

export function isNodePreviewUnavailable(
  data: NodePreviewResponse | NodePreviewUnavailable | undefined,
): data is NodePreviewUnavailable {
  return Boolean(data && "unavailable" in data);
}

// --- Session-keyed preview (composes with surfaces that have a session
// name but no rigId/logicalId — Loop State panel, Slice Story View
// Topology tab). Same shape; different route. ---

async function fetchSessionPreview(
  sessionName: string,
  lines: number,
): Promise<NodePreviewResponse | NodePreviewUnavailable> {
  const url = `/api/sessions/${encodeURIComponent(sessionName)}/preview?lines=${lines}`;
  const res = await fetch(url);
  if (res.status === 404) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable" };
  }
  if (res.status === 502 || res.status === 503) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NodePreviewResponse;
}

export function useSessionPreview(opts: {
  sessionName: string | null;
  lines?: number;
  paused?: boolean;
}) {
  const { data: settings } = useSettings();
  const intervalSeconds = settings?.settings?.["ui.preview.refresh_interval_seconds"]?.value as number | undefined;
  const defaultLines = settings?.settings?.["ui.preview.default_lines"]?.value as number | undefined;
  const lines = opts.lines ?? defaultLines ?? 50;
  const refetchInterval = opts.paused ? false : ((intervalSeconds ?? 3) * 1000);

  return useQuery({
    queryKey: ["session-preview", opts.sessionName, lines],
    queryFn: () => fetchSessionPreview(opts.sessionName!, lines),
    enabled: !!opts.sessionName && !opts.paused,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}
