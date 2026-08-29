// OPR.0.5.6.23 — silent-erasure remint (locked spec; desk territory ruling
// 22:22Z extends member-b to the routes/agent-images.ts fork memberFragment
// seam). Census: s23-session-source-leg-census.md beside this file.
//
// Member (a): the codec serialize leg drops session_source.ref.version — a pin
// that survives expand (post-S03) vanishes on a spec round-trip (the WAVE 1 R2
// HOLD shape). Disclosed third member at the same seam: parse carries
// compaction_strategy, serialize never emits it. Member (b): the fork-ingress
// memberFragment drops node-carried model/role/restore_policy/label — a forked
// seat silently loses its model pin (the 0.4.6.PI1 failure class).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { RigSpec, RigSpecPodMember, SessionSourceSpec } from "../src/domain/types.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import type { PodRigInstantiator } from "../src/domain/pod-rigspec-instantiator.js";

function rigWith(member: Partial<RigSpecPodMember> & { id: string }): RigSpec {
  return {
    version: "0.2",
    name: "s23-rig",
    summary: "s23",
    cultureFile: "culture.md",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        agentRef: "local:agents/impl",
        profile: "tdd",
        runtime: "claude-code",
        cwd: ".",
        ...member,
      } as RigSpecPodMember],
      edges: [],
    }],
    edges: [],
  };
}

function roundTripMember(member: Partial<RigSpecPodMember> & { id: string }): { yaml: string; member: RigSpecPodMember } {
  const yaml = RigSpecCodec.serialize(rigWith(member));
  const parsed = RigSpecCodec.parse(yaml);
  const validation = RigSpecSchema.validate(parsed);
  expect(validation.errors, `round-trip must stay schema-valid: ${validation.errors?.join("; ")}`).toEqual([]);
  const normalized = RigSpecSchema.normalize(parsed as Record<string, unknown>);
  return { yaml, member: normalized.pods[0]!.members[0]! };
}

describe("OPR.0.5.6.23 member (a) — codec round-trip preserves every optional sessionSource field", () => {
  it("RT-VERSION: session_source.ref.version survives serialize -> parse -> normalize, and the YAML itself carries the key", () => {
    const input: SessionSourceSpec = { mode: "agent_image", ref: { kind: "image_name", value: "starter", version: "1.2.3" } };
    const { yaml, member } = roundTripMember({ id: "impl", sessionSource: input });
    // base RED: serialize emits kind/value only — version re-parses undefined
    expect(member.sessionSource).toEqual(input);
    expect(yaml).toContain("version: 1.2.3"); // absence in every encoding: the YAML carries it
  });

  it("KEYSET-PIN: for every union arm carrying every optional field, the serialized ref key-set equals the input ref key-set", () => {
    const arms: SessionSourceSpec[] = [
      { mode: "fork", ref: { kind: "native_id", value: "tok-1" } },
      { mode: "rebuild", ref: { kind: "artifact_set", value: ["a.md", "b.md"] } },
      { mode: "agent_image", ref: { kind: "image_name", value: "img", version: "7" } },
    ];
    for (const input of arms) {
      const { yaml, member } = roundTripMember({ id: "impl", sessionSource: input });
      expect(member.sessionSource, `arm ${input.mode}`).toEqual(input);
      const parsed = RigSpecCodec.parse(yaml) as { pods: Array<{ members: Array<Record<string, unknown>> }> };
      const rawRef = (parsed.pods[0]!.members[0]!["session_source"] as { ref: Record<string, unknown> }).ref;
      expect(Object.keys(rawRef).sort(), `arm ${input.mode}: no ref key may silently vanish`)
        .toEqual(Object.keys(input.ref).sort());
    }
  });

  it("RT-COMPACTION (disclosed third member, same seam): member compaction_strategy survives the round-trip", () => {
    const { yaml, member } = roundTripMember({ id: "impl", compactionStrategy: "harness_native" });
    // base RED: schema parse carries it (:1058), the serialize leg never emits it
    expect(member.compactionStrategy).toBe("harness_native");
    expect(yaml).toContain("compaction_strategy: harness_native");
  });
});

describe("OPR.0.5.6.23 member (b) — fork-ingress memberFragment forwards every node-carried optional field", () => {
  let tmp: string;
  let specRoot: string;
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s23-fork-"));
    specRoot = join(tmp, "specs");
    mkdirSync(specRoot, { recursive: true });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("FORK-FRAGMENT: a source seat's model, role, restore_policy, and label ride the fork (the model pin is the 0.4.6.PI1 class)", async () => {
    const rig = rigRepo.createRig("src-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/work",
      agentRef: "local:agents/impl",
      profile: "default",
      model: "claude-opus-5",
      role: "worker",
      restorePolicy: "resume_if_possible",
      label: "Implementer",
    });
    const sessionId = ulid();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'live', ?)")
      .run(sessionId, node.id, "dev-impl@src-rig", new Date().toISOString());
    db.prepare("UPDATE sessions SET resume_token = 'tok-native-1', resume_type = 'claude_id' WHERE id = ?")
      .run(sessionId);

    const addMember = vi.fn(async () => ({
      ok: true as const,
      result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched" as const, sessionName: "forked@dst" } },
    }));
    const app = new Hono();
    const podInstantiator = { addMemberToPod: addMember } as unknown as PodRigInstantiator;
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("podInstantiator" as never, podInstantiator);
      await next();
    });
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [specRoot] }));

    const res = await app.request("/api/agent-images/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "dev-impl@src-rig", rigId: "dst-rig", pod: "dev", member: "forked" }),
    });
    expect(res.status).toBe(201);
    expect(addMember).toHaveBeenCalledTimes(1);
    const fragment = addMember.mock.calls[0]![2] as Record<string, unknown>;
    // base RED: the fragment forwards only runtime/agent_ref/profile/cwd/
    // codex_config_profile/permission_policy — these four are dropped.
    expect(fragment["model"]).toBe("claude-opus-5");
    expect(fragment["role"]).toBe("worker");
    expect(fragment["restore_policy"]).toBe("resume_if_possible");
    expect(fragment["label"]).toBe("Implementer");
    // and the previously forwarded fields still ride (regression floor)
    expect(fragment["agent_ref"]).toBe("local:agents/impl");
    expect(fragment["session_source"]).toMatchObject({ mode: "fork", ref: { kind: "native_id", value: "tok-native-1" } });
  });
});
