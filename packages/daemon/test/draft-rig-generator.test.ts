import { describe, it, expect } from "vitest";
import { generateDraftRig } from "../src/domain/draft-rig-generator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { DiscoveredSession } from "../src/domain/discovery-types.js";

function makeSession(overrides: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    id: "sess-1",
    tmuxSession: "dev-impl",
    tmuxWindow: null,
    tmuxPane: "0",
    pid: 1234,
    cwd: "/project/code",
    activeCommand: "claude",
    runtimeHint: "claude-code",
    confidence: "high",
    evidenceJson: null,
    configJson: null,
    status: "active",
    claimedNodeId: null,
    firstSeenAt: "2026-03-31T00:00:00Z",
    lastSeenAt: "2026-03-31T00:00:00Z",
    ...overrides,
  };
}

describe("Draft rig generator", () => {
  it.runIf(process.platform === "win32")("names native CWD groups by their final directory and preserves each selected CWD", () => {
    const first = "C:\\synthetic projects\\code", second = "D:\\synthetic projects\\code\\";
    const result = generateDraftRig([
      makeSession({ id: "native-1", tmuxSession: "first", cwd: first }),
      makeSession({ id: "native-2", tmuxSession: "second", cwd: second }),
    ]);
    const raw = RigSpecCodec.parse(result.yaml);
    const pods = (raw as Record<string, unknown>)["pods"] as Array<{ id: string; members: Array<{ cwd: string }> }>;
    expect(pods.map(pod => pod.id)).toEqual(["code", "code-2"]);
    expect(pods.map(pod => pod.members[0]!.cwd)).toEqual([first, second]);
    expect(RigSpecSchema.validate(raw).valid).toBe(true);
  });
  // Test 1: groups by shared CWD
  it("groups sessions by shared CWD into pods", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", cwd: "/project/code" }),
      makeSession({ id: "s2", tmuxSession: "qa", cwd: "/project/code", runtimeHint: "codex" }),
      makeSession({ id: "s3", tmuxSession: "server", cwd: "/project/infra", runtimeHint: "terminal" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    expect(pods.length).toBe(2); // code pod + infra pod
  });

  // Test 2: assigns names from session names
  it("assigns pod/member names from session names", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "dev-lead", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    const members = (pods[0] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    expect(members[0]!["id"]).toBe("dev-lead");
  });

  // Test 3: produces valid rig spec YAML
  it("produces valid rig spec that passes schema validation", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);
  });

  // Test 4: handles mixed runtimes
  it("handles mixed runtimes (claude-code + codex + terminal)", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", runtimeHint: "claude-code", cwd: "/project" }),
      makeSession({ id: "s2", tmuxSession: "qa", runtimeHint: "codex", cwd: "/project" }),
      makeSession({ id: "s3", tmuxSession: "server", runtimeHint: "terminal", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);

    // Terminal member should have sentinel values
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    const members = (pods[0] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    const terminal = members.find((m) => m["runtime"] === "terminal");
    expect(terminal).toBeDefined();
    expect(terminal!["agent_ref"]).toBe("builtin:terminal");
    expect(terminal!["profile"]).toBe("none");
  });

  // Test 5: single session rig
  it("handles single-session rigs", () => {
    const sessions = [makeSession({ id: "s1", tmuxSession: "solo", cwd: "/project" })];
    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);
  });

  // Test 6: excludes unknown runtime with warning
  it("excludes unknown runtime sessions with warning", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "known", runtimeHint: "claude-code", cwd: "/project" }),
      makeSession({ id: "s2", tmuxSession: "mystery", runtimeHint: "unknown", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("mystery");
    expect(result.yaml).toContain("# WARNING");
  });

  // Test 7: deduplicates colliding names
  it("deduplicates colliding member names", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", cwd: "/project" }),
      makeSession({ id: "s2", tmuxSession: "impl", cwd: "/project", runtimeHint: "codex" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    const members = (pods[0] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    const ids = members.map((m) => m["id"]);
    expect(new Set(ids).size).toBe(2); // No duplicates
    expect(ids).toContain("impl");
    expect(ids).toContain("impl-2");
  });
});
