import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";

import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { resolveRebuildArtifacts } from "../src/domain/session-source-rebuild-resolver.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { RigSpec, SessionSourceRebuildSpec } from "../src/domain/types.js";

// ============================================================================
// Fixtures
// ============================================================================

function baseValidSpec(): Record<string, unknown> {
  return {
    version: "0.2",
    name: "rebuild-test-rig",
    pods: [
      {
        id: "dev",
        label: "Dev pod",
        members: [
          {
            id: "writer",
            agent_ref: "local:agents/writer",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
}

function withMember(spec: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(spec));
  const pods = next.pods as Array<Record<string, unknown>>;
  const members = pods[0]!.members as Array<Record<string, unknown>>;
  members[0] = { ...members[0], ...override };
  return next;
}

// ============================================================================
// Schema validation — Honest Refusal Matrix (rebuild-mode rows)
// ============================================================================

describe("session_source rebuild — schema validation", () => {
  it("accepts claude-code + rebuild + artifact_set with non-empty value array", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: {
        mode: "rebuild",
        ref: { kind: "artifact_set", value: ["/tmp/CULTURE.md", "/tmp/role.md"] },
      },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts codex + rebuild + artifact_set", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "codex",
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x/y.md"] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
  });

  it("rejects terminal runtime with rebuild", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      profile: "none",
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x.md"] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal runtime has no native fork primitive and no agent context to rebuild"))).toBe(true);
  });

  it("rejects rebuild + ref.kind=native_id (kind belongs to fork mode)", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "native_id", value: "abc" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rebuild mode requires ref.kind: "artifact_set"'))).toBe(true);
    expect(result.errors.some((e) => e.includes('belong to mode: "fork"'))).toBe(true);
  });

  it("rejects rebuild + ref.kind=artifact_path", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_path", value: "/x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rebuild mode requires ref.kind: "artifact_set"'))).toBe(true);
  });

  it("rejects rebuild + empty artifact_set value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: [] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rebuild requires at least one artifact path"))).toBe(true);
    // The error mentions trust-precedence ordering as guidance.
    expect(result.errors.some((e) => e.includes("trust-precedence"))).toBe(true);
  });

  it("rejects rebuild + value not an array", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: "/just/one/path.md" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("required non-empty array"))).toBe(true);
  });

  it("rejects rebuild + value array containing empty strings", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x.md", "  "] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("each entry must be a non-empty string"))).toBe(true);
  });

  it("rejects unknown ref.kind for rebuild", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "magic", value: ["/x"] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('v1 rebuild mode supports "artifact_set" only'))).toBe(true);
  });

  it("rejects unknown mode (neither fork nor rebuild)", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "snapshot", ref: { kind: "native_id", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    // PL-016 Item 4: error message names the now-three valid modes.
    expect(result.errors.some((e) => e.includes('supports "fork", "rebuild", or "agent_image"'))).toBe(true);
  });
});

// ============================================================================
// Codec roundtrip
// ============================================================================

describe("session_source rebuild — codec roundtrip", () => {
  it("preserves rebuild + artifact_set + value array through serialize → parse → normalize", () => {
    const seed: RigSpec = {
      version: "0.2",
      name: "rebuild-test-rig",
      pods: [{
        id: "dev",
        label: "Dev pod",
        members: [{
          id: "writer",
          agentRef: "local:agents/writer",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
          sessionSource: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/tmp/CULTURE.md", "/tmp/role.md", "/tmp/handover.md"] } },
        }],
        edges: [],
      }],
      edges: [],
    };
    const yaml = RigSpecCodec.serialize(seed);
    expect(yaml).toContain("session_source:");
    expect(yaml).toContain("mode: rebuild");
    expect(yaml).toContain("kind: artifact_set");
    expect(yaml).toContain("/tmp/CULTURE.md");
    expect(yaml).toContain("/tmp/role.md");
    expect(yaml).toContain("/tmp/handover.md");

    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(parsed as Record<string, unknown>) as RigSpec;
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toEqual(seed.pods[0]!.members[0]!.sessionSource);
  });
});

// ============================================================================
// Rebuild artifact resolver
// ============================================================================

