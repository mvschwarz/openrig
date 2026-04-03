import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { LibraryReview } from "../src/components/LibraryReview.js";

describe("LibraryReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("opens the matching agent spec from a rig member row", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/specs/library?kind=agent") {
        return new Response(JSON.stringify([
          {
            id: "agent-impl",
            kind: "agent",
            name: "impl",
            version: "1.0",
            sourceType: "builtin",
            sourcePath: "/specs/agents/impl/agent.yaml",
            relativePath: "agents/impl/agent.yaml",
            updatedAt: new Date().toISOString(),
          },
        ]), { status: 200 });
      }

      if (url === "/api/specs/library/rig-impl/review") {
        return new Response(JSON.stringify({
          sourceState: "library_item",
          kind: "rig",
          name: "implementation-pair",
          version: "0.2",
          format: "pod_aware",
          pods: [
            {
              id: "dev",
              label: "Development Pair",
              members: [
                { id: "impl", agentRef: "local:agents/impl", runtime: "claude-code", profile: "default" },
              ],
              edges: [],
            },
          ],
          edges: [],
          graph: { nodes: [], edges: [] },
          raw: 'name: implementation-pair\n',
          libraryEntryId: "rig-impl",
          sourcePath: "/specs/implementation-pair.yaml",
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(createAppTestRouter({
      initialPath: "/specs/library/rig-impl",
      routes: [
        { path: "/specs/library/rig-impl", component: () => <LibraryReview entryId="rig-impl" /> },
        { path: "/specs/library/agent-impl", component: () => <div data-testid="agent-drilldown-route">agent</div> },
      ],
    }));

    await waitFor(() => {
      expect(screen.getByTestId("library-review-rig")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("lib-tab-configuration"));

    await waitFor(() => {
      expect(screen.getByTestId("lib-member-open-agent-dev-impl")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("lib-member-open-agent-dev-impl"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-drilldown-route")).toBeDefined();
    });
  });
});
