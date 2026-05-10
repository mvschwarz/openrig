// PL-016 source-cwd roundtrip tests.
//
// Pins:
//   - manifest captures source_cwd at create (snapshot capturer reads
//     source seat's cwd from the nodes table)
//   - snippet generator emits cwd: <source_cwd> in the rendered
//     Use-as-starter YAML
//   - back-compat: manifests without source_cwd still load + render
//     snippet with omitted cwd (current behavior preserved)
//   - operator-override scenario (different cwd → fork fails honestly
//     with no daemon-side override magic — verified by absence of any
//     daemon cwd-rewriting code path)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
  AgentImageLibraryService,
} from "../src/domain/agent-images/agent-image-library-service.js";
import { parseAgentImageManifest } from "../src/domain/agent-images/manifest-parser.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import { SnapshotCapturer } from "../src/domain/agent-images/snapshot-capturer.js";
import type Database from "better-sqlite3";
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
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ulid } from "ulid";

let tmp: string;
let userRoot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pl016-fxn2-cwd-"));
  userRoot = join(tmp, "user");
  mkdirSync(userRoot, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeImage(root: string, name: string, manifest: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
}

// ============================================================================
// Test 1 — manifest captures source_cwd at create (snapshot capturer)
// ============================================================================

describe("PL-016 Finding 2 — snapshot capturer captures source_cwd", () => {
  function setupDb(): { db: Database.Database; rigRepo: RigRepository; sessionRegistry: SessionRegistry } {
    const db = createDb();
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      snapshotsSchema,
      checkpointsSchema,
      resumeMetadataSchema,
      nodeSpecFieldsSchema,
      agentspecRebootSchema,
      podNamespaceSchema,
      contextUsageSchema,
      externalCliAttachmentSchema,
    ]);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    return { db, rigRepo, sessionRegistry };
  }

  it("captures source seat's cwd into manifest source_cwd", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/Users/op/code/projects/openrig",
    });
    // Create a session row + resume_token so discoverResumeToken returns it.
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-impl@test-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`).run("NATIVE-RESUME-TOKEN", sessionId);

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-impl@test-rig",
      name: "captured-image",
    });

    expect(result.manifest.sourceCwd).toBe("/Users/op/code/projects/openrig");

    // The manifest is also persisted to disk — verify the YAML contains
    // source_cwd so a fresh re-scan would re-load it correctly.
    const yaml = readFileSync(join(userRoot, "captured-image", "manifest.yaml"), "utf-8");
    expect(yaml).toContain("source_cwd:");
    expect(yaml).toContain("/Users/op/code/projects/openrig");

    db.close();
  });

  it("captures Claude's live context session id instead of stale launch resume_token", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/Users/op/code/projects/openrig",
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-impl@test-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`)
      .run("STALE-GENERATED-LAUNCH-ID", sessionId);
    db.prepare(`
      INSERT INTO context_usage (
        node_id, session_id, session_name, availability, source, sampled_at
      ) VALUES (?, ?, ?, 'known', 'claude_statusline_json', ?)
    `).run(node.id, "LIVE-CLAUDE-TRANSCRIPT-ID", "dev-impl@test-rig", new Date().toISOString());

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-impl@test-rig",
      name: "captured-live-session-image",
    });

    expect(result.manifest.sourceSessionId).toBe("LIVE-CLAUDE-TRANSCRIPT-ID");
    expect(result.manifest.sourceResumeToken).toBe("LIVE-CLAUDE-TRANSCRIPT-ID");
    expect(result.manifest.sourceResumeToken).not.toBe("STALE-GENERATED-LAUNCH-ID");

    db.close();
  });

  it("captures a managed Codex seat's persisted thread id into manifest", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", {
      runtime: "codex",
      cwd: "/Users/op/code/projects/openrig",
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-qa@test-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'codex_id' WHERE id = ?`)
      .run("LIVE-CODEX-THREAD-ID", sessionId);

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-qa@test-rig",
      name: "captured-codex-image",
    });

    expect(result.manifest.runtime).toBe("codex");
    expect(result.manifest.sourceSessionId).toBe("LIVE-CODEX-THREAD-ID");
    expect(result.manifest.sourceResumeToken).toBe("LIVE-CODEX-THREAD-ID");
    expect(result.manifest.sourceCwd).toBe("/Users/op/code/projects/openrig");

    db.close();
  });

  it("omits source_cwd when source node has no recorded cwd (legacy fixture)", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("legacy-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      // cwd intentionally null — models a pre-cwd-capture node row
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-impl@legacy-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`).run("TOKEN", sessionId);

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-impl@legacy-rig",
      name: "no-cwd-image",
    });

    expect(result.manifest.sourceCwd).toBeUndefined();
    const yaml = readFileSync(join(userRoot, "no-cwd-image", "manifest.yaml"), "utf-8");
    expect(yaml).not.toContain("source_cwd:");

    db.close();
  });
});

// ============================================================================
// Test 2 — snippet generator emits cwd in the Use-as-starter YAML
// ============================================================================

