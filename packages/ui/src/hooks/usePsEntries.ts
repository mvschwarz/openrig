import { useQuery } from "@tanstack/react-query";

export interface PsEntry {
  rigId: string;
  name: string;
  nodeCount: number;
  /** Process-alive count (legacy; unchanged semantics). */
  runningCount: number;
  /**
   * Slice 15 — terminal-active count: subset of nodes producing tmux
   * output within the silence window. Sourced from the daemon's
   * SeatActivityService. UI active stats (e.g., Dashboard "Active")
   * read this instead of runningCount.
   */
  activeCount?: number;
  /**
   * Slice 15 — has-work count: subset of nodes with at least one
   * pending qitem assigned to their canonical session name. Rendered
   * distinctly from activeCount (non-inference contract).
   */
  hasWorkCount?: number;
  status: "running" | "partial" | "stopped";
  uptime: string | null;
  latestSnapshot: string | null;
}

async function fetchPsEntries(): Promise<PsEntry[]> {
  const res = await fetch("/api/ps");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function usePsEntries() {
  return useQuery({
    queryKey: ["ps"],
    queryFn: fetchPsEntries,
    refetchInterval: 3_000,
  });
}
