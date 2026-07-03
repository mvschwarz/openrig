// OPR.0.4.3.22 — kernel status (GET /api/kernel/status).
//
// Kernel health comes from the kernel-boot tracker surface, NEVER inferred from
// the daemon /healthz check (guard 4). Returns the tracker envelope on 200, or a
// 503 `kernel_boot_tracker_unavailable` shape when the tracker is unwired — the
// UI renders that as `unknown`, never green.

import { useQuery } from "@tanstack/react-query";

export type KernelState =
  | "skipped"
  | "auth_blocked"
  | "spec_missing"
  | "booting"
  | "partial_ready"
  | "ready"
  | "bootstrap_failed"
  | "degraded";

export interface KernelStatusAgent {
  session_name: string;
  runtime: string;
  startup_status: "pending" | "ready" | "attention_required" | "failed";
}

export interface KernelStatus {
  kernel_state: KernelState;
  agents: KernelStatusAgent[];
  first_unready_since: string | null;
  variant: string | null;
  detail: string | null;
}

/** 503 shape — the tracker is not wired into this daemon. */
export interface KernelStatusUnavailable {
  error: "kernel_boot_tracker_unavailable";
  message: string;
}

export type KernelStatusResult = KernelStatus | KernelStatusUnavailable;

export function isKernelUnavailable(r: KernelStatusResult | undefined): r is KernelStatusUnavailable {
  return !!r && "error" in r;
}

async function fetchKernelStatus(): Promise<KernelStatusResult> {
  const res = await fetch("/api/kernel/status");
  // 503 returns a valid JSON envelope (tracker unavailable) — consume it, don't throw.
  if (res.status === 503) return res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useKernelStatus() {
  return useQuery({
    queryKey: ["kernel", "status"],
    queryFn: fetchKernelStatus,
    refetchInterval: 10_000,
  });
}
