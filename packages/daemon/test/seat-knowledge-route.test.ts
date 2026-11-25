import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextPacksRoutes } from "../src/routes/context-packs.js";

describe("seat knowledge read independent of a context pack", () => {
  let tmp: string; let root: string; let legacy: string; let seat: string; let app: Hono;
  const saved = { topology: process.env.OPENRIG_TOPOLOGY_ROOT, shared: process.env.OPENRIG_SHARED_DOCS_ROOT };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "seat-knowledge-")); root = join(tmp, "topology"); legacy = join(tmp, "shared");
    seat = join(root, "rigs", "team", "seats", "worker"); mkdirSync(seat, { recursive: true });
    process.env.OPENRIG_TOPOLOGY_ROOT = root; process.env.OPENRIG_SHARED_DOCS_ROOT = legacy;
    app = new Hono(); app.route("/api/context-packs", contextPacksRoutes());
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [key, value] of [["OPENRIG_TOPOLOGY_ROOT", saved.topology], ["OPENRIG_SHARED_DOCS_ROOT", saved.shared]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const url = "/api/context-packs/seat-knowledge?rig=team&seat=worker";
  it("reads whole seat knowledge without a library and distinguishes empty from absent", async () => {
    writeFileSync(join(seat, "LEARNED.md"), "");
    expect((await app.request("/api/context-packs/library")).status).toBe(503);
    const res = await app.request(url); expect(res.status).toBe(200);
    const body = await res.json(); expect(body.rig).toBe("team"); expect(body.seat).toBe("worker");
    expect(body.files).toEqual([
      { name: "LEARNED.md", altitude: "seat", path: join(seat, "LEARNED.md"), resolvedPath: join(seat, "LEARNED.md"), source: "topology.root", content: "", extent: "whole-file" },
      { name: "RECAP.md", altitude: "seat", path: join(seat, "RECAP.md"), resolvedPath: null, source: "absent", content: null, extent: "absent" },
    ]);
  });

  it("returns complete recorded text and does not read ancestor files or enumerate other notes", async () => {
    mkdirSync(join(root, "LEARNED.md")); // A chain trace would fail reading this directory; this read is seat-only.
    const content = "# Recorded\n\n## First\nkept verbatim\n\n## Last\nlast line\n";
    writeFileSync(join(seat, "LEARNED.md"), content); writeFileSync(join(seat, "RECAP.md"), "# Recap\nstate\n");
    writeFileSync(join(seat, "other.md"), "DO-NOT-RETURN");
    const res = await app.request(url + "&name=other.md"); expect(res.status).toBe(200);
    const body = await res.json(); expect(body.files[0].content).toBe(content); expect(body.files[1].content).toBe("# Recap\nstate\n");
    expect(body.files.map((f: { name: string }) => f.name)).toEqual(["LEARNED.md", "RECAP.md"]);
    expect(JSON.stringify(body)).not.toContain("DO-NOT-RETURN");
  });

  it("retains legacy provenance and prefers canonical files when both exist", async () => {
    const oldSeat = join(legacy, "rigs", "team", "seats", "worker"); mkdirSync(oldSeat, { recursive: true });
    writeFileSync(join(oldSeat, "LEARNED.md"), "legacy learned"); writeFileSync(join(oldSeat, "RECAP.md"), "stale recap");
    writeFileSync(join(seat, "RECAP.md"), "canonical recap");
    const body = await (await app.request(url)).json();
    expect(body.files[0]).toMatchObject({ source: "legacy", resolvedPath: join(oldSeat, "LEARNED.md"), content: "legacy learned", extent: "whole-file" });
    expect(body.files[0].advisory).toContain("legacy-topology-read"); expect(body.files[0].advisory).toContain(join(seat, "LEARNED.md"));
    expect(body.files[1]).toMatchObject({ source: "topology.root", content: "canonical recap" });
  });

  it.each(["..", "../other", "a/b", "a\\b", "\0", ""])("rejects an invalid seat path segment %j", async (value) => {
    const qs = new URLSearchParams({ rig: "team", seat: value });
    expect((await app.request("/api/context-packs/seat-knowledge?" + qs)).status).toBe(400);
  });

  it("a read error is unavailable rather than absent", async () => {
    mkdirSync(join(seat, "LEARNED.md"));
    const res = await app.request(url); expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "seat_knowledge_unavailable" });
  });

  it.each(["unreadable directory", "dangling link"])("does not serve legacy bytes after a canonical %s", async (failure) => {
    const oldSeat = join(legacy, "rigs", "team", "seats", "worker"); mkdirSync(oldSeat, { recursive: true });
    writeFileSync(join(oldSeat, "LEARNED.md"), "legacy bytes must not replace a failed canonical lookup");
    if (failure === "unreadable directory") chmodSync(seat, 0o000);
    else symlinkSync(join(tmp, "missing-target"), join(seat, "LEARNED.md"));
    try {
      const res = await app.request(url); expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "seat_knowledge_unavailable", message: "The requested seat files could not be read." });
    } finally { chmodSync(seat, 0o700); }
  });

  it("keeps ENOTDIR as absence with the existing legacy fallback", async () => {
    rmSync(seat, { recursive: true }); writeFileSync(seat, "not a directory");
    const oldSeat = join(legacy, "rigs", "team", "seats", "worker"); mkdirSync(oldSeat, { recursive: true });
    writeFileSync(join(oldSeat, "LEARNED.md"), "legacy learned");
    const res = await app.request(url); expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files[0]).toMatchObject({ source: "legacy", content: "legacy learned", extent: "whole-file" });
    expect(body.files[1]).toMatchObject({ source: "absent", content: null, extent: "absent" });
  });
});
