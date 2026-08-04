// Rig Context / Composable Context Injection v0 (PL-014) — daemon
// HTTP route tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { contextPacksRoutes } from "../src/routes/context-packs.js";

interface FakeSendResult {
  ok: boolean;
  sessionName: string;
  reason?: string;
  error?: string;
}

class FakeSessionTransport {
  public calls: Array<{ sessionName: string; text: string }> = [];
  public response: FakeSendResult = { ok: true, sessionName: "x" };
  async send(sessionName: string, text: string): Promise<FakeSendResult> {
    this.calls.push({ sessionName, text });
    return { ...this.response, sessionName };
  }
}

function writePack(root: string, name: string, manifest: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
}

describe("context-packs routes (PL-014)", () => {
  let tmp: string;
  let libRoot: string;
  let lib: ContextPackLibraryService;
  let transport: FakeSessionTransport;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-routes-"));
    libRoot = join(tmp, "lib");
    mkdirSync(libRoot, { recursive: true });
    lib = new ContextPackLibraryService({
      roots: [{ path: libRoot, sourceType: "user_file" }],
    });
    transport = new FakeSessionTransport();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function buildApp(opts?: { withTransport?: boolean; withLib?: boolean }): Hono {
    const app = new Hono();
    const withTransport = opts?.withTransport !== false;
    const withLib = opts?.withLib !== false;
    app.use("*", async (c, next) => {
      if (withLib) c.set("contextPackLibrary" as never, lib);
      if (withTransport) c.set("sessionTransport" as never, transport);
      await next();
    });
    app.route("/api/context-packs", contextPacksRoutes());
    return app;
  }

  it("GET /library returns 503 when service is not wired", async () => {
    const app = buildApp({ withLib: false });
    const res = await app.request("/api/context-packs/library");
    expect(res.status).toBe(503);
  });

  it("GET /library returns the indexed packs", async () => {
    writePack(libRoot, "smoke", `
name: smoke
version: 1
purpose: Smoke
files:
  - path: notes.md
    role: notes
`, { "notes.md": "Hello" });
    lib.scan();
    const app = buildApp();
    const res = await app.request("/api/context-packs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ name: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("smoke");
  });

  it("POST /library/sync re-indexes and returns the count + entries", async () => {
    writePack(libRoot, "p1", `
name: p1
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "x" });
    const app = buildApp();
    const res = await app.request("/api/context-packs/library/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; entries: Array<{ name: string }> };
    expect(body.count).toBe(1);
    expect(body.entries[0]!.name).toBe("p1");
  });

  it("POST /library/compose writes an ordered durable ref without requiring or calling transport", async () => {
    const a = join(tmp, "a.md");
    const b = join(tmp, "b.md");
    writeFileSync(a, "A\n");
    writeFileSync(b, "B");
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outRef: "packs/qitem-brief",
        sources: [{ path: a, label: "a.md" }, { path: b, label: "b.md" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ref: string; text: string; entry: { relativePath: string } };
    expect(body.ref).toBe("packs/qitem-brief");
    expect(body.entry.relativePath).toBe("packs/qitem-brief");
    expect(body.text).toBe("A\n\n\nB");
    expect(body.text).not.toContain("# OpenRig Context Pack:");
    expect(body.text).not.toContain("## File:");
    expect(lib.getByRef("packs/qitem-brief")).not.toBeNull();
    expect(transport.calls).toEqual([]);
  });

  it("POST /library/compose returns a structured unsafe_ref and performs no write", async () => {
    const a = join(tmp, "a.md");
    writeFileSync(a, "A");
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outRef: "../escape", sources: [{ path: a, label: "a.md" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("unsafe_ref");
    expect(body.message).toMatch(/unsafe pack ref/);
    expect(existsSync(join(tmp, "escape"))).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it("POST /library/compose returns the exact missing_files envelope", async () => {
    const missing = join(tmp, "absent.md");
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outRef: "packs/missing",
        sources: [{ path: missing, label: "absent.md" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_files",
      message: `context composition source file(s) not found: ${missing}`,
      missingFiles: [missing],
    });
    expect(existsSync(join(libRoot, "packs", "missing"))).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it("POST /library/compose returns missing_files for an empty source list", async () => {
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outRef: "packs/empty", sources: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_files",
      message: "context composition requires at least one --from file",
      missingFiles: [],
    });
    expect(existsSync(join(libRoot, "packs", "empty"))).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it.each([null, 7, []])(
    "POST /library/compose rejects malformed source member %j with the structured 400 envelope",
    async (sourceMember) => {
      const app = buildApp({ withTransport: false });
      const res = await app.request("/api/context-packs/library/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outRef: "packs/malformed", sources: [sourceMember] }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "invalid_compose_request",
        message: "body must include { outRef, sources: [{ path, label }, ...] }",
      });
      expect(existsSync(join(libRoot, "packs", "malformed"))).toBe(false);
      expect(transport.calls).toEqual([]);
    },
  );

  it("GET /library/:id returns the pack manifest", async () => {
    writePack(libRoot, "p1", `
name: p1
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "content" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:p1:1")}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; files: unknown[] };
    expect(body.name).toBe("p1");
    expect(body.files).toHaveLength(1);
  });

  it("GET /library/:id returns 404 for unknown id", async () => {
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:missing:1")}`);
    expect(res.status).toBe(404);
  });

  it("GET /library/:id/preview returns the assembled bundle", async () => {
    writePack(libRoot, "preview-pack", `
name: preview-pack
version: 1
purpose: Preview test
files:
  - path: a.md
    role: r
`, { "a.md": "BODY-A" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:preview-pack:1")}/preview`);
    expect(res.status).toBe(200);
    const body = await res.json() as { bundleText: string; bundleBytes: number; missingFiles: unknown[] };
    expect(body.bundleText).toContain("# OpenRig Context Pack: preview-pack v1");
    expect(body.bundleText).toContain("BODY-A");
    expect(body.bundleBytes).toBeGreaterThan(0);
    expect(body.missingFiles).toEqual([]);
  });

  it("POST /library/:id/send dry-run returns the bundle without invoking transport", async () => {
    writePack(libRoot, "dry", `
name: dry
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "dry content" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:dry:1")}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "test@rig", dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { dryRun: boolean; bundleText?: string; sent?: boolean };
    expect(body.dryRun).toBe(true);
    expect(body.bundleText).toContain("dry content");
    expect(body.sent).toBeUndefined();
    expect(transport.calls).toEqual([]);
  });

  it("POST /library/:id/send invokes SessionTransport.send with the assembled bundle", async () => {
    writePack(libRoot, "real", `
name: real
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "real content" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:real:1")}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "driver@rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sent: boolean };
    expect(body.sent).toBe(true);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.sessionName).toBe("driver@rig");
    expect(transport.calls[0]!.text).toContain("real content");
  });

  it("POST /library/:id/send 502s when SessionTransport reports failure", async () => {
    writePack(libRoot, "fail", `
name: fail
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "x" });
    lib.scan();
    transport.response = { ok: false, sessionName: "x", reason: "session_missing", error: "Session not found" };
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:fail:1")}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "missing@rig" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; sent: boolean };
    expect(body.error).toContain("Session not found");
    expect(body.sent).toBe(false);
  });

  it("POST /library/:id/send 400s without destinationSession", async () => {
    writePack(libRoot, "no-dest", `
name: no-dest
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "x" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:no-dest:1")}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /library/:id/send 503s when SessionTransport is missing from context", async () => {
    writePack(libRoot, "no-transport", `
name: no-transport
version: 1
files:
  - path: a.md
    role: r
`, { "a.md": "x" });
    lib.scan();
    const app = buildApp({ withTransport: false });
    const res = await app.request(`/api/context-packs/library/${encodeURIComponent("context-pack:no-transport:1")}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "x" }),
    });
    expect(res.status).toBe(503);
  });

  // Slice-03 ATOM 4 — the path-like-ref resolution/deletion surface. Refs carry
  // '/', so they travel as a `?ref=` query (never a `:id` path segment). Both
  // verbs flow through the sealed getByRef/removeByRef boundary.
  it("GET /library/by-ref resolves a pack by its path-like ref (getByRef-backed)", async () => {
    writePack(libRoot, join("packs", "smoke"), `
name: smoke
version: 1
purpose: Ref pack
files:
  - path: notes.md
    role: notes
`, { "notes.md": "Hello" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/smoke")}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; relativePath: string };
    expect(body.name).toBe("smoke");
    expect(body.relativePath).toBe("packs/smoke");
  });

  it("GET /library/by-ref returns a structured 400 unsafe_ref for a traversal ref", async () => {
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("../escape")}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("unsafe_ref");
    expect(body.message).toMatch(/unsafe pack ref/);
  });

  it("GET /library/by-ref returns 404 for a safe-but-absent ref", async () => {
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/absent")}`);
    expect(res.status).toBe(404);
  });

  it("GET /library/by-ref returns 400 when the ref query is missing", async () => {
    const app = buildApp();
    const res = await app.request("/api/context-packs/library/by-ref");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("ref_required");
  });

  it("DELETE /library/by-ref removes a pack; the ref stops resolving", async () => {
    writePack(libRoot, join("packs", "smoke"), `
name: smoke
version: 1
files:
  - path: notes.md
    role: notes
`, { "notes.md": "Hello" });
    lib.scan();
    expect(lib.getByRef("packs/smoke")).not.toBeNull();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/smoke")}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean; ref: string };
    expect(body.removed).toBe(true);
    expect(body.ref).toBe("packs/smoke");
    expect(lib.getByRef("packs/smoke")).toBeNull();
    expect(existsSync(join(libRoot, "packs", "smoke"))).toBe(false);
  });

  it("DELETE /library/by-ref returns a structured 400 unsafe_ref with no mutation", async () => {
    writePack(libRoot, join("packs", "keep"), `
name: keep
version: 1
files:
  - path: notes.md
    role: notes
`, { "notes.md": "x" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("../escape")}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unsafe_ref");
    expect(lib.getByRef("packs/keep")).not.toBeNull();
    expect(existsSync(join(libRoot, "packs", "keep"))).toBe(true);
  });

  it("DELETE /library/by-ref returns 404 pack_not_found for a safe-but-absent ref", async () => {
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/absent")}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pack_not_found");
  });

  it("DELETE /library/by-ref returns 403 pack_not_removable for a shipped builtin pack", async () => {
    const builtinRoot = join(tmp, "builtin");
    writePack(builtinRoot, join("packs", "shipped"), `
name: shipped
version: 1
files:
  - path: notes.md
    role: notes
`, { "notes.md": "x" });
    const builtinLib = new ContextPackLibraryService({ roots: [{ path: builtinRoot, sourceType: "builtin" }] });
    builtinLib.scan();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("contextPackLibrary" as never, builtinLib); await next(); });
    app.route("/api/context-packs", contextPacksRoutes());
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/shipped")}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pack_not_removable");
    expect(existsSync(join(builtinRoot, "packs", "shipped"))).toBe(true);
  });
});
