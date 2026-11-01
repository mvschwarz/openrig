import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RigOverviewTab } from "../src/components/topology/ScopePages.js";

const host = vi.hoisted(() => ({ id: "local", known: true, error: false }));
vi.mock("../src/hooks/useHosts.js", () => ({
  useSelectedHostId: () => host.id,
  useHosts: () => ({ data: host.known ? { selected: host.id } : undefined, isError: host.error }), useSelectHost: () => ({}), useHostSelection: () => ({}),
}));
// The existing display has its own rendering tests. Keep this test on the
// source-selection contract, with real query hooks and controlled HTTP replies.
vi.mock("../src/components/RigSpecDisplay.js", () => ({
  RigSpecDisplay: ({ yaml }: { yaml: string }) => <pre data-testid="displayed-spec">{yaml}</pre>,
}));

const currentYaml = "version: '1.0.0'\nname: kernel\npods:\n  - id: ops\n    members:\n      - id: operator\n        runtime: claude-code\n";
const templateYaml = currentYaml.replace("claude-code", "codex");
const fetchMock = vi.fn();
const clients: QueryClient[] = [];
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function review(yaml: string) { return { kind: "rig", format: "pod_aware", raw: yaml, name: "kernel", graph: { nodes: [], edges: [] }, edges: [], pods: [] }; }
function install(opts: { entries?: number; status?: number; reviewStatus?: number; yaml?: string } = {}) {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (/\/api\/rigs\/[^/]+\/spec(?:\?|$)/.test(url)) return new Response(opts.yaml ?? currentYaml, { status: opts.status ?? 200 });
    if (url === "/api/specs/review/rig") return json(review(JSON.parse(String(init?.body)).yaml), opts.reviewStatus ?? 200);
    if (/\/api\/specs\/library\/[^/]+\/review/.test(url)) return json(review(templateYaml));
    if (url.includes("/api/specs/library")) return json(Array.from({ length: opts.entries ?? 1 }, (_, i) => ({ id: `template-${i}`, kind: "rig", name: "kernel" })));
    return json({}, 404);
  });
}
function mount(rigId = "kernel-id", rigName = "kernel") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const element = (id: string, name: string) => <QueryClientProvider client={client}><RigOverviewTab rigId={id} rigName={name} /></QueryClientProvider>;
  const view = render(element(rigId, rigName));
  return { ...view, client, change: (id: string, name: string) => view.rerender(element(id, name)) };
}
function exportsMade() { return fetchMock.mock.calls.filter(([url]) => /\/api\/rigs\/[^/]+\/spec(?:\?|$)/.test(String(url))); }
function libraryReads() { return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/specs/library")); }
beforeEach(() => { host.id = "local"; host.known = true; host.error = false; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); for (const c of clients.splice(0)) c.clear(); vi.unstubAllGlobals(); });

