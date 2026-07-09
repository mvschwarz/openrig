// @vitest-environment jsdom

// OPR.0.4.4.22 — the AGENTS altitude page: bands render from the composed
// rig root, grouping is page-level arrangement in the one shared component,
// anchored zoom filters by slice, approve stays slice-terminal (hidden here),
// and empty/error states are honest.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { RigAgentsPage } from "../src/components/review/RigAgentsPage.js";
import { AgentsBandView } from "../src/components/review/AgentsBandView.js";
import { NeedsYouAccordion } from "../src/components/review/NeedsYouAccordion.js";
import type { ComposedRigAgents, AgentsBand, NeedsYouBand } from "../src/hooks/useReview.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: () => <div data-testid="mock-terminal" />,
}));

vi.mock("../src/components/drawer-triggers/FileReferenceTrigger.js", () => ({ FileReferenceTrigger: () => null }));
vi.mock("../src/components/project/ArtifactsNavigator.js", () => ({ ArtifactsNavigator: () => null }));
vi.mock("../src/components/project/Lightbox.js", () => ({ Lightbox: () => null }));
vi.mock("../src/hooks/useFiles.js", () => ({ fileAssetUrl: () => "" }));

const NOW = "2026-07-04T18:00:00.000Z";

function band(overrides: Partial<AgentsBand> = {}): AgentsBand {
  return {
    scope: "rig",
    rows: [
      {
        agentName: "driver1",
        runtime: "claude-code",
        stateGlyph: "active",
        doing: "building the follow-mode half",
        holdsCount: 1,
        lastTransitionIso: NOW,
        exception: null,
        sessionName: "dev44-driver1@openrig-delivery",
        slices: ["19-signal"],
      },
      {
        agentName: "qa1",
        runtime: "codex",
        stateGlyph: "unknown",
        doing: "no tracked work item",
        holdsCount: 0,
        lastTransitionIso: NOW,
        exception: null,
        sessionName: "dev44-qa1@openrig-delivery",
        slices: ["20-composer"],
      },
      {
        agentName: "driver2",
        runtime: "claude-code",
        stateGlyph: "parked",
        doing: "parked on your follow-mode call",
        holdsCount: 1,
        lastTransitionIso: NOW,
        exception: null,
        sessionName: "dev44-driver2@openrig-delivery",
        slices: ["19-signal", "20-composer"],
      },
    ],
    provenance: `computed from queue+ps · window: today · at ${NOW}`,
    coordinationHealth: "2 handoffs today · 0 overdue",
    ...overrides,
  };
}

function composed(overrides: Partial<ComposedRigAgents> = {}): ComposedRigAgents {
  return {
    scope: "rig",
    needsYou: {
      items: [
        {
          source: "agent",
          identity: "qitem-park-1",
          summary: "waiting on your follow-mode call",
          leg: "park-on-human",
          where: "human-review@kernel",
          ageIso: NOW,
          priority: "urgent",
          tier: "critical",
          evidenceRef: null,
          unblocks: "qitem-park-1",
          qitemId: "qitem-park-1",
          destinationSession: "human-review@kernel",
          derived: null,
        },
      ],
      provenance: `computed from queue+ps (rig scope) · window: today at ${NOW}`,
    },
    agents: band(),
    settled: [
      { fromSession: "driver@r", toSession: "qa@r", summary: "shipped the panel", closedAtIso: NOW, qitemId: "qitem-9" },
    ],
    settledProvenance: `computed from queue transitions · window: today · at ${NOW}`,
    composedAt: NOW,
    ...overrides,
  };
}

