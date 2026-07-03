// OPR.0.4.3.21 — mounts the single daemon-health poll and publishes the derived
// signal on DaemonHealthContext so any FocusedTerminal below can disambiguate a
// generic "terminal broker unavailable" close from a genuinely unhealthy
// control plane. Placed under QueryClientProvider at the app root.

import type { ReactNode } from "react";
import { DaemonHealthContext, useDaemonHealth } from "../hooks/useDaemonHealth.js";

export function DaemonHealthProvider({ children }: { children: ReactNode }) {
  const { signal } = useDaemonHealth();
  return <DaemonHealthContext.Provider value={signal}>{children}</DaemonHealthContext.Provider>;
}
