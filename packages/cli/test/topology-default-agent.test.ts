import { describe, expect, it } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { resolveDefaultAgentRef } from "../src/commands/topology-default-agent.js";

describe("default agent lookup", () => {
  it("finds the built-in orchestrator when inventory hides built-ins", async () => {
    const client = {
      get: async (url: string) => ({
        data: url.includes("include_builtins=true")
          ? [{ kind: "agent", name: "orchestrator", sourceType: "builtin", sourcePath: "/builtin/orchestrator/agent.yaml" }]
          : [],
      }),
    } as unknown as DaemonClient;
    expect(await resolveDefaultAgentRef(client, "codex")).toBe("path:/builtin/orchestrator");
  });
});
