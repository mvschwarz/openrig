// V1 attempt-3 Phase 4 — useCmuxLaunch.
//
// Thin wrapper around the existing daemon focus endpoint
// `POST /api/rigs/:rigId/nodes/:logicalId/focus` (shipped pre-Phase-2
// per architecture.md L88). No new endpoint; SC-29 honored.
// Returns a launch function that posts focus to a seat — daemon
// dispatches cmux focus-surface command to bring the seat to the
// foreground.

import { useMutation } from "@tanstack/react-query";

interface FocusInput {
  rigId: string;
  logicalId: string;
}

async function postFocus({ rigId, logicalId }: FocusInput): Promise<{ ok: boolean }> {
  const res = await fetch(
    `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/focus`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useCmuxLaunch() {
  return useMutation({
    mutationFn: postFocus,
  });
}
