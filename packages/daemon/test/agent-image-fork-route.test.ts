// OPR.0.4.3.05 seat-forking closeout — the narrow daemon fork composer route
// (POST /api/agent-images/fork). Proves the three driver-note invariants:
//   1. resume-token discovery runs server-side (resume-token-discovery.ts).
//   2. the native resume id is kept DAEMON-LOCAL — never in the route response.
//   3. --keep-image pins the image AND the evidence guard protects it AFTER
//      pinning (pin-on-keep is a real, shipped protection mechanism).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import { evaluateProtection } from "../src/domain/agent-images/evidence-guard.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import type { SnapshotCapturer } from "../src/domain/agent-images/snapshot-capturer.js";
import type { PodRigInstantiator, AddMemberOutcome } from "../src/domain/rigspec-instantiator.js";

const MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema,
  resumeMetadataSchema, nodeSpecFieldsSchema, agentspecRebootSchema, podNamespaceSchema,
  contextUsageSchema, externalCliAttachmentSchema,
];

const NATIVE_SECRET = "NATIVE-RESUME-ID-MUST-STAY-DAEMON-LOCAL";

function writeImage(root: string, name: string, manifest: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
}

describe("agent-images fork composer route (OPR.0.4.3.05)", () => {
  let tmp: string;
  let libRoot: string;
  let specRoot: string;
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fork-route-"));
    libRoot = join(tmp, "lib");
    specRoot = join(tmp, "specs");
    mkdirSync(libRoot, { recursive: true });
    mkdirSync(specRoot, { recursive: true });
    db = createDb();
    migrate(db, MIGRATIONS);
    rigRepo = new RigRepository(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Seed a claude-code source seat with a native resume id. */
  function seedClaudeSource(sessionName: string, resumeToken: string | null): void {
    const rig = rigRepo.createRig("src-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/Users/op/code/openrig",
      agentRef: "local:agents/impl",
      profile: "default",
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, sessionName, new Date().toISOString());
    if (resumeToken) {
      db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`).run(resumeToken, sessionId);
    }
  }

  function seedTerminalSource(sessionName: string): void {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "ops.term", { runtime: "terminal", cwd: "/tmp" });
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'live', ?)`,
    ).run(ulid(), node.id, sessionName, new Date().toISOString());
  }

  function buildApp(opts: {
    addMember: (rigId: string, pod: string, member: Record<string, unknown>, rigRoot: string, o?: unknown) => Promise<AddMemberOutcome>;
    lib?: AgentImageLibraryService;
    capturer?: SnapshotCapturer;
  }): Hono {
    const app = new Hono();
    const podInstantiator = { addMemberToPod: vi.fn(opts.addMember) } as unknown as PodRigInstantiator;
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("podInstantiator" as never, podInstantiator);
      if (opts.lib) c.set("agentImageLibrary" as never, opts.lib);
      if (opts.capturer) c.set("snapshotCapturer" as never, opts.capturer);
      await next();
    });
    // Expose the spy for assertions.
    (app as unknown as { _addMember: unknown })._addMember = podInstantiator.addMemberToPod;
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [specRoot] }));
    return app;
  }

  async function post(app: Hono, body: unknown) {
    return app.request("/api/agent-images/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("default fork → add_member(mode:fork, native_id); native id NEVER in response (driver note 2)", async () => {
    seedClaudeSource("dev-impl@src-rig", NATIVE_SECRET);
    const addMember = vi.fn(async () => ({
      ok: true as const,
      result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched", sessionName: "forked@dst" } },
    } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember });

    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "dst-rig", pod: "dev", member: "forked" });
    expect(res.status).toBe(201);
    const raw = await res.text();
    // Native id kept daemon-local — must not leak in the response body.
    expect(raw).not.toContain(NATIVE_SECRET);
    const body = JSON.parse(raw);
    expect(body.ok).toBe(true);

    // The composed member fragment carried mode:fork + the discovered native id.
    expect(addMember).toHaveBeenCalledTimes(1);
    const [rigId, pod, member] = addMember.mock.calls[0]!;
    expect(rigId).toBe("dst-rig");
    expect(pod).toBe("dev");
    expect((member as Record<string, unknown>).runtime).toBe("claude-code");
    expect((member as Record<string, unknown>).agent_ref).toBe("local:agents/impl");
    expect((member as Record<string, unknown>).session_source).toEqual({
      mode: "fork",
      ref: { kind: "native_id", value: NATIVE_SECRET },
    });
  });

  it("unknown source session → 404 session_not_found", async () => {
    const app = buildApp({ addMember: vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome)) });
    const res = await post(app, { sourceSession: "nope@nope", rigId: "r", pod: "p", member: "m" });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("session_not_found");
  });

  it("terminal-runtime source → honest reject (400 runtime_unsupported)", async () => {
    seedTerminalSource("ops-term@term-rig");
    const addMember = vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember });
    const res = await post(app, { sourceSession: "ops-term@term-rig", rigId: "r", pod: "p", member: "m" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("runtime_unsupported");
    expect(addMember).not.toHaveBeenCalled();
  });

  it("source with NO derivable resume token → honest 409, no fabrication, no launch", async () => {
    seedClaudeSource("dev-impl@src-rig", null); // no resume_token, no context_usage
    const addMember = vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember });
    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "r", pod: "p", member: "m" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("resume_token_unavailable");
    expect(body.message).toMatch(/fabricated/i);
    expect(addMember).not.toHaveBeenCalled();
  });

  it("member_conflict from add_member → surfaced honestly as 409", async () => {
    seedClaudeSource("dev-impl@src-rig", NATIVE_SECRET);
    const addMember = vi.fn(async () => ({
      ok: false as const, code: "member_conflict" as const, message: 'Member "dev.forked" already exists',
    }));
    const app = buildApp({ addMember: addMember as never });
    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "r", pod: "dev", member: "forked" });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("member_conflict");
  });

  it("--keep-image → durable image is created, PINNED, and evidence-guard-protected AFTER pinning (driver note 3)", async () => {
    seedClaudeSource("dev-impl@src-rig", NATIVE_SECRET);
    const lib = new AgentImageLibraryService({ roots: [{ path: libRoot, sourceType: "user_file" }] });
    // capturer stub installs a real image dir (as the real capturer would) so
    // the route's lib.pin + a subsequent evaluateProtection operate on a real entry.
    const capturer = {
      capture: vi.fn((o: { name: string; version?: string }) => {
        writeImage(libRoot, o.name, `\nname: ${o.name}\nversion: ${o.version ?? "1"}\nruntime: claude-code\nsource_seat: dev-impl@src-rig\nsource_session_id: ${NATIVE_SECRET}\nsource_resume_token: ${NATIVE_SECRET}\nfiles: []\n`);
        lib.scan();
        return { imageId: `agent-image:${o.name}:${o.version ?? "1"}`, imagePath: join(libRoot, o.name), manifest: {} };
      }),
    } as unknown as SnapshotCapturer;

    const addMember = vi.fn(async () => ({
      ok: true as const,
      result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched", sessionName: "forked@dst" } },
    } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember, lib, capturer });

    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "dst-rig", pod: "dev", member: "forked", keepImage: true, imageName: "kept" });
    expect(res.status).toBe(201);
    const raw = await res.text();
    expect(raw).not.toContain(NATIVE_SECRET); // still daemon-local
    const body = JSON.parse(raw) as { image: { id: string; name: string; pinned: boolean } };
    expect(body.image).toEqual({ id: "agent-image:kept:1", name: "kept", version: "1", pinned: true });

    // The image is pinned in the live library...
    expect(lib.get("agent-image:kept:1")!.pinned).toBe(true);
    // ...and — asserted AFTER pinning — the evidence guard now protects it.
    const protections = evaluateProtection({ images: lib.list(), specRoots: [specRoot] });
    const kept = protections.find((p) => p.imageId === "agent-image:kept:1")!;
    expect(kept.protected).toBe(true);
    expect(kept.reasons).toContain("pinned");

    // Launch went through mode:agent_image (not a raw native id).
    const [, , member] = addMember.mock.calls[0]!;
    expect((member as Record<string, unknown>).session_source).toEqual({
      mode: "agent_image", ref: { kind: "image_name", value: "kept", version: "1" },
    });
  });

  it("missing required fields → 400", async () => {
    const app = buildApp({ addMember: vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome)) });
    const res = await post(app, { sourceSession: "x@y" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("missing_required_fields");
  });
});
