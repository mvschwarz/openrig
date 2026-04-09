import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { LibraryReview } from "../src/components/LibraryReview.js";

describe("LibraryReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("service-backed rig shows environment tab with stack details and Copy Setup Prompt copies correct text", async () => {
    let copiedText = "";
    const clipboardMock = { writeText: vi.fn(async (text: string) => { copiedText = text; }) };
    Object.defineProperty(navigator, "clipboard", { value: clipboardMock, writable: true, configurable: true });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/specs/library") && !url.includes("/review")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }

      if (url === "/api/specs/library/svc-rig-1/review") {
        return new Response(JSON.stringify({
          sourceState: "library_item",
          kind: "rig",
          name: "secrets-manager",
          version: "0.2",
          summary: "HashiCorp Vault in dev mode",
          format: "pod_aware",
          pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", runtime: "claude-code" }], edges: [] }],
          edges: [],
          graph: { nodes: [], edges: [] },
          raw: "name: secrets-manager\n",
          libraryEntryId: "svc-rig-1",
          sourcePath: "/specs/rigs/launch/secrets-manager/rig.yaml",
          services: {
            kind: "compose",
            composeFile: "secrets-manager.compose.yaml",
            projectName: "openrig-secrets",
            downPolicy: "down",
            waitFor: [{ url: "http://127.0.0.1:8200/v1/sys/health" }],
            surfaces: {
              urls: [{ name: "Vault UI", url: "http://127.0.0.1:8200/ui" }],
              commands: [{ name: "Vault status", command: "vault status" }],
            },
            composePreview: {
              services: [{ name: "vault", image: "hashicorp/vault:1.15" }],
            },
          },
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(createAppTestRouter({
      initialPath: "/specs/library/svc-rig-1",
      routes: [
        { path: "/specs/library/svc-rig-1", component: () => <LibraryReview entryId="svc-rig-1" /> },
      ],
    }));

    await waitFor(() => {
      expect(screen.getByTestId("library-review-rig")).toBeDefined();
    });

    // Environment tab exists
    expect(screen.getByTestId("lib-tab-environment")).toBeDefined();

    // Tab order: topology, configuration, environment, yaml
    const tabs = screen.getAllByTestId(/^lib-tab-/);
    const tabNames = tabs.map((t) => t.textContent?.toLowerCase());
    expect(tabNames).toEqual(["topology", "configuration", "environment", "yaml"]);

    // Click environment tab and verify stack details
    fireEvent.click(screen.getByTestId("lib-tab-environment"));

    await waitFor(() => {
      // Service name and image from composePreview
      expect(screen.getByText("vault")).toBeDefined();
      expect(screen.getByText("hashicorp/vault:1.15")).toBeDefined();
      // Surface
      expect(screen.getByText("Vault UI")).toBeDefined();
      // Wait target (health gate)
      expect(screen.getByText("http://127.0.0.1:8200/v1/sys/health")).toBeDefined();
    });

    // Copy Setup Prompt button exists and works
    const copyBtn = screen.getByTestId("copy-setup-prompt");
    expect(copyBtn).toBeDefined();

    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(clipboardMock.writeText).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("copy-setup-prompt").textContent).toContain("Copied");

    // Copied text includes app name, summary, and source reference
    expect(copiedText).toContain("secrets-manager");
    expect(copiedText).toContain("HashiCorp Vault in dev mode");
    expect(copiedText).toContain("secrets-manager/rig.yaml");
  });

  it("non-service rig has no environment tab and no setup prompt", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/specs/library") && !url.includes("/review")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }

      if (url === "/api/specs/library/plain-rig/review") {
        return new Response(JSON.stringify({
          sourceState: "library_item",
          kind: "rig",
          name: "demo",
          version: "0.2",
          format: "pod_aware",
          pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", runtime: "claude-code" }], edges: [] }],
          edges: [],
          graph: { nodes: [], edges: [] },
          raw: "name: demo\n",
          libraryEntryId: "plain-rig",
          sourcePath: "/specs/rigs/launch/demo/rig.yaml",
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(createAppTestRouter({
      initialPath: "/specs/library/plain-rig",
      routes: [
        { path: "/specs/library/plain-rig", component: () => <LibraryReview entryId="plain-rig" /> },
      ],
    }));

    await waitFor(() => {
      expect(screen.getByTestId("library-review-rig")).toBeDefined();
    });

    // No environment tab
    expect(screen.queryByTestId("lib-tab-environment")).toBeNull();
    // No setup prompt button
    expect(screen.queryByTestId("copy-setup-prompt")).toBeNull();
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
