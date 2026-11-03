import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

vi.mock("@tanstack/react-router", async (importActual) => ({
  ...await importActual<typeof import("@tanstack/react-router")>(),
  useNavigate: () => vi.fn(),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("settles after filtering, clearing and sorting a populated table", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes("/api/rigs/summary") ? [{ id: "demo", name: "demo" }]
      : url.includes("/api/rigs/demo/nodes") ? ["lead", "builder"].map(name => ({
        logicalId: `main.${name}`, canonicalSessionName: `${name}@demo`,
        runtime: "terminal", sessionStatus: "running", podNamespace: "main",
      })) : [],
  ))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let commits = 0;
  render(<QueryClientProvider client={client}><Profiler id="table" onRender={() => {
    // Bound a runaway loop so this regression fails instead of hanging the test worker.
    if (++commits > 40) throw new Error("Table did not settle within 40 commits");
  }}><TopologyTableView /></Profiler></QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByTestId(/^topology-table-row-/)).toHaveLength(2));
  const search = screen.getByTestId("topology-table-search");
  for (const [value, count] of [["l", 2], ["lead", 1], ["missing", 0], ["", 2]] as const) {
    await act(async () => {
      fireEvent.change(search, { target: { value } });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.queryAllByTestId(/^topology-table-row-/)).toHaveLength(count);
  }
  await act(async () => {
    fireEvent.change(search, { target: { value: "lead" } });
    fireEvent.click(screen.getAllByRole("columnheader")[0]!);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(screen.getAllByTestId(/^topology-table-row-/)).toHaveLength(1);
  expect(commits).toBeLessThan(40);
  client.clear();
});