function renderPage(payload: ComposedRigAgents | { error: true }) {
  vi.stubGlobal("fetch", async () =>
    "error" in payload
      ? new Response("boom", { status: 503 })
      : new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RigAgentsPage />
    </QueryClientProvider>,
  );
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/agents");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RigAgentsPage — the three bands from the composed root", () => {
  it("renders NEEDS YOU, AGENTS (with health line), and SETTLED with C6 labels", async () => {
    renderPage(composed());
    expect(await screen.findByTestId("rig-agents-page")).toBeTruthy();
    expect(screen.getByText("waiting on your follow-mode call")).toBeTruthy();
    expect(screen.getByTestId("agents-health").textContent).toBe("2 handoffs today · 0 overdue");
    expect(screen.getByText("building the follow-mode half")).toBeTruthy();
    expect(screen.getByTestId("settled-summary-qitem-9").textContent).toBe("shipped the panel");
  });

  it("grouping toggle: by-slice groups rows under each slice they hold work on", async () => {
    renderPage(composed());
    await screen.findByTestId("rig-agents-page");
    fireEvent.click(screen.getByTestId("rig-agents-group-slice"));
    expect(screen.getByTestId("agents-group-19-signal")).toBeTruthy();
    expect(screen.getByTestId("agents-group-20-composer")).toBeTruthy();
    expect(window.location.search).toContain("group=slice");
  });

  it("anchored zoom (?slice=) filters to that slice's agents with the full-rig step visible", async () => {
    window.history.replaceState({}, "", "/agents?slice=19-signal");
    renderPage(composed());
    await screen.findByTestId("rig-agents-page");
    expect(screen.getByTestId("rig-agents-anchor").textContent).toContain("19-signal");
    expect(screen.getByText("building the follow-mode half")).toBeTruthy();
    expect(screen.queryByText("no tracked work item")).toBeNull(); // other-slice agent filtered out
    expect(screen.getByTestId("rig-agents-unanchor")).toBeTruthy();
  });

  it("honest error state when the composer is unreachable — never a silent empty page", async () => {
    renderPage({ error: true });
    expect(await screen.findByTestId("rig-agents-error")).toBeTruthy();
  });

  it("proven-empty settled renders the provenance line, never blank", async () => {
    renderPage(composed({ settled: [], settledProvenance: "0 handoffs today — computed from queue transitions · window: today" }));
    await screen.findByTestId("rig-agents-page");
    expect(screen.getByTestId("settled-empty").textContent).toContain("0 handoffs today");
  });
});

describe("AgentsBandView grouping (extension in the one home)", () => {
  it("default grouping renders the flat one-row-per-agent list (byte-compatible with P2 pages)", () => {
    render(<AgentsBandView band={band()} itemRef="x" />);
    expect(screen.queryByTestId("agents-group-19-signal")).toBeNull();
    expect(screen.getAllByText(/driver1|qa1/).length).toBeGreaterThanOrEqual(2);
  });

  it("unknown glyph renders honestly for telemetry-down rows", () => {
    render(<AgentsBandView band={band()} itemRef="x" />);
    expect(screen.getByLabelText("unknown (telemetry down)")).toBeTruthy();
  });

  it("parked glyph renders from queue-proven park state", () => {
    render(<AgentsBandView band={band()} itemRef="x" />);
    expect(screen.getByLabelText("parked")).toBeTruthy();
    expect(screen.getByText("parked on your follow-mode call")).toBeTruthy();
  });

  it("by-slice duplicate rows open transcript drill independently per row instance", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify({ session: String(url), lines: 50, content: "tail" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<AgentsBandView band={band()} itemRef="x" grouping="slice" />);
    fireEvent.click(screen.getAllByTestId("agent-drill-dev44-driver2@openrig-delivery")[0]!);
    expect(await screen.findAllByTestId("transcript-drill-dev44-driver2@openrig-delivery")).toHaveLength(1);
  });
});

