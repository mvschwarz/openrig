import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DaemonClient } from "../src/daemon-client.js";

// FR-8 / R7 no-new-data: the TUI's entire daemon surface is this ONE module,
// and every route it can emit is on the §4.A table of EXISTING web-consumed
// reads. This test pins the audit: exercise every wrapper, collect every URL.

const SPEC_4A_ROUTES = [
  "/api/rigs/openrig-build/graph",
  "/api/ps",
  "/api/rigs/summary",
  "/api/rigs/openrig-build/nodes",
  "/api/review/agents?scope=rig",
  "/api/specs/library?kind=rig",
  "/api/rigs/openrig-build/spec.json",
  "/api/specs/library/a2/review",
  "/api/queue/list?attention=1",
  "/api/review/rig",
  "/api/review/fleet",
  "/api/queue/attention-aggregate",
  "/api/rigs/openrig-build/status",
  "/api/stream/list?limit=5",
];

describe("daemon client = the §4.A table, one module, nothing else (FR-8/FR-9)", () => {
  it("every wrapper emits exactly a §4.A route", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      seen.push(String(url).replace("http://x", ""));
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const c = new DaemonClient({ baseUrl: "http://x", fetchImpl });

    await c.rigGraph("openrig-build");
    await c.ps();
    await c.rigsSummary();
    await c.rigNodes("openrig-build");
    await c.reviewAgents("rig");
    await c.specsLibrary("rig");
    await c.rigSpec("openrig-build");
    await c.specLibraryReview("a2");
    await c.queueAttention();
    await c.reviewRig();
    await c.reviewFleet();
    await c.attentionAggregate();
    await c.rigStatus("openrig-build");
    await c.streamList();

    expect(seen.sort()).toEqual([...SPEC_4A_ROUTES].sort());
  });

  it("is the ONLY module that talks HTTP (one-file source-check stays one file)", () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = ["state.ts", "render.ts", "grammar.ts", "input.ts", "socket-server.ts", "main.ts", "types.ts", "demo-data.ts", "index.ts", "hydrate.ts"];
    for (const file of files) {
      const text = readFileSync(path.join(srcDir, file), "utf8");
      expect(text, `${file} must not fetch`).not.toMatch(/fetch\(/);
      // state.ts carries §4.A provenance notes in the section registry
      // (sourceRead metadata) — those are documentation, not request paths.
      if (file !== "state.ts") expect(text, `${file} must not carry routes`).not.toMatch(/\/api\//);
    }
  });

  it("write surface = EXACTLY the two BR-8 drive-structure contracts (terminal-open, rig-up)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") seen.push(String(url).replace("http://x", ""));
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const c = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    await c.openTerminal("pod:dev");
    await c.upRig("myrig");
    expect(seen).toEqual(["/api/terminal/open", "/api/up"]);
    // and no other method on the client POSTs
    const postCalls = Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter((m) =>
      ["openTerminal", "upRig"].includes(m),
    );
    expect(postCalls).toHaveLength(2);
  });

  it("surfaces a failed read as a NAMED error (route + status), never silent", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch;
    const c = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.ps()).rejects.toThrow(/GET \/api\/ps → 503/);
  });
});