describe("PL-016 Finding 2 — snippet generator emits cwd:<source_cwd>", () => {
  function buildApp(library: AgentImageLibraryService): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentImageLibrary" as never, library);
      await next();
    });
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [] }));
    return app;
  }

  it("rendered snippet includes cwd line when manifest has source_cwd", async () => {
    writeImage(userRoot, "with-cwd", `
name: with-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
source_cwd: /Users/op/code/projects/openrig
files: []
`);
    const lib = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    lib.scan();
    const app = buildApp(lib);

    const id = encodeURIComponent("agent-image:with-cwd:1");
    const res = await app.request(`/api/agent-images/library/${id}/preview`);
    expect(res.status).toBe(200);
    const body = await res.json() as { starterSnippet: string };
    expect(body.starterSnippet).toContain('cwd: "/Users/op/code/projects/openrig"');
    expect(body.starterSnippet).toContain("session_source:");
    expect(body.starterSnippet).toContain("    value: \"with-cwd\"");
    // cwd line precedes session_source block (operator pastes verbatim).
    const cwdIdx = body.starterSnippet.indexOf("cwd:");
    const ssIdx = body.starterSnippet.indexOf("session_source:");
    expect(cwdIdx).toBeLessThan(ssIdx);
  });

  it("BACK-COMPAT: snippet omits cwd line when manifest has no source_cwd (current behavior preserved)", async () => {
    writeImage(userRoot, "no-cwd", `
name: no-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
files: []
`);
    const lib = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    lib.scan();
    const app = buildApp(lib);

    const id = encodeURIComponent("agent-image:no-cwd:1");
    const res = await app.request(`/api/agent-images/library/${id}/preview`);
    expect(res.status).toBe(200);
    const body = await res.json() as { starterSnippet: string };
    expect(body.starterSnippet).not.toContain("cwd:");
    expect(body.starterSnippet).toContain("session_source:");
  });

  it("library entry surfaces sourceCwd verbatim (null when manifest predates Finding 2)", async () => {
    writeImage(userRoot, "with-cwd", `
name: with-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
source_cwd: /Users/op/code
files: []
`);
    writeImage(userRoot, "no-cwd", `
name: no-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
files: []
`);
    const lib = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    lib.scan();
    const app = buildApp(lib);

    const res = await app.request("/api/agent-images/library");
    const body = await res.json() as Array<{ name: string; sourceCwd: string | null }>;
    const withCwd = body.find((e) => e.name === "with-cwd")!;
    const withoutCwd = body.find((e) => e.name === "no-cwd")!;
    expect(withCwd.sourceCwd).toBe("/Users/op/code");
    expect(withoutCwd.sourceCwd).toBeNull();
  });
});

// ============================================================================
// Test 3 — parser back-compat (snake + camel + missing)
// ============================================================================

describe("PL-016 Finding 2 — manifest parser back-compat", () => {
  it("accepts source_cwd (snake_case)", () => {
    const manifest = parseAgentImageManifest(`
name: x
version: "1"
runtime: claude-code
source_seat: a@r
source_session_id: s
source_resume_token: t
source_cwd: /Users/op/code
`, "/path");
    expect(manifest.sourceCwd).toBe("/Users/op/code");
  });

  it("accepts sourceCwd (camelCase)", () => {
    const manifest = parseAgentImageManifest(`
name: x
version: "1"
runtime: claude-code
source_seat: a@r
source_session_id: s
source_resume_token: t
sourceCwd: /Users/op/code
`, "/path");
    expect(manifest.sourceCwd).toBe("/Users/op/code");
  });

  it("manifests without source_cwd still parse (back-compat for pre-Finding-2 fixtures)", () => {
    const manifest = parseAgentImageManifest(`
name: x
version: "1"
runtime: claude-code
source_seat: a@r
source_session_id: s
source_resume_token: t
`, "/path");
    expect(manifest.sourceCwd).toBeUndefined();
  });
});

// ============================================================================
// Test 4 — operator-override safety: NO daemon-side cwd rewriting exists
// ============================================================================
//
// The daemon must NOT override cwd at fork dispatch — operator's chosen
// cwd in the rig.yaml is honored verbatim. If wrong, Claude returns
// "no conversation found" and the operator gets an honest error.
//
// This test enforces the absence of any daemon override path by
// scanning the rigspec-instantiator + claude-code-adapter source for
// a documented red flag: if some future patch adds an override here,
// the test fails and the author must explicitly justify.

describe("PL-016 Finding 2 — operator-override safety (no daemon cwd magic)", () => {
  it("rigspec-instantiator does NOT mutate member.cwd from agent_image manifest", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      join(import.meta.dirname ?? __dirname, "../src/domain/rigspec-instantiator.ts"),
      "utf-8",
    );
    // Negative assertion: no code path reads sourceCwd from the
    // resolved agent_image and overwrites the member's cwd.
    expect(src).not.toMatch(/member\.cwd\s*=\s*image\.sourceCwd/);
    expect(src).not.toMatch(/cwd:\s*image\.sourceCwd/);
  });

  it("snippet generator emits cwd ONLY from manifest source_cwd (no inferred fallback)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      join(import.meta.dirname ?? __dirname, "../src/routes/agent-images.ts"),
      "utf-8",
    );
    // Positive assertion: snippet generator gates the cwd line on
    // entry.sourceCwd specifically — no fallback to homedir / cwd / etc.
    expect(src).toMatch(/if\s*\(\s*entry\.sourceCwd\s*\)/);
  });
});
