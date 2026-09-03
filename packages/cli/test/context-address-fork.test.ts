// OPR.0.5.3.5 Atom 4d — the CLI pins r1 asked for (4c A3 rec) plus the profile
// verb. The ROUTING FORK is the one piece of logic that lives ONLY in the CLI:
// an address carrying '#' goes straight to the daemon's resolver home; a bare
// slash value tries exact-pack lookup first, then only a 404 falls through to
// whole-file resolution. These pins cover the fork without duplicating any
// resolution behavior (the daemon owns that).

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE
      ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-08-24T00:00:00Z" } as DaemonState)
      : null)),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function run(port: number, argv: string[]): Promise<{ logs: string[]; errLogs: string[]; writes: string[] }> {
  const deps: StatusDeps = {
    lifecycleDeps: mockLifecycleDeps(port),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
  const logs: string[] = [];
  const errLogs: string[] = [];
  const writes: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(contextCommand(deps));
    await program.parseAsync(["node", "rig", "context", ...argv]);
  } catch { /* commander exitOverride */ } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
    process.exitCode = undefined;
  }
  return { logs, errLogs, writes };
}

describe("rig context — address fork + profile verb (Atom 4d)", () => {
  let server: http.Server;
  let port: number;
  let hits: string[];

  beforeAll(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      hits.push(url);
      res.setHeader("Content-Type", "application/json");
      if (url.startsWith("/api/context-packs/library/resolve-address")) {
        const address = new URL(url, "http://localhost").searchParams.get("address");
        if (address === "packs/smoke/missing.md") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "file_not_in_pack", message: "pack 'packs/smoke' declares no file 'missing.md' — declared: notes.md" }));
        } else {
          const text = address?.includes("#") ? "THE SPAN BYTES" : "THE WHOLE FILE BYTES\n";
          res.end(JSON.stringify({ address, packRef: "packs/smoke", filePath: "notes.md", text }));
        }
      } else if (url.startsWith("/api/context-packs/library/by-ref/profile")) {
        res.end(JSON.stringify({
          ref: "packs/smoke", situation: "handover", runtime: "claude", profileId: "codex-coverage",
          phases: [
            { id: "bootstrap", kind: "atoms", estimatedTokens: 2 },
            { id: "project-mission-role-task", kind: "context", sources: ["project", "mission", "seat", "slice"], estimatedTokens: 3 },
          ],
          pieces: [
            { atomId: "welcome", address: "notes.md#welcome", sourceKind: "library", order: 1, priority: "core", text: "hello", estimatedTokens: 2, provenance: { nominalPath: "/p/notes.md", realPath: "/p/notes.md", escapesRoot: false } },
            { atomId: "recap", address: "seat:RECAP.md#d", sourceKind: "seat", order: 9, priority: "core", text: "decisions", estimatedTokens: 3, provenance: { nominalPath: "/s/RECAP.md", realPath: "/x", escapesRoot: true } },
          ],
          totalEstimatedTokens: 5,
          budget: { limitTokens: 4, overageTokens: 1, dropCandidates: [{ atomId: "recap", priority: "core", estimatedTokens: 3 }] },
          provenanceWarnings: ["piece 'recap' (seat:RECAP.md#d): bytes came from OUTSIDE its seat root — real path /x"],
        }));
      } else if (url.startsWith("/api/context-packs/library/by-ref/preview")) {
        res.end(JSON.stringify({ id: "x", name: "smoke", version: "1", bundleText: "WHOLE PACK BUNDLE", bundleBytes: 17, estimatedTokens: 5, files: [], missingFiles: [] }));
      } else if (url.startsWith("/api/context-packs/library/by-ref")) {
        const ref = new URL(url, "http://localhost").searchParams.get("ref");
        if (ref !== "packs/smoke") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "context_pack_not_found" }));
        } else {
          res.end(JSON.stringify({ id: "x", kind: "context-pack", name: "smoke", version: "1", purpose: null, sourceType: "user_file", sourcePath: "/s", relativePath: "packs/smoke", updatedAt: "t", manifestEstimatedTokens: null, derivedEstimatedTokens: 5, files: [] }));
        }
      } else {
        res.end(JSON.stringify([]));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => { await new Promise<void>((r) => { server.close(() => r()); }); });

  it("FORK PIN: exact refs preview; bare files fall through; fragments route directly; invalid files fail loud", async () => {
    hits.length = 0;
    const withAddr = await run(port, ["get", "packs/smoke/notes.md#welcome"]);
    expect(hits.some((h) => h.startsWith("/api/context-packs/library/resolve-address"))).toBe(true);
    expect(hits.some((h) => h.startsWith("/api/context-packs/library/by-ref"))).toBe(false);
    expect(withAddr.logs.join("\n")).toBe("THE SPAN BYTES");

    hits.length = 0;
    const bare = await run(port, ["get", "packs/smoke"]);
    expect(hits.some((h) => h.startsWith("/api/context-packs/library/resolve-address"))).toBe(false);
    expect(bare.logs.join("\n")).toContain("WHOLE PACK BUNDLE");

    hits.length = 0;
    const wholeFile = await run(port, ["get", "packs/smoke/notes.md"]);
    expect(hits.map((h) => h.split("?")[0])).toEqual([
      "/api/context-packs/library/by-ref",
      "/api/context-packs/library/resolve-address",
    ]);
    expect(wholeFile.logs).toEqual([]);
    expect(wholeFile.writes.join("")).toBe("THE WHOLE FILE BYTES\n");

    hits.length = 0;
    const wholeFileJson = await run(port, ["get", "packs/smoke/notes.md", "--json"]);
    expect(JSON.parse(wholeFileJson.logs.join("\n"))).toMatchObject({
      address: "packs/smoke/notes.md",
      packRef: "packs/smoke",
      filePath: "notes.md",
      text: "THE WHOLE FILE BYTES\n",
    });

    hits.length = 0;
    const missing = await run(port, ["get", "packs/smoke/missing.md"]);
    expect(hits.map((h) => h.split("?")[0])).toEqual([
      "/api/context-packs/library/by-ref",
      "/api/context-packs/library/resolve-address",
    ]);
    expect(missing.logs).toEqual([]);
    expect(missing.errLogs.join("\n")).toBe("pack 'packs/smoke' declares no file 'missing.md' — declared: notes.md");
  });

  it("r1 4d obs (1): an escaping piece's stdout FRAMING header carries the escape marker — the payload is self-describing without touching composed bytes", async () => {
    // An agent that consumes stdout and discards stderr must still learn that
    // a piece's bytes came from outside its root. The header line is framing,
    // not content, so the marker costs zero composed bytes.
    hits.length = 0;
    const out = await run(port, ["profile", "packs/smoke", "--situation", "handover", "--runtime", "claude", "--rig", "r1", "--seat", "s1"]);
    const stdout = out.logs.join("\n");
    const recapHeader = stdout.split("\n").find((l) => l.startsWith("=== recap"))!;
    expect(recapHeader).toMatch(/ESCAPED|escape/i);
    const welcomeHeader = stdout.split("\n").find((l) => l.startsWith("=== welcome"))!;
    expect(welcomeHeader).not.toMatch(/ESCAPED|escape/i);
  });

  it("r1 4d obs (2): --runtime defaults from OPENRIG_RUNTIME (a codex seat that forgets the flag must not silently get a claude profile); the flag beats the env", async () => {
    const saved = process.env["OPENRIG_RUNTIME"];
    try {
      process.env["OPENRIG_RUNTIME"] = "codex";
      hits.length = 0;
      await run(port, ["profile", "packs/smoke", "--situation", "fresh"]);
      expect(hits.find((h) => h.includes("/profile"))!).toContain("runtime=codex");
      // r1 F2: the product's vocabulary is "claude-code" (the adapters' value,
      // live on real seats), never "claude" — it must map EXPLICITLY, not fall
      // through the unknown-value fallback that happens to coincide.
      process.env["OPENRIG_RUNTIME"] = "claude-code";
      hits.length = 0;
      const cc = await run(port, ["profile", "packs/smoke", "--situation", "fresh"]);
      expect(hits.find((h) => h.includes("/profile"))!).toContain("runtime=claude");
      expect(cc.errLogs.join("\n")).not.toMatch(/unrecognized/i); // recognized, no warning
      // A genuinely UNKNOWN value falls back to claude WITH A VOICE — a future
      // third runtime must not silently get a claude profile.
      process.env["OPENRIG_RUNTIME"] = "gemini-cli";
      hits.length = 0;
      const unknown = await run(port, ["profile", "packs/smoke", "--situation", "fresh"]);
      expect(hits.find((h) => h.includes("/profile"))!).toContain("runtime=claude");
      expect(unknown.errLogs.join("\n")).toMatch(/unrecognized.*gemini-cli/i);
      hits.length = 0;
      await run(port, ["profile", "packs/smoke", "--situation", "fresh", "--runtime", "claude"]);
      expect(hits.find((h) => h.includes("/profile"))!).toContain("runtime=claude");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_RUNTIME"];
      else process.env["OPENRIG_RUNTIME"] = saved;
    }
  });

  it("PROFILE VERB: composes by situation with the grant params threaded, pieces labeled on stdout, budget + provenance warnings on stderr", async () => {
    hits.length = 0;
    const out = await run(port, ["profile", "packs/smoke", "--situation", "handover", "--runtime", "claude", "--profile", "codex-coverage", "--rig", "r1", "--seat", "s1", "--mission", "release-x", "--slice", "slice-y", "--budget", "4"]);
    const profileHit = hits.find((h) => h.startsWith("/api/context-packs/library/by-ref/profile"))!;
    expect(profileHit).toBeDefined();
    for (const frag of ["situation=handover", "runtime=claude", "profile=codex-coverage", "rig=r1", "seat=s1", "mission=release-x", "slice=slice-y", "budget=4"]) {
      expect(profileHit).toContain(frag);
    }
    const stdout = out.logs.join("\n");
    expect(stdout).toContain("welcome");
    expect(stdout).toContain("[library]");
    // The mock recap piece escapes its root, so its label carries the marker
    // (the r1-obs-1 self-describing framing) — updated deliberately with it.
    expect(stdout).toContain("[seat !ESCAPED-ROOT]");
    const stderr = out.errLogs.join("\n");
    expect(stderr).toContain("PROFILE codex-coverage");
    expect(stderr).toContain("PHASE bootstrap (atoms, ~2 tokens)");
    expect(stderr).toContain("PHASE project-mission-role-task (context [project, mission, seat, slice], ~3 tokens)");
    expect(stderr).toMatch(/budget/i);
    expect(stderr).toContain("OUTSIDE its seat root");
  });
});
