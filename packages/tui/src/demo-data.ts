// Demo fixture (clearly labeled): the shape the §4.A reads hydrate, with stub
// values for tests + `openrig-tui --demo` manual runs. Never used unless
// --demo is passed; the real path is the daemon reads (Phase 2 binding).
import type { FleetSnapshot } from "./types.js";

export function demoSnapshot(): FleetSnapshot {
  return {
    hosts: [
      {
        name: "vm-host",
        reachable: true,
        rigs: [
          {
            name: "openrig-build",
            pods: [
              {
                name: "dev50",
                agents: [
                  { name: "dev50.driver", runtime: "claude-code", spec: "driver-agent", context: 62, tokens: "118k", status: "running" },
                  { name: "dev50.guard", runtime: "codex", spec: "guard-agent", context: 31, tokens: "54k", status: "idle" },
                  { name: "dev50.qa", runtime: "codex", spec: "qa-agent", context: null, tokens: null, status: "unknown" },
                ],
              },
              {
                name: "orch",
                agents: [
                  { name: "orch.lead", runtime: "codex", spec: "lead-agent", context: 88, tokens: "203k", status: "needs-attention" },
                ],
              },
            ],
          },
        ],
      },
      { name: "mm2-host", reachable: false, rigs: [] },
    ],
    specs: [
      { name: "openrig-build-rig", kind: "rig", agentRefs: ["driver-agent", "guard-agent", "qa-agent", "lead-agent"] },
      { name: "driver-agent", kind: "agent", runtime: "claude-code", usedByRigs: ["openrig-build-rig"] },
      { name: "guard-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
      { name: "qa-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
      { name: "lead-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
    ],
    needs: [
      { kind: "idle-with-work", target: "dev50.guard", detail: "assigned work, idle 42m" },
      { kind: "host-down", target: "mm2-host", detail: "unreachable 12m" },
    ],
    humanQueueProbed: true,
    humanQueue: [],
  };
}