describe("#21 running rig Overview uses its current spec, not the library", () => {
  it("shows the configured single-runtime kernel even when the library template is dual-runtime", async () => {
    install(); mount();
    expect((await screen.findByTestId("displayed-spec")).textContent).toBe(currentYaml);
    expect(exportsMade()[0]?.[0]).toBe("/api/rigs/kernel-id/spec");
    expect(libraryReads()).toEqual([]);
  });
  it("shows a project rig with no library entry", async () => {
    install({ entries: 0 }); mount("project-id", "project-team");
    expect((await screen.findByTestId("displayed-spec")).textContent).toBe(currentYaml);
    expect(screen.queryByText("NO RIG SPEC")).toBeNull();
  });
  it("selects by rig ID even if multiple templates share its name", async () => {
    install({ entries: 2 }); mount();
    expect((await screen.findByTestId("displayed-spec")).textContent).toBe(currentYaml);
    expect(libraryReads()).toEqual([]);
  });
  it.each([404, 503])("does not substitute a template after current export HTTP %s", async status => {
    install({ status }); mount();
    await screen.findByText("CURRENT RIG SPEC UNAVAILABLE");
    expect(screen.queryByTestId("displayed-spec")).toBeNull();
    expect(libraryReads()).toEqual([]);
  });
  it("keeps export YAML visible if its topology preview cannot be prepared", async () => {
    install({ reviewStatus: 400 }); mount();
    const yaml = await screen.findByTestId("topology-rig-overview-yaml");
    expect(yaml.textContent).toBe(currentYaml);
    await screen.findByText(/Topology preview unavailable/);
    expect(libraryReads()).toEqual([]);
  });
  it("clears the previous rig while the next export loads", async () => {
    install(); const defaultFetch = fetchMock.getMockImplementation()!;
    let release!: (response: Response) => void;
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => String(input).includes("/api/rigs/next-id/spec")
      ? new Promise<Response>(resolve => { release = resolve; }) : defaultFetch(input, init));
    const view = mount(); await screen.findByTestId("displayed-spec");
    view.change("next-id", "next-rig");
    await waitFor(() => expect(exportsMade()).toHaveLength(2));
    expect(screen.queryByTestId("displayed-spec")).toBeNull();
    release(new Response("name: next-rig\nnodes: []\n"));
    expect((await screen.findByTestId("displayed-spec")).textContent).toContain("next-rig");
  });
  it("aborts an obsolete export and cannot display its late response under a new rig", async () => {
    install(); const defaultFetch = fetchMock.getMockImplementation()!;
    let oldSignal: AbortSignal | undefined;
    let release!: (response: Response) => void;
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/rigs/kernel-id/spec") {
        oldSignal = init?.signal as AbortSignal;
        return new Promise<Response>(resolve => { release = resolve; });
      }
      if (String(input) === "/api/rigs/next-id/spec") return Promise.resolve(new Response("name: newest-rig\nnodes: []\n"));
      return defaultFetch(input, init);
    });
    const view = mount(); await waitFor(() => expect(exportsMade()).toHaveLength(1));
    view.change("next-id", "newest-rig");
    expect((await screen.findByTestId("displayed-spec")).textContent).toContain("newest-rig");
    expect(oldSignal?.aborted).toBe(true);
    release(new Response(currentYaml));
    await waitFor(() => expect(screen.getByTestId("displayed-spec").textContent).not.toContain("claude-code"));
  });
  it("does not read a local rig before host selection is known", async () => {
    host.known = false; install(); const view = mount();
    expect(screen.getByText("Loading current rig spec…")).toBeTruthy();
    expect(exportsMade()).toEqual([]);
    host.known = true; host.id = "remote-a"; view.change("kernel-id", "kernel");
    await screen.findByText("CURRENT RIG SPEC UNAVAILABLE");
    expect(exportsMade()).toEqual([]);
  });
  it("reports an unavailable host selection without reading local configuration", async () => {
    host.known = false; host.error = true; install(); mount();
    await screen.findByText("CURRENT RIG SPEC UNAVAILABLE");
    expect(exportsMade()).toEqual([]);
  });
  it("does not read local configuration when the selected remote spec route is unavailable", async () => {
    host.id = "remote-a"; install({ status: 403 }); mount();
    await screen.findByText("CURRENT RIG SPEC UNAVAILABLE");
    expect(exportsMade()).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/specs/review/rig")).toBe(false);
    expect(libraryReads()).toEqual([]);
  });
  it("refreshes through the existing per-rig invalidation used by mutations and events", async () => {
    install(); const view = mount(); await screen.findByTestId("displayed-spec");
    install({ yaml: currentYaml.replace("claude-code", "terminal") });
    await view.client.invalidateQueries({ queryKey: ["rig", "kernel-id"] });
    await waitFor(() => expect(screen.getByTestId("displayed-spec").textContent).toContain("runtime: terminal"));
  });
  it("drops previous host data immediately on host change", async () => {
    install(); const view = mount(); await screen.findByTestId("displayed-spec");
    host.id = "remote-b"; install({ status: 403 }); view.change("kernel-id", "kernel");
    await screen.findByText("CURRENT RIG SPEC UNAVAILABLE");
    expect(screen.queryByTestId("displayed-spec")).toBeNull();
    expect(exportsMade().map(([url]) => url)).toEqual(["/api/rigs/kernel-id/spec"]);
  });
});
