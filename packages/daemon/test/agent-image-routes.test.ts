// PL-016 — daemon HTTP route tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import type { SnapshotCapturer } from "../src/domain/agent-images/snapshot-capturer.js";

function writeImage(root: string, name: string, manifest: string, files: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
}

describe("agent-images routes (PL-016)", () => {
  let tmp: string;
  let libRoot: string;
  let specRoot: string;
  let lib: AgentImageLibraryService;
  let capturer: { capture: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-image-routes-"));
    libRoot = join(tmp, "lib");
    specRoot = join(tmp, "specs");
    mkdirSync(libRoot, { recursive: true });
    mkdirSync(specRoot, { recursive: true });
    lib = new AgentImageLibraryService({
      roots: [{ path: libRoot, sourceType: "user_file" }],
    });
    capturer = { capture: vi.fn() };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function buildApp(): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentImageLibrary" as never, lib);
      c.set("snapshotCapturer" as never, capturer as unknown as SnapshotCapturer);
      await next();
    });
    app.route("/api/agent-images", agentImagesRoutes({
      specRoots: () => [specRoot],
    }));
    return app;
  }

  it("GET /library redacts source-resume-token", async () => {
    writeImage(libRoot, "smoke", `
name: smoke
version: 1
runtime: claude-code
source_seat: x@y
source_session_id: sid
source_resume_token: REAL-TOKEN-MUST-NOT-LEAK
files: []
`);
    lib.scan();
    const app = buildApp();
    const res = await app.request("/api/agent-images/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ name: string; sourceResumeToken: string }>;
    expect(body[0]!.name).toBe("smoke");
    expect(body[0]!.sourceResumeToken).toBe("(redacted)");
    expect(JSON.stringify(body)).not.toContain("REAL-TOKEN-MUST-NOT-LEAK");
  });

  it("GET /library/:id/preview returns starterSnippet", async () => {
    writeImage(libRoot, "snippet", `
name: snippet
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/agent-images/library/${encodeURIComponent("agent-image:snippet:1")}/preview`);
    expect(res.status).toBe(200);
    const body = await res.json() as { starterSnippet: string };
    expect(body.starterSnippet).toContain("mode: agent_image");
    expect(body.starterSnippet).toContain('value: "snippet"');
  });

  it("POST /snapshot delegates to SnapshotCapturer + redacts token in response", async () => {
    capturer.capture.mockReturnValue({
      imageId: "agent-image:fresh:1",
      imagePath: "/path/to/fresh",
      manifest: {
        name: "fresh", version: "1", runtime: "claude-code",
        sourceSeat: "x@y", sourceSessionId: "sid", sourceResumeToken: "SECRET-TOKEN",
        createdAt: "2026-05-04T20:00:00Z", files: [],
      },
    });
    const app = buildApp();
    const res = await app.request("/api/agent-images/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "x@y", name: "fresh" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { manifest: { sourceResumeToken: string } };
    expect(body.manifest.sourceResumeToken).toBe("(redacted)");
    expect(capturer.capture).toHaveBeenCalledWith(expect.objectContaining({
      sourceSession: "x@y",
      name: "fresh",
    }));
  });

  it("POST /snapshot 400s without required fields", async () => {
    const app = buildApp();
    const res = await app.request("/api/agent-images/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /library/:id/pin + /unpin round-trips", async () => {
    writeImage(libRoot, "pinned", `
name: pinned
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    lib.scan();
    const app = buildApp();
    const id = encodeURIComponent("agent-image:pinned:1");
    let res = await app.request(`/api/agent-images/library/${id}/pin`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(existsSync(join(libRoot, "pinned", ".pinned"))).toBe(true);
    res = await app.request(`/api/agent-images/library/${id}/unpin`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(existsSync(join(libRoot, "pinned", ".pinned"))).toBe(false);
  });

  it("DELETE /library/:id refuses without force when image is referenced", async () => {
    // Create image
    writeImage(libRoot, "referenced", `
name: referenced
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    // Add a spec referencing it
    mkdirSync(join(specRoot, "agents", "x"), { recursive: true });
    writeFileSync(join(specRoot, "agents", "x", "agent.yaml"), `
name: ref
runtime: claude-code
session_source:
  mode: agent_image
  ref:
    kind: image_name
    value: referenced
`);
    lib.scan();
    const app = buildApp();
    const id = encodeURIComponent("agent-image:referenced:1");
    const res = await app.request(`/api/agent-images/library/${id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; reasons: string[] };
    expect(body.error).toBe("image_referenced");
    expect(body.reasons).toContain("referenced_by_agent_spec");
    // Image must still exist on disk after the rejected delete
    expect(existsSync(join(libRoot, "referenced", "manifest.yaml"))).toBe(true);
  });

  it("DELETE /library/:id?force=true overrides the guard", async () => {
    writeImage(libRoot, "force-target", `
name: force-target
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    mkdirSync(join(specRoot, "agents", "x"), { recursive: true });
    writeFileSync(join(specRoot, "agents", "x", "agent.yaml"), `
name: ref
runtime: claude-code
session_source:
  mode: agent_image
  ref:
    kind: image_name
    value: force-target
`);
    lib.scan();
    const app = buildApp();
    const id = encodeURIComponent("agent-image:force-target:1");
    const res = await app.request(`/api/agent-images/library/${id}?force=true`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; forced: boolean };
    expect(body.ok).toBe(true);
    expect(body.forced).toBe(true);
    expect(existsSync(join(libRoot, "force-target", "manifest.yaml"))).toBe(false);
  });

  it("POST /prune --dry-run reports protected vs evictable", async () => {
    writeImage(libRoot, "evictable", `
name: evictable
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    writeImage(libRoot, "protected-by-agent", `
name: protected-by-agent
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    mkdirSync(join(specRoot, "agents", "x"), { recursive: true });
    writeFileSync(join(specRoot, "agents", "x", "agent.yaml"), `
name: ref
runtime: claude-code
session_source:
  mode: agent_image
  ref:
    kind: image_name
    value: protected-by-agent
`);
    lib.scan();
    const app = buildApp();
    const res = await app.request("/api/agent-images/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      dryRun: boolean;
      protected: Array<{ imageName: string }>;
      evictable: Array<{ imageName: string }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.protected.map((p) => p.imageName).sort()).toEqual(["protected-by-agent"]);
    expect(body.evictable.map((e) => e.imageName).sort()).toEqual(["evictable"]);
  });

  it("POST /prune (no dry-run) deletes evictable + leaves protected", async () => {
    writeImage(libRoot, "delete-me", `
name: delete-me
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    writeImage(libRoot, "keep-me", `
name: keep-me
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`);
    mkdirSync(join(specRoot, "rigs", "x"), { recursive: true });
    writeFileSync(join(specRoot, "rigs", "x", "rig.yaml"), `
name: x
pods:
  - id: dev
    members:
      - id: impl
        runtime: claude-code
        session_source:
          mode: agent_image
          ref:
            kind: image_name
            value: keep-me
`);
    lib.scan();
    const app = buildApp();
    const res = await app.request("/api/agent-images/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; protected: Array<{ imageName: string }> };
    expect(body.deleted).toEqual(["agent-image:delete-me:1"]);
    expect(body.protected.map((p) => p.imageName)).toEqual(["keep-me"]);
    expect(existsSync(join(libRoot, "delete-me", "manifest.yaml"))).toBe(false);
    expect(existsSync(join(libRoot, "keep-me", "manifest.yaml"))).toBe(true);
  });

  it("503 when library service is missing", async () => {
    const app = new Hono();
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [] }));
    const res = await app.request("/api/agent-images/library");
    expect(res.status).toBe(503);
  });
});
