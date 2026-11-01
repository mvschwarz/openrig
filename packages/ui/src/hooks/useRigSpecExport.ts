import { useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useHosts } from "./useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";

/** Read this rig's current stored configuration, never a same-named library template. */
export function useRigSpecExport(rigId: string) {
  const hosts = useHosts();
  const hostId = hosts.data?.selected;
  const result = useQuery({
    queryKey: ["rig", rigId, "spec-export", hostId],
    enabled: hostId === LOCAL_HOST_ID,
    queryFn: async ({ signal }) => {
      const res = await fetch(withHostParam(`/api/rigs/${encodeURIComponent(rigId)}/spec`, hostId), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    // No previous-data placeholder: another host/rig must not lend its configuration.
  });
  return { ...result, hostSelection: hosts.isError ? "unavailable" as const : !hosts.data ? "loading" as const
    : hostId === LOCAL_HOST_ID ? "local" as const : "remote" as const };
}
