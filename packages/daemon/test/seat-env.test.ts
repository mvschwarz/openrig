import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import type { RigSpec } from "../src/domain/types.js";
import {
  mergeSeatEnv,
  parseSeatEnvAssignment,
  seatEnvLaunchVars,
  SEAT_ENV_KEYS_VAR,
} from "../src/domain/seat-env.js";
import { createFullTestDb } from "./helpers/test-app.js";

function rigWith(overrides: { rig?: Record<string, unknown>; member?: Record<string, unknown> }) {
  return {
    version: "0.2",
    name: "env-rig",
    ...overrides.rig,
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...overrides.member }],
      edges: [],
    }],
    edges: [],
  };
}

describe("env: in rig.yaml", () => {
  it("accepts env at rig level and member level and normalizes both", () => {
    const raw = rigWith({ rig: { env: { RIG_FLAG: "1" } }, member: { env: { MEMBER_FLAG: "two", RIG_FLAG: "member-wins" } } });
    expect(RigSpecSchema.validate(raw)).toMatchObject({ valid: true });
    const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
    expect(spec.env).toEqual({ RIG_FLAG: "1" });
    expect(spec.pods[0]!.members[0]!.env).toEqual({ MEMBER_FLAG: "two", RIG_FLAG: "member-wins" });
  });

  it("leaves env undefined when none is declared", () => {
    const spec = RigSpecSchema.normalize(rigWith({}) as Record<string, unknown>);
    expect(spec.env).toBeUndefined();
    expect(spec.pods[0]!.members[0]!.env).toBeUndefined();
  });

  it.each([
    ["a lowercase name", { env: { lower: "x" } }, 'env.lower'],
    ["a name starting with a digit", { env: { "1BAD": "x" } }, 'env.1BAD'],
    ["a name with a dash", { env: { "BAD-NAME": "x" } }, 'env.BAD-NAME'],
    ["a reserved OPENRIG_ name", { env: { OPENRIG_URL: "http://elsewhere" } }, "reserved"],
    ["a number value", { env: { COUNT: 3 } }, "must be a string"],
    ["a boolean value", { env: { FLAG: true } }, "must be a string"],
    ["an empty value", { env: { EMPTY: "" } }, "must not be empty"],
    ["a list", { env: ["A=1"] }, "must be a mapping"],
    ["null", { env: null }, "must be a mapping"],
  ])("refuses %s at rig level", (_label, rig, fragment) => {
    const result = RigSpecSchema.validate(rigWith({ rig }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(fragment);
  });

  it("refuses the same mistakes at member level and names the member path", () => {
    const result = RigSpecSchema.validate(rigWith({ member: { env: { OPENRIG_NODE_ID: "x", ok: "y" } } }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("pods[0].members[0].env.OPENRIG_NODE_ID");
    expect(result.errors.join("\n")).toContain("pods[0].members[0].env.ok");
  });

  it("round-trips through serialize and parse", () => {
    const spec = RigSpecSchema.normalize(rigWith({ rig: { env: { A: "1" } }, member: { env: { B: "2" } } }) as Record<string, unknown>) as RigSpec;
    const parsed = RigSpecCodec.parse(RigSpecCodec.serialize(spec));
    expect(RigSpecSchema.validate(parsed).valid).toBe(true);
    const again = RigSpecSchema.normalize(parsed as Record<string, unknown>);
    expect(again.env).toEqual({ A: "1" });
    expect(again.pods[0]!.members[0]!.env).toEqual({ B: "2" });
  });
});

describe("--env KEY=VALUE", () => {
  it("splits at the first equals sign so a value can contain one", () => {
    expect(parseSeatEnvAssignment("URL=http://x/?a=b")).toEqual({ ok: true, name: "URL", value: "http://x/?a=b" });
  });

  it.each(["NOEQUALS", "=value", "lower=x", "OPENRIG_HOME=/x", "EMPTY="])("refuses %s", (text) => {
    expect(parseSeatEnvAssignment(text).ok).toBe(false);
  });
});

describe("merging", () => {
  it("applies rig, then member, then a one-off override", () => {
    expect(mergeSeatEnv({ A: "rig", B: "rig" }, { B: "member", C: "member" }, { C: "override" }))
      .toEqual({ A: "rig", B: "member", C: "override" });
  });

  it("lists the declared names for the managed Claude launch, and nothing when none are declared", () => {
    expect(seatEnvLaunchVars({ A: "1", B: "2" })).toEqual({ A: "1", B: "2", [SEAT_ENV_KEYS_VAR]: "A,B" });
    expect(seatEnvLaunchVars({})).toEqual({});
  });
});

describe("persisted env", () => {
  let db: Database.Database;
  afterEach(() => db.close());

  it("stores rig env and member env apart, reads them merged, and exports both", () => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("env-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Dev");
    const impl = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: pod.id, agentRef: "local:a", profile: "p", cwd: ".", env: { SHARED: "member", ONLY_MEMBER: "m" } });
    const plain = rigRepo.addNode(rig.id, "dev.plain", { runtime: "codex", podId: pod.id, agentRef: "local:b", profile: "p", cwd: "." });
    rigRepo.setRigEnv(rig.id, { SHARED: "rig", ONLY_RIG: "r" });

    expect(rigRepo.getEffectiveSeatEnv(impl.id)).toEqual({ SHARED: "member", ONLY_MEMBER: "m", ONLY_RIG: "r" });
    expect(rigRepo.getEffectiveSeatEnv(plain.id)).toEqual({ SHARED: "rig", ONLY_RIG: "r" });

    const exported = new RigSpecExporter({ rigRepo, sessionRegistry: new SessionRegistry(db), podRepo }).exportRig(rig.id) as RigSpec;
    expect(exported.env).toEqual({ SHARED: "rig", ONLY_RIG: "r" });
    const members = exported.pods[0]!.members;
    expect(members.find((m) => m.id === "impl")!.env).toEqual({ SHARED: "member", ONLY_MEMBER: "m" });
    expect(members.find((m) => m.id === "plain")!.env).toBeUndefined();
  });
});
