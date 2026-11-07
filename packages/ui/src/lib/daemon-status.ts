// C10: the Dashboard daemon tile mapping, extracted so C15 (Getting
// started) reuses the exact same verdict.
import type { UseQueryResult } from "@tanstack/react-query";
import type { DaemonHealthPayload, DaemonHealthSignal } from "../hooks/useDaemonHealth.js";

export function daemonStatus(
  query: Pick<UseQueryResult<DaemonHealthPayload>, "isError" | "isSuccess">,
  signal: Pick<DaemonHealthSignal, "controlPlaneUnhealthy">,
): { status: string; label: string } {
  if (query.isError) return { status: "error", label: "Offline" };
  if (signal.controlPlaneUnhealthy) return { status: "degraded", label: "Degraded" };
  if (query.isSuccess) return { status: "ready", label: "Healthy" };
  return { status: "unknown", label: "Checking" };
}
