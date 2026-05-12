// Slice 24 — useRigCmuxLaunch.
//
// Stateful hook that POSTs to /api/rigs/:rigId/cmux/launch (the new
// daemon endpoint shipped in slice 24 Checkpoint C). Returns the
// workspaces array from the daemon's response on success; throws an
// Error carrying the daemon's honest 3-part message on 4xx/5xx.
//
// Distinct from useCmuxLaunch.ts which targets a single node's
// open-or-focus endpoint POST /api/rigs/:rigId/nodes/:logicalId/open-cmux.

import { useCallback, useState } from "react";

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

type RigCmuxLaunchState =
  | { status: "idle"; data?: undefined; error?: undefined }
  | { status: "pending"; data?: undefined; error?: undefined }
  | { status: "success"; data: RigCmuxLaunchSuccess; error?: undefined }
  | { status: "error"; data?: undefined; error: Error };

interface RigCmuxLaunchErrorBody {
  error: string;
  message: string;
  partial?: CmuxLaunchedWorkspace[];
}

export async function launchRigCmux({ rigId }: RigCmuxLaunchInput): Promise<RigCmuxLaunchSuccess> {
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
  const [state, setState] = useState<RigCmuxLaunchState>({ status: "idle" });

  const mutateAsync = useCallback(async (input: RigCmuxLaunchInput) => {
    setState({ status: "pending" });
    try {
      const data = await launchRigCmux(input);
      setState({ status: "success", data });
      return data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setState({ status: "error", error });
      throw error;
    }
  }, []);

  return {
    mutateAsync,
    isPending: state.status === "pending",
    isSuccess: state.status === "success",
    isError: state.status === "error",
    data: state.status === "success" ? state.data : undefined,
    error: state.status === "error" ? state.error : undefined,
  };
}
