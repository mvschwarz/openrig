// The CLI keeps its existing configured legacy-root default and delegates every path/read decision to the shared trace.
import { traceTopologyChain as sharedTrace, type TopologyTraceInput, type TraceResult } from "@openrig/daemon/topology-trace";
import { resolveLegacyTopologyRigsRoot } from "../config-store.js";
export type { TraceAltitude, TraceLevel, TraceResult, TraceFs } from "@openrig/daemon/topology-trace";

export function traceTopologyChain(input: Omit<TopologyTraceInput, "legacyRigsRoot"> & { legacyRigsRoot?: string }): TraceResult {
  return sharedTrace({ ...input, legacyRigsRoot: input.legacyRigsRoot ?? resolveLegacyTopologyRigsRoot() });
}