describe("NeedsYouAccordion showApprove (slice-terminal act stays at slice altitude)", () => {
  const nyBand: NeedsYouBand = {
    items: [
      {
        source: "agent",
        identity: "q-1",
        summary: "s",
        leg: "park-on-human",
        where: "human@kernel",
        ageIso: NOW,
        priority: null,
        tier: null,
        evidenceRef: null,
        unblocks: null,
        qitemId: "q-1",
        destinationSession: "a@r",
        derived: null,
      },
    ],
    provenance: "p",
  };
  const ctx = { root: null, relPath: null, slicePath: null };

  it("showApprove=false hides the approve button; CHAT remains", () => {
    renderWithClient(<NeedsYouAccordion band={nyBand} slice="rig" actorSession="human@host" ctx={ctx} showApprove={false} />);
    fireEvent.click(screen.getByTestId("needs-you-row-q-1"));
    expect(screen.queryByTestId("needs-you-approve")).toBeNull();
    expect(screen.getByTestId("needs-you-chat")).toBeTruthy();
  });

  it("rig-scope evidence refs render as non-openable pointers without slice context", () => {
    renderWithClient(
      <NeedsYouAccordion
        band={{ ...nyBand, items: [{ ...nyBand.items[0]!, evidenceRef: "proof/evidence.md" }] }}
        slice="rig"
        actorSession="human@host"
        ctx={ctx}
        showApprove={false}
      />,
    );
    fireEvent.click(screen.getByTestId("needs-you-row-q-1"));
    expect(screen.getByTestId("needs-you-evidence-q-1-pointer").textContent).toBe("proof/evidence.md");
    // Union with the P2 FileViewer fixback: the ONE no-context degrade also
    // covers markdown — no drawer trigger may render without a readable
    // target (the dead-drawer/eternal-Loading class), and the shadowed
    // md-unresolvable branch stays retired.
    expect(screen.queryByTestId("needs-you-evidence-q-1-md")).toBeNull();
    expect(screen.queryByTestId("needs-you-evidence-q-1-md-unresolvable")).toBeNull();
    expect(screen.getByText("(not openable from this view — no slice context)")).toBeTruthy();
  });

  it("default keeps approve (P2 pages unchanged)", () => {
    renderWithClient(<NeedsYouAccordion band={nyBand} slice="20-x" actorSession="human@host" ctx={ctx} />);
    fireEvent.click(screen.getByTestId("needs-you-row-q-1"));
    expect(screen.getByTestId("needs-you-approve")).toBeTruthy();
  });
});

// OPR.0.4.4.22 FR-5 — the entry points (front doors) zoom to /agents.
describe("entry points zoom to the AGENTS altitude", () => {
  it("SliceReviewTab's AGENTS region carries the anchored zoom link", async () => {
    // Static source assertion (behavior lives in the slice tab's data flow;
    // the link contract is what FR-5 pins): the zoom href is anchored.
    const src = (await import("node:fs")).readFileSync(
      "src/components/review/SliceReviewTab.tsx",
      "utf8",
    );
    expect(src).toContain('href={`/agents?slice=${encodeURIComponent(data.slice)}`}');
    expect(src).toContain('data-testid="slice-agents-zoom"');
  });

  it("MissionReviewTab's board agent-count chip zooms to rig scope", async () => {
    const src = (await import("node:fs")).readFileSync(
      "src/components/review/MissionReviewTab.tsx",
      "utf8",
    );
    expect(src).toContain('href="/agents"');
    expect(src).toContain("board-agents-zoom-");
    expect(src).toContain("sibling control");
    expect(src).not.toContain("stopPropagation");
  });

  it("the /agents route is registered but NEVER in nav chrome (drift-killer 4)", async () => {
    const src = (await import("node:fs")).readFileSync(
      "src/routes.tsx",
      "utf8",
    );
    expect(src).toContain('path: "/agents"');
    // The nav rail lives in AppShell; the route must not appear there.
    const shell = (await import("node:fs")).readFileSync(
      "src/components/AppShell.tsx",
      "utf8",
    );
    expect(shell).not.toContain('"/agents"');
  });
});

// OPR.0.4.4.22 FR-6 — the transcript drill-in: shipped routes, on demand,
// honest per-seat error, zero standing transcript cost.
describe("transcript drill-in (FR-6)", () => {
  it("zero standing cost: rendering the page fetches ONLY the composed root — no transcript URLs", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(composed()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RigAgentsPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId("rig-agents-page");
    expect(urls.every((u) => !u.includes("/api/transcripts/"))).toBe(true);
  });

  it("tapping a row opens the drill: tail fetched from the SHIPPED route; grep + full on explicit request", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/api/transcripts/")) {
        if (u.includes("/grep")) return new Response(JSON.stringify({ session: "s", pattern: "x", matches: ["m1"] }), { status: 200 });
        return new Response(JSON.stringify({ session: "s", lines: 50, content: "tail content here" }), { status: 200 });
      }
      return new Response(JSON.stringify(composed()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RigAgentsPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId("rig-agents-page");
    fireEvent.click(screen.getByTestId("agent-drill-dev44-driver1@openrig-delivery"));
    expect(await screen.findByTestId("drill-content")).toBeTruthy();
    expect(urls.some((u) => u.includes("/api/transcripts/dev44-driver1%40openrig-delivery/tail?lines=50"))).toBe(true);
    // Full only on explicit request.
    expect(urls.some((u) => u.includes("/full"))).toBe(false);
    fireEvent.click(screen.getByTestId("drill-full"));
    await screen.findByTestId("drill-content");
    expect(urls.some((u) => u.includes("/api/transcripts/dev44-driver1%40openrig-delivery/full"))).toBe(true);
  });

  it("a seat with no transcript renders the daemon's honest per-seat error — never a silent empty pane", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/transcripts/")) {
        return new Response(JSON.stringify({ error: "No transcript for 'dev44-qa1@openrig-delivery'. Transcripts start automatically on next rig up." }), { status: 404 });
      }
      return new Response(JSON.stringify(composed()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RigAgentsPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId("rig-agents-page");
    fireEvent.click(screen.getByTestId("agent-drill-dev44-qa1@openrig-delivery"));
    const err = await screen.findByTestId("drill-error");
    expect(err.textContent).toContain("No transcript for 'dev44-qa1@openrig-delivery'");
  });
});

