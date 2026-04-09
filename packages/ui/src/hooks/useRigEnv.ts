import { useQuery } from "@tanstack/react-query";

export interface RigEnvData {
  ok: boolean;
  hasServices: boolean;
  kind?: "compose";
  composeFile?: string;
  projectName?: string;
  receipt?: {
    kind: "compose";
    composeFile: string;
    projectName: string;
    services: Array<{ name: string; status: string; health?: string | null }>;
    waitFor: Array<{ target: Record<string, unknown>; status: string; detail?: string | null }>;
    capturedAt: string;
  };
  surfaces?: {
    urls?: Array<{ name: string; url: string }>;
    commands?: Array<{ name: string; command: string }>;
  };
}

async function fetchRigEnv(rigId: string): Promise<RigEnvData> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/env`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigEnv(rigId: string) {
  return useQuery({
    queryKey: ["rig-env", rigId],
    queryFn: () => fetchRigEnv(rigId),
    refetchInterval: 10_000,
  });
}