describe("resolveRebuildArtifacts", () => {
  function makeSpec(paths: string[]): SessionSourceRebuildSpec {
    return { mode: "rebuild", ref: { kind: "artifact_set", value: paths } };
  }

  it("resolves all-existing paths into ResolvedStartupFile[] preserving operator order", () => {
    const exists = (p: string) => p === "/x/CULTURE.md" || p === "/y/role.md" || p === "/z/handover.md";
    const result = resolveRebuildArtifacts(makeSpec(["/x/CULTURE.md", "/y/role.md", "/z/handover.md"]), { exists });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual(["/x/CULTURE.md", "/y/role.md", "/z/handover.md"]);
      expect(result.gaps).toEqual([]);
      // Identity-honesty: deliveryHint is `send_text` (operator-curated context for the running TUI).
      expect(result.files.every((f) => f.deliveryHint === "send_text")).toBe(true);
      // appliesOn: ["fresh_start"] — rebuild IS a fresh launch from the runtime's perspective.
      expect(result.files.every((f) => f.appliesOn.includes("fresh_start"))).toBe(true);
      // Required so the orchestrator surfaces missing-resource failures honestly.
      expect(result.files.every((f) => f.required === true)).toBe(true);
    }
  });

  it("records missing paths as gaps without failing if some files exist", () => {
    const exists = (p: string) => p === "/exists.md";
    const result = resolveRebuildArtifacts(makeSpec(["/exists.md", "/missing.md", "/also-missing.md"]), { exists });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual(["/exists.md"]);
      expect(result.gaps).toEqual(["/missing.md", "/also-missing.md"]);
    }
  });

  it("fails the launch with a clear error when ALL declared paths are missing", () => {
    const exists = () => false;
    const result = resolveRebuildArtifacts(makeSpec(["/missing-1.md", "/missing-2.md"]), { exists });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("none of the 2 declared artifact paths resolved");
      expect(result.error).toContain("trust-precedence order");
      expect(result.gaps).toEqual(["/missing-1.md", "/missing-2.md"]);
    }
  });

  it("preserves operator-declared ordering (does NOT impose alphabetical or any other sort)", () => {
    const exists = () => true;
    const order = ["/zzz-low-trust.md", "/aaa-mid-trust.md", "/mmm-highest-trust.md"];
    const result = resolveRebuildArtifacts(makeSpec(order), { exists });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual(order);
    }
  });
});

// ============================================================================
// Startup orchestrator — rebuild integration
// ============================================================================

function mockOrchTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function makeStubAdapter(): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    // Fresh-launch shape: returns ok with NO resumeToken (rebuild seats have
    // no native runtime conversation to resume from).
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

describe("StartupOrchestrator rebuild integration", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
  });
  afterEach(() => { db.close(); });

  function seed(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("rebuild-rig");
    const node = rigRepo.addNode(rig.id, "writer", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-writer");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(s: { rigId: string; nodeId: string; sessionId: string }, overrides?: Partial<StartupInput>): StartupInput {
    return {
      rigId: s.rigId,
      nodeId: s.nodeId,
      sessionId: s.sessionId,
      binding: { id: "b1", nodeId: s.nodeId, tmuxSession: "r01-writer", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." },
      adapter: makeStubAdapter(),
      plan: emptyPlan(),
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
      ...overrides,
    };
  }

  function createOrch(): StartupOrchestrator {
    return new StartupOrchestrator({
      db, sessionRegistry, eventBus,
      tmuxAdapter: mockOrchTmux(),
      sleep: async () => {},
    });
  }

  function makeRebuildArtifacts(): ResolvedStartupFile[] {
    return [
      { path: "CULTURE.md", absolutePath: "/x/CULTURE.md", ownerRoot: "/x", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
      { path: "role.md", absolutePath: "/y/role.md", ownerRoot: "/y", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
      { path: "handover.md", absolutePath: "/z/handover.md", ownerRoot: "/z", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
    ];
  }

  it("sets continuityOutcome=rebuilt when rebuildArtifacts is provided and launch succeeds", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s, { rebuildArtifacts: makeRebuildArtifacts() }));
    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "rebuilt",
    });
  });

  it("calls adapter.launchHarness with NO resumeToken AND NO forkSource on rebuild", async () => {
    const s = seed();
    const adapter = makeStubAdapter();
    const launchSpy = adapter.launchHarness as ReturnType<typeof vi.fn>;
    const orch = createOrch();
    await orch.startNode(makeInput(s, { adapter, rebuildArtifacts: makeRebuildArtifacts() }));

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const opts = launchSpy.mock.calls[0]![1];
    expect(opts.resumeToken).toBeUndefined();
    expect(opts.forkSource).toBeUndefined();
  });

  it("rebuild seat persists with NO resumeToken (identity-honesty: rebuild is artifact-injected, not native-resumed)", async () => {
    const s = seed();
    const orch = createOrch();
    await orch.startNode(makeInput(s, { rebuildArtifacts: makeRebuildArtifacts() }));

    const row = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(s.sessionId) as { resume_token: string | null };
    expect(row.resume_token).toBeNull();
  });

  it("hands rebuild artifacts to adapter.deliverStartup (post-launch delivery via send_text)", async () => {
    const s = seed();
    const adapter = makeStubAdapter();
    const deliverSpy = adapter.deliverStartup as ReturnType<typeof vi.fn>;
    const orch = createOrch();
    const artifacts = makeRebuildArtifacts();

    await orch.startNode(makeInput(s, { adapter, rebuildArtifacts: artifacts }));

    // deliverStartup is called twice: once pre-launch (filesystem files; empty
    // for rebuild-only) and once post-launch (TUI files; the rebuild artifacts).
    expect(deliverSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Post-launch call must include the rebuild artifacts in operator order.
    const allDeliveredFiles = deliverSpy.mock.calls.flatMap((call) => call[0] as ResolvedStartupFile[]);
    const deliveredAbsPaths = allDeliveredFiles.map((f) => f.absolutePath);
    for (const artifact of artifacts) {
      expect(deliveredAbsPaths).toContain(artifact.absolutePath);
    }
    // Operator order preserved: CULTURE before role before handover.
    const cultureIdx = deliveredAbsPaths.indexOf("/x/CULTURE.md");
    const roleIdx = deliveredAbsPaths.indexOf("/y/role.md");
    const handoverIdx = deliveredAbsPaths.indexOf("/z/handover.md");
    expect(cultureIdx).toBeGreaterThanOrEqual(0);
    expect(cultureIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(handoverIdx);
  });

  it("fresh path (no rebuildArtifacts, no resumeToken, no forkSource) is unchanged: continuityOutcome=fresh", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "fresh" });
  });

  it("fork path (forkSource set) is unchanged by rebuild plumbing: continuityOutcome=forked", async () => {
    const s = seed();
    const adapter = makeStubAdapter();
    (adapter.launchHarness as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      resumeToken: "NEW-FORK-TOKEN",
      resumeType: "claude_id",
    });
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s, {
      adapter,
      forkSource: { kind: "native_id", value: "PARENT-FORK-TOKEN" },
    }));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "forked" });
  });
});

