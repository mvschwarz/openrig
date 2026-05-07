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
          summary: "HashiCorp Vault in dev mode with a dedicated Vault specialist agent",
          format: "pod_aware",
          pods: [{ id: "vault", label: "Vault", members: [{ id: "specialist", agentRef: "local:agents/apps/vault-specialist", runtime: "claude-code" }], edges: [] }],
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

    // Specialist card shows canonical identity
    const specialistCard = screen.getByTestId("lib-rig-specialist");
    expect(specialistCard).toBeDefined();
    expect(specialistCard.textContent).toContain("vault.specialist");

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
    // No specialist card
    expect(screen.queryByTestId("lib-rig-specialist")).toBeNull();
  });

  it("opens agent drilldown for relative local: refs resolved against rig source path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/specs/library?kind=agent") {
        return new Response(JSON.stringify([
          {
            id: "agent-vault-specialist",
            kind: "agent",
            name: "vault-specialist",
            version: "1.0",
            sourceType: "builtin",
            sourcePath: "/specs/agents/apps/vault-specialist/agent.yaml",
            relativePath: "agents/apps/vault-specialist/agent.yaml",
            updatedAt: new Date().toISOString(),
          },
        ]), { status: 200 });
      }

      if (url === "/api/specs/library/svc-rig-2/review") {
        return new Response(JSON.stringify({
          sourceState: "library_item",
          kind: "rig",
          name: "secrets-manager",
          version: "0.2",
          format: "pod_aware",
          pods: [
            {
              id: "vault",
              label: "Vault",
              members: [
                { id: "specialist", agentRef: "local:../../../agents/apps/vault-specialist", runtime: "claude-code", profile: "default" },
              ],
              edges: [],
            },
          ],
          edges: [],
          graph: { nodes: [], edges: [] },
          raw: "name: secrets-manager\n",
          libraryEntryId: "svc-rig-2",
          sourcePath: "/specs/rigs/launch/secrets-manager/rig.yaml",
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(createAppTestRouter({
      initialPath: "/specs/library/svc-rig-2",
      routes: [
        { path: "/specs/library/svc-rig-2", component: () => <LibraryReview entryId="svc-rig-2" /> },
        { path: "/specs/library/agent-vault-specialist", component: () => <div data-testid="vault-agent-drilldown">vault-agent</div> },
      ],
    }));

    await waitFor(() => {
      expect(screen.getByTestId("library-review-rig")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("lib-tab-configuration"));

    await waitFor(() => {
      expect(screen.getByTestId("lib-member-open-agent-vault-specialist")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("lib-member-open-agent-vault-specialist"));

    await waitFor(() => {
      expect(screen.getByTestId("vault-agent-drilldown")).toBeDefined();
    });
  });

  it("renders workflow review with topology graph + steps + Activate as Lens (Workflows in Spec Library v0)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/specs/library/active-lens" && (!init || !init.method || init.method === "GET")) {
        return new Response(JSON.stringify({ activeLens: null }), { status: 200 });
      }
      if (url === "/api/specs/library/active-lens" && init?.method === "POST") {
        return new Response(JSON.stringify({
          activeLens: { specName: "rsi-v2-hot-potato", specVersion: "1", activatedAt: "2026-05-04T00:00:00Z" },
        }), { status: 200 });
      }

      const decoded = decodeURIComponent(url);
      if (decoded === "/api/specs/library/workflow:rsi-v2-hot-potato:1/review") {
        return new Response(JSON.stringify({
          kind: "workflow",
          libraryEntryId: "workflow:rsi-v2-hot-potato:1",
          name: "rsi-v2-hot-potato",
          version: "1",
          purpose: "Hot-potato workflow for RSI",
          targetRig: null,
          terminalTurnRule: "hot_potato",
          rolesCount: 2,
          stepsCount: 2,
          isBuiltIn: true,
          sourcePath: "/builtins/workflow-specs/rsi-v2-hot-potato.yaml",
          cachedAt: "2026-05-04T00:00:00Z",
          topology: {
            nodes: [
              { stepId: "step-1", role: "alpha", objective: "Start", preferredTarget: "alpha@rig", isEntry: true, isTerminal: false },
              { stepId: "step-2", role: "beta", objective: "End", preferredTarget: null, isEntry: false, isTerminal: true },
            ],
            edges: [{ fromStepId: "step-1", toStepId: "step-2", routingType: "direct" }],
          },
          steps: [
            { stepId: "step-1", role: "alpha", objective: "Start", allowedExits: ["handoff"], allowedNextSteps: [{ stepId: "step-2", role: "beta" }] },
            { stepId: "step-2", role: "beta", objective: "End", allowedExits: ["done"], allowedNextSteps: [] },
          ],
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url} (method=${init?.method ?? "GET"})`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createAppTestRouter({
      initialPath: "/specs/library/workflow:rsi-v2-hot-potato:1",
      routes: [
        { path: "/specs/library/workflow:rsi-v2-hot-potato:1", component: () => <LibraryReview entryId="workflow:rsi-v2-hot-potato:1" /> },
        { path: "/specs", component: () => <div data-testid="back-route">back</div> },
      ],
    }));

    await waitFor(() => {
      expect(screen.getByTestId("library-review-workflow")).toBeDefined();
    });

    expect(screen.getByText("rsi-v2-hot-potato v1")).toBeDefined();
    expect(screen.getByText("Hot-potato workflow for RSI")).toBeDefined();
    expect(screen.getByTestId("workflow-topology-graph")).toBeDefined();
    expect(screen.getByTestId("workflow-step-step-1")).toBeDefined();
    expect(screen.getByTestId("workflow-step-step-2")).toBeDefined();

    const terminal = screen.getByTestId("workflow-terminal-rule");
    expect(terminal.textContent).toContain("hot_potato");

    const activateBtn = screen.getByTestId("workflow-activate-lens");
    expect(activateBtn).toBeDefined();
    fireEvent.click(activateBtn);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) =>
        String(call[0]) === "/api/specs/library/active-lens"
        && (call[1] as RequestInit | undefined)?.method === "POST",
      )).toBe(true);
    });
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

  // --- PL-014: context-pack review variant ---

  it("renders the context-pack review variant for context-pack:* ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/context-packs/library") {
        return new Response(JSON.stringify([
          {
            id: "context-pack:pl-005-priming:1",
            kind: "context-pack",
            name: "pl-005-priming",
            version: "1",
            purpose: "Priming for PL-005 Phase A review.",
            sourceType: "user_file",
            sourcePath: "/home/op/.openrig/context-packs/pl-005-priming",
            relativePath: "pl-005-priming",
            updatedAt: "2026-05-04T00:00:00Z",
            manifestEstimatedTokens: null,
            derivedEstimatedTokens: 800,
            files: [
              { path: "prd.md", role: "prd", summary: "PRD", absolutePath: "/abs/prd.md", bytes: 200, estimatedTokens: 50 },
              { path: "missing.md", role: "proof", summary: null, absolutePath: null, bytes: null, estimatedTokens: null },
            ],
          },
        ]), { status: 200 });
      }
      if (url === "/api/context-packs/library/context-pack%3Apl-005-priming%3A1/preview") {
        return new Response(JSON.stringify({
          id: "context-pack:pl-005-priming:1",
          name: "pl-005-priming",
          version: "1",
          bundleText: "# OpenRig Context Pack: pl-005-priming v1\n\nPRD body\n",
          bundleBytes: 60,
          estimatedTokens: 15,
          files: [{ path: "prd.md", role: "prd", bytes: 200, estimatedTokens: 50 }],
          missingFiles: [{ path: "missing.md", role: "proof" }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createAppTestRouter({
      initialPath: "/specs/library/context-pack:pl-005-priming:1",
      routes: [
        { path: "/specs/library/context-pack:pl-005-priming:1", component: () => <LibraryReview entryId="context-pack:pl-005-priming:1" /> },
      ],
    }));

    await waitFor(() => expect(screen.getByTestId("library-review-context-pack")).toBeDefined());
    expect(screen.getByText("pl-005-priming")).toBeDefined();
    expect(screen.getByTestId("lib-pack-version").textContent).toContain("1");
    expect(screen.getByTestId("lib-pack-files").textContent).toContain("2");
    // Per-file row with role + size
    const present = screen.getByTestId("lib-pack-file-prd.md");
    expect(present.textContent).toContain("role: prd");
    expect(present.textContent).toContain("200B");
    // Missing file rendered with MISSING marker + data-missing flag
    const missing = screen.getByTestId("lib-pack-file-missing.md");
    expect(missing.getAttribute("data-missing")).toBe("true");
    expect(missing.textContent).toContain("MISSING");
    // Bundle preview present + missing-file warning (preview is a
    // separate query; wait for it to resolve)
    await waitFor(() => expect(screen.getByTestId("lib-pack-bundle-text")).toBeDefined());
    expect(screen.getByTestId("lib-pack-bundle-text").textContent).toContain("PRD body");
    expect(screen.getByTestId("lib-pack-missing-warning")).toBeDefined();
  });

  it("Send-to-seat modal opens on click and shows running sessions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/context-packs/library") {
        return new Response(JSON.stringify([
          {
            id: "context-pack:test:1",
            kind: "context-pack",
            name: "test",
            version: "1",
            purpose: null,
            sourceType: "user_file",
            sourcePath: "/x/test",
            relativePath: "test",
            updatedAt: "2026-05-04T00:00:00Z",
            manifestEstimatedTokens: null,
            derivedEstimatedTokens: 50,
            files: [{ path: "a.md", role: "r", summary: null, absolutePath: "/abs/a.md", bytes: 30, estimatedTokens: 8 }],
          },
        ]), { status: 200 });
      }
      if (url.endsWith("/preview")) {
        return new Response(JSON.stringify({
          id: "context-pack:test:1", name: "test", version: "1",
          bundleText: "ok", bundleBytes: 2, estimatedTokens: 1,
          files: [], missingFiles: [],
        }), { status: 200 });
      }
      if (url === "/api/mission-control/destinations") {
        return new Response(JSON.stringify({
          destinations: [
            { sessionName: "driver@demo", label: "driver", source: "topology", status: "running" },
            { sessionName: "qa@demo", label: "qa", source: "topology", status: "running" },
            { sessionName: "stopped@demo", label: "stopped", source: "topology", status: "exited" },
          ],
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createAppTestRouter({
      initialPath: "/specs/library/context-pack:test:1",
      routes: [
        { path: "/specs/library/context-pack:test:1", component: () => <LibraryReview entryId="context-pack:test:1" /> },
      ],
    }));

    await waitFor(() => expect(screen.getByTestId("context-pack-send-button")).toBeDefined());
    fireEvent.click(screen.getByTestId("context-pack-send-button"));
    await waitFor(() => expect(screen.getByTestId("context-pack-send-modal")).toBeDefined());
    const select = screen.getByTestId("context-pack-send-session") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("driver@demo");
    expect(options).toContain("qa@demo");
    // Stopped session not surfaced (only sessionStatus === "running")
    expect(options).not.toContain("stopped@demo");
  });
});
