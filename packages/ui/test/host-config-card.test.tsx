// OPR.0.4.6.MH1 FR-5 — the dashboard host-config component: one registry
// two surfaces, one selection store two surfaces, honest empty state,
// rename = the settings write path (FR-4).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HostConfigCard } from "../src/components/dashboard/HostConfigCard.js";

const mutateAsync = vi.fn(async () => ({}));

let settingsData: Record<string, { value: unknown }> = {};
let hostsData: { ownName: string; selected: string; hosts: unknown[] } = { ownName: "localhost", selected: "local", hosts: [] };

vi.mock("../src/hooks/useSettings.js", () => ({
  useSettings: () => ({ data: { settings: settingsData } }),
  useSetSetting: () => ({ mutateAsync }),
}));

vi.mock("../src/hooks/useHosts.js", () => ({
  useHosts: () => ({ data: hostsData, error: null }),
  usePairHost: () => ({ mutateAsync: vi.fn(), data: undefined, error: null, isPending: false, reset: vi.fn() }),
  usePairPoll: () => ({ data: undefined }),
}));

describe("HostConfigCard (OPR.0.4.6.MH1 FR-5)", () => {
  beforeEach(() => {
    mutateAsync.mockClear();
    settingsData = {};
    hostsData = { ownName: "localhost", selected: "local", hosts: [] };
  });

  // This project's vitest setup has no RTL auto-cleanup (no test globals);
  // without this, containers accumulate and any testid every render
  // carries (host-own-name) throws multiple-match on the second query.
  afterEach(() => cleanup());

  it("zero added hosts: own-host card + honest empty state + the add affordance (never blank)", () => {
    render(<HostConfigCard />);
    expect(screen.getByTestId("host-own-name").textContent).toBe("localhost");
    expect(screen.getByTestId("host-config-empty")).toBeTruthy();
    expect(screen.getByTestId("host-pair-input")).toBeTruthy();
    expect(screen.getByTestId("host-selected-marker-local")).toBeTruthy();
  });

  it("renders registry rows with address, transport, status and the selected marker", () => {
    settingsData = { "host.selected": { value: "vps-a" } };
    hostsData = {
      ownName: "localhost",
      selected: "vps-a",
      hosts: [
        { id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: true, status: "reachable" },
        { id: "vm-b", transport: "ssh", target: "vm-b.local", selected: false, status: "unreachable" },
      ],
    };
    render(<HostConfigCard />);
    const rows = screen.getByTestId("host-config-rows");
    expect(rows.textContent).toContain("vps-a");
    expect(rows.textContent).toContain("http://vps-a:7433");
    expect(rows.textContent).toContain("vm-b.local");
    expect(rows.textContent).toContain("unreachable");
    expect(screen.getByTestId("host-selected-marker-vps-a")).toBeTruthy();
    // The selection banner renders the honest non-local state (the FR-5
    // disposition: pointer + selection rendering, no UI data retarget).
    expect(screen.getByTestId("host-selection-banner").textContent).toContain("vps-a");
  });

  it("the switcher writes host.selected through the ONE settings store", () => {
    hostsData = {
      ownName: "localhost",
      selected: "local",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: false, status: "reachable" }],
    };
    render(<HostConfigCard />);
    fireEvent.click(screen.getByTestId("host-select-vps-a"));
    expect(mutateAsync).toHaveBeenCalledWith({ key: "host.selected", value: "vps-a" });
  });

  it("rename writes host.name through the settings store (FR-4, one stored name)", () => {
    settingsData = { "host.name": { value: "Mac mini 2" } };
    render(<HostConfigCard />);
    expect(screen.getByTestId("host-own-name").textContent).toBe("Mac mini 2");
    fireEvent.click(screen.getByTestId("host-rename-button"));
    const input = screen.getByTestId("host-rename-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Studio M4" } });
    fireEvent.submit(input.closest("form")!);
    expect(mutateAsync).toHaveBeenCalledWith({ key: "host.name", value: "Studio M4" });
  });
});
