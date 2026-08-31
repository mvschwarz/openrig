import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";

const RIG_ROOT = "/project/rigs/session-source-roundtrip";

function agentYaml(): string {
  return `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []`;
}

describe("RigSpec session_source persistence", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    app = createTestApp(db, {
      podInstantiatorFsOps: {
        readFile: (path: string) => {
          if (path === `${RIG_ROOT}/agents/impl/agent.yaml`) return agentYaml();
          throw new Error(`Not found: ${path}`);
        },
        exists: (path: string) => path === `${RIG_ROOT}/agents/impl/agent.yaml`,
      },
    });
  });

  afterEach(() => { db.close(); });

  it("round-trips a versioned agent_image declaration through materialize and export", async () => {
    const sessionSource = {
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base", version: "3" },
    } as const;
    const materialized = await app.podInstantiator.materializeStructured({
      version: "0.2",
      name: "session-source-roundtrip",
      pods: [{
        id: "dev",
        label: "Dev",
        members: [{
          id: "impl",
          agent_ref: "local:agents/impl",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
          session_source: sessionSource,
        }],
        edges: [],
      }],
      edges: [],
    }, RIG_ROOT);

    expect(materialized.ok, JSON.stringify(materialized)).toBe(true);
    if (!materialized.ok) return;

    expect(app.rigRepo.getRig(materialized.result.rigId)!.nodes[0]!.sessionSource)
      .toEqual(sessionSource);
    const exported = app.rigSpecExporter.exportRig(materialized.result.rigId);
    expect("pods" in exported).toBe(true);
    if (!("pods" in exported)) return;
    expect(exported.pods[0]!.members[0]!.sessionSource).toEqual(sessionSource);
  });

  it("round-trips session_source through the bootstrap instantiate path", async () => {
    const sessionSource = {
      mode: "fork",
      ref: { kind: "native_id", value: "parent-session-id" },
    } as const;
    const outcome = await app.podInstantiator.instantiate(RigSpecCodec.serialize({
      version: "0.2",
      name: "session-source-bootstrap",
      pods: [{
        id: "dev",
        label: "Dev",
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
          sessionSource,
        }],
        edges: [],
      }],
      edges: [],
    }), RIG_ROOT);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const exported = app.rigSpecExporter.exportRig(outcome.result.rigId);
    expect("pods" in exported).toBe(true);
    if (!("pods" in exported)) return;
    expect(exported.pods[0]!.members[0]!.sessionSource).toEqual(sessionSource);
  });
});
