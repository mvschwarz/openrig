// V1 attempt-3 Phase 4 — useCmuxLaunch.
//
// Thin wrapper around the daemon open-or-focus endpoint.
// `POST /api/rigs/:rigId/nodes/:logicalId/open-cmux` creates a cmux
// surface when the node is not already bound, and focuses the existing
// surface when it is.

import { useMutation } from "@tanstack/react-query";

interface CmuxLaunchInput {
  rigId: string;
  logicalId: string;
}

interface OpenCmuxResult {
  ok?: boolean;
  action?: string;
  code?: string;
  error?: string;
  message?: string;
}

async function postOpenCmux({ rigId, logicalId }: CmuxLaunchInput): Promise<OpenCmuxResult> {
  const res = await fetch(
    `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/open-cmux`,
    { method: "POST" },
  );
  const body = (await res.json().catch(() => null)) as OpenCmuxResult | null;
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.message ?? body?.error ?? body?.code ?? `HTTP ${res.status}`);
  }
  return body ?? { ok: true };
}

export function useCmuxLaunch() {
  return useMutation({
    mutationFn: postOpenCmux,
  });
}
