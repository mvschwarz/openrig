// Slice 24 — useRigCmuxLaunch.
//
// Mutation hook that POSTs to /api/rigs/:rigId/cmux/launch (the new
// daemon endpoint shipped in slice 24 Checkpoint C). Returns the
// workspaces array from the daemon's response on success; throws an
// Error carrying the daemon's honest 3-part message on 4xx/5xx.
//
// Distinct from the existing useCmuxLaunch.ts which targets the
// per-NODE focus endpoint POST /api/rigs/:rigId/nodes/:logicalId/focus.

import { useMutation } from "@tanstack/react-query";

export interface RigCmuxLaunchInput {
  rigId: string;
}

export interface CmuxLaunchedWorkspace {
  name: string;
  agents: string[];
  blanks: number;
}

export interface RigCmuxLaunchSuccess {
  ok: true;
  workspaces: CmuxLaunchedWorkspace[];
}

interface RigCmuxLaunchErrorBody {
  error: string;
  message: string;
  partial?: CmuxLaunchedWorkspace[];
}

async function postRigCmuxLaunch({ rigId }: RigCmuxLaunchInput): Promise<RigCmuxLaunchSuccess> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/cmux/launch`, {
    method: "POST",
  });
  if (!res.ok) {
    let body: RigCmuxLaunchErrorBody | null = null;
    try {
      body = (await res.json()) as RigCmuxLaunchErrorBody;
    } catch {
      // fall through
    }
    const message = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return (await res.json()) as RigCmuxLaunchSuccess;
}

export function useRigCmuxLaunch() {
  return useMutation<RigCmuxLaunchSuccess, Error, RigCmuxLaunchInput>({
    mutationFn: postRigCmuxLaunch,
  });
}
