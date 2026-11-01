import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";

const style = createStyle("truecolor");
describe("rig presence survives clipping, selection and lifecycle text", () => {
  for (const [cols, rows] of [[80, 24], [140, 42]]) {
    for (const name of ["short", "long-rig-name-with-a-clipped-status-suffix"]) {
      for (const selected of [false, true]) for (const focused of [false, true]) {
        it(`${cols}x${rows} ${name} selected=${selected} focused=${focused}`, () => {
          for (const presence of [true, false, null]) {
            const snap = demoSnapshot();
            snap.hosts = [{ name: "host", reachable: true, rigs: [{ name, hasLiveAgents: presence, lifecycleState: presence === false ? "stopped" : "degraded", pods: [] }] }];
            const view = createViewState({ instanceId: "instance", getSnapshot: () => snap });
            const index = computeExplorerRows(view.get(), snap).findIndex(row => row.key === `rig:host/${name}`);
            const state = { ...view.get(), selection: selected ? index : 0, focusedPane: focused ? "explorer" as const : "content" as const };
            const screen = renderScreen(state, snap, { cols: cols!, rows: rows!, colorMode: "truecolor" });
            const painted = stylizeLines(screen, style);
            painted.forEach((line, i) => expect(stripAnsi(line)).toBe(screen.lines[i]));
            const y = screen.explorerRows.find(row => row.key === `rig:host/${name}`)!.y;
            const glyph = presence === null ? "?" : "▦";
            expect(painted[y - 1]).toContain(style.paint(presence === true ? "bright" : "dim", glyph,
              selected ? { bg: "selection", bold: focused } : {}));
            if (selected) expect(painted[y - 1]).toContain("48;2;34;52;82");
          }
        });
      }
    }
  }

  it("unreachable host overrides stale positive presence with unknown, not stopped", () => {
    const snap = demoSnapshot(); snap.hosts[0]!.reachable = false;
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 42 });
    const y = screen.explorerRows.find(row => row.key === "rig:vm-host/openrig-build")!.y;
    expect(screen.lines[y - 1]).toContain("? openrig-build");
    expect(screen.lines[y - 1]).not.toContain("▦");
  });

  it.each([[80, 24], [140, 42]])("landing at %ix%i keeps instance context and the prompt without repeating the Explorer list", (cols, rows) => {
    const snap = demoSnapshot();
    snap.stream = [];
    snap.hosts[0]!.rigs.push({ name: "stopped-rig", pods: [], hasLiveAgents: false, lifecycleState: "stopped" });
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols, rows });
    const body = screen.lines.map(line => line.slice(screen.explorerWidth + 2)).join("\n");
    expect(body).toContain("TOPOLOGY · vm-host");
    expect(body).toContain("Choose a rig");
    expect(body).toContain("2 rigs");
    expect(body).not.toContain("openrig-build");
    expect(body).not.toContain("stopped-rig");
    expect(view.get().drill).toEqual([]);
    expect(screen.explorerRows.some(row => row.key === "rig:vm-host/stopped-rig")).toBe(true);
  });

  it("passes summary presence through without new per-rig reads on the topology landing", async () => {
    const seen: string[] = [];
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url: string) => {
      const path = new URL(url).pathname; seen.push(path);
      const data = path === "/healthz" ? { selfHostId: "host" } : path === "/api/rigs/summary" ? [
        { id: "live", name: "live", lifecycleState: "degraded", hasLiveAgents: true },
        { id: "stopped", name: "stopped", lifecycleState: "stopped", hasLiveAgents: false },
        { id: "old", name: "older-daemon" },
      ] : [];
      return { ok: true, json: async () => data } as Response;
    }) as typeof fetch });
    const view = createViewState({ instanceId: "t", getSnapshot: demoSnapshot });
    const snap = await hydrateSnapshot(client, new Map(), null, null, null, view.get());
    expect(snap.hosts[0]!.rigs.map(r => [r.name, r.hasLiveAgents])).toEqual([["live", true], ["older-daemon", null], ["stopped", false]]);
    expect(seen.filter(path => path === "/api/rigs/summary")).toHaveLength(1);
    expect(seen.filter(path => /^\/api\/rigs\/[^/]+\//.test(path))).toEqual([]);
  });
});