// ============================================================================
// Honest UX literal contract — continuityOutcome includes "rebuilt"; no
// `restored|resumed|snapshot|forked` slips into the rebuild dossier wording.
// ============================================================================

describe("identity-honesty literal contract — rebuild", () => {
  it('continuityOutcome union accepts "rebuilt" alongside other outcomes', () => {
    const r: { ok: true; startupStatus: "ready"; continuityOutcome: "rebuilt" } = {
      ok: true, startupStatus: "ready", continuityOutcome: "rebuilt",
    };
    expect(r.continuityOutcome).toBe("rebuilt");
  });

  it("rebuild mode literal is 'rebuild' (NOT 'fresh', 'resumed', 'forked', 'restored', or 'snapshot')", () => {
    const spec: SessionSourceRebuildSpec = { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x"] } };
    expect(spec.mode).toBe("rebuild");
    expect(["fresh", "resumed", "forked", "restored", "snapshot"]).not.toContain(spec.mode as string);
  });

  it("resolver-produced ResolvedStartupFile entries do NOT carry any 'restored'/'resumed'/'snapshot'/'forked' tags", () => {
    const exists = () => true;
    const result = resolveRebuildArtifacts(
      { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x.md"] } },
      { exists },
    );
    if (!result.ok) throw new Error("expected ok");
    const serialized = JSON.stringify(result.files);
    expect(serialized).not.toMatch(/restored/i);
    expect(serialized).not.toMatch(/resumed/i);
    expect(serialized).not.toMatch(/snapshot/i);
    expect(serialized).not.toMatch(/forked/i);
  });
});

// ============================================================================
// Real-filesystem smoke: resolver default `exists` works (light integration)
// ============================================================================

describe("rebuild resolver real-filesystem smoke (default existsSync)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openrig-rebuild-resolver-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves real files written under a temp dir", () => {
    const a = join(dir, "CULTURE.md");
    const b = join(dir, "role.md");
    writeFileSync(a, "culture body");
    writeFileSync(b, "role body");

    const result = resolveRebuildArtifacts({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: [a, b] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual([a, b]);
      expect(result.gaps).toEqual([]);
    }
  });

  it("returns gaps for missing files alongside resolved ones", () => {
    const real = join(dir, "real.md");
    writeFileSync(real, "x");
    const ghost = join(dir, "ghost.md"); // never written

    const result = resolveRebuildArtifacts({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: [real, ghost] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual([real]);
      expect(result.gaps).toEqual([ghost]);
    }
  });
});