// OPR.0.4.6.MH5 C4/C5 — the FLEET band's ONE v1 mount is THIS page. The
// mount pin + both no-fleet behaviors (render NOTHING + FETCH nothing) at
// the mount site; band anatomy depth lives in fleet-band.test.tsx.
describe("MH-5 — the FLEET band mount (v1 single mount, enumerated)", () => {
  function renderWithHostAwareStub(hosts: unknown[], fleet: unknown | null) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/api/hosts")) {
        return new Response(JSON.stringify({ ownName: "studio", selected: "local", hosts }), { status: 200 });
      }
      if (u.includes("/api/review/fleet")) {
        return new Response(JSON.stringify(fleet ?? {}), { status: fleet ? 200 : 500 });
      }
      return new Response(JSON.stringify(composed()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
      <QueryClientProvider client={client}>
        <RigAgentsPage />
      </QueryClientProvider>,
    );
    return { urls, ...utils };
  }

  const FLEET_MIN = {
    rollup: { needsYouCount: 0, exceptionCount: 1, exceptionsByKind: [{ kind: "stuck", count: 1 }], hostCount: 2, unreachableCount: 0 },
    needsYou: {
      items: [
        {
          source: "derived", identity: "qi|stuck|t0", fleetKey: "vps-a|qi|stuck|t0", hostId: "vps-a", seenFrom: ["rig"],
          summary: "packer2 idle 47m", leg: "stuck", where: "rig", ageIso: null, priority: null, tier: null,
          evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null,
          derived: { kind: "stuck", evidence: "idle 47m >= 30m", threshold: "stuck >= 30m idle" },
        },
      ],
      provenance: "fleet union · 2/2 hosts composing",
    },
    hosts: [
      { hostId: "local", kind: "local", status: { hostId: "local", status: "ok" }, needsYouCount: 0, exceptionsByKind: [], seatCount: 3, rigCount: 1, topLine: "quiet" },
      { hostId: "vps-a", kind: "remote", status: { hostId: "vps-a", status: "ok" }, needsYouCount: 0, exceptionsByKind: [{ kind: "stuck", count: 1 }], seatCount: 2, rigCount: 1, topLine: "▲ stuck — packer2 idle 47m" },
    ],
    settled: [],
    settledProvenance: "0 settled",
    composedAt: NOW,
  };

  it("with a registered remote host the band renders ABOVE the per-host bands, and the per-host content is untouched", async () => {
    renderWithHostAwareStub(
      [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "A", selected: false, status: "reachable" }],
      FLEET_MIN,
    );
    const page = await screen.findByTestId("rig-agents-page");
    const bandEl = await screen.findByTestId("fleet-band");
    expect(page.contains(bandEl)).toBe(true);
    // The band precedes the per-host NEEDS YOU content in document order.
    expect(bandEl.compareDocumentPosition(screen.getByText("waiting on your follow-mode call")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The per-host bands still render fully (the LOCK: untouched below).
    expect(screen.getByTestId("agents-health").textContent).toBe("2 handoffs today · 0 overdue");
  });

  it("single-host operator: NO band in the DOM and NO fleet request from this page (byte-identical pre-MH5 + the FS-1 fetch gate)", async () => {
    const { urls } = renderWithHostAwareStub([], null);
    await screen.findByTestId("rig-agents-page");
    expect(screen.queryByTestId("fleet-band")).toBeNull();
    expect(urls.some((u) => u.includes("/api/review/fleet"))).toBe(false);
  });
});
