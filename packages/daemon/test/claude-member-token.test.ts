import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecCodec, LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { isClaudeSeatTokenFallback, readClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import type { LegacyRigSpec, RigSpec } from "../src/domain/types.js";
import { createTestApp } from "./helpers/test-app.js";

// A Claude member can name its own subscription token file in the spec, so the seat's first launch already starts on
// that account. The spec and the seat's record hold the label and the path only; the file is read as Claude starts.

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
// There is no such file: storing the reference never reads it, and a launch starts with the existing fallback notice.
const tokenFile = path.join(tmpdir(), "no-such-dir-claude-member-token", "dev.token");
const ref = { label: "dev-sub", tokenFile };
const member = (extra: Record<string, unknown> = {}) => ({ id: "dev", agent_ref: "local:dev.agent.yaml", profile: "default",
  runtime: "claude-code", cwd: "/same/project", claude_token: { label: "dev-sub", file: tokenFile }, ...extra });
const spec = (m: Record<string, unknown>) => ({ version: "0.2", name: "tokens", pods: [{ id: "team", label: "Team", members: [m], edges: [] }], edges: [] });
const flat = (node: Record<string, unknown>) => ({ schema_version: 1, name: "flat", version: "1", nodes: [node], edges: [] });

function database() {
  const db = new Database(":memory:"); opened.push(db);
  migrate(db, ALL_MIGRATIONS);
  return db;
}

async function materialize(db: Database.Database) {
  const setup = createTestApp(db, { podInstantiatorFsOps: {
    readFile: () => 'name: dev\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []', exists: () => true,
  } });
  const raw = spec(member());
  expect(RigSpecSchema.validate(raw).errors).toEqual([]);
  const result = await setup.podInstantiator.materializeStructured(raw, "/project");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("not materialized");
  const rigId = result.result.rigId;
  const node = setup.rigRepo.getRig(rigId)!.nodes[0]!;
  const exporter = new RigSpecExporter({ rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, podRepo: new PodRepository(db) });
  return { setup, rigId, node, exported: () => RigSpecCodec.serialize(exporter.exportRig(rigId) as RigSpec) };
}

describe("a Claude member's own subscription token (claude_token)", () => {
  it("is stored on the seat when the rig is created, reaches each launch, and clears like a switched one", async () => {
    const db = database();
    const { setup, node, exported } = await materialize(db);
    expect(readClaudeSeatTokenRef(db, node.id)).toEqual(ref);
    const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin:/bin", HOME: tmpdir() }, {}, async () => undefined);
    // The first launch and a later one carry the same step; a file that can't be read gives the existing notice.
    for (let launch = 0; launch < 2; launch++) {
      const token = managed.seatTokenLaunch(node.id);
      expect(token?.ref).toEqual(ref);
      expect(token?.step).toContain(tokenFile);
      expect(token?.warnings.some(isClaudeSeatTokenFallback)).toBe(true);
    }
    // `rig provider switch --stored-login` clears the seat's reference through this same record.
    expect(setup.rigRepo.setNodeClaudeTokenRef(node.id, null)).toBe(true);
    expect(managed.seatTokenLaunch(node.id)).toBeNull();
    expect(exported()).not.toContain("claude_token");
  });

  it("exports the seat's current reference, on pod members and on legacy flat nodes", async () => {
    const db = database();
    const { exported } = await materialize(db);
    const parsed = RigSpecCodec.parse(exported());
    expect(RigSpecSchema.normalize(parsed).pods[0]!.members[0]!.claudeTokenRef).toEqual(ref);

    expect(LegacyRigSpecSchema.validate(flat({ id: "dev", runtime: "claude-code", claude_token: { label: "dev-sub", file: tokenFile } })).errors).toEqual([]);
    const flatDb = database(), repo = new RigRepository(flatDb), rig = repo.createRig("flat");
    const node = repo.addNode(rig.id, "dev", { runtime: "claude-code", cwd: "/same/project", claudeTokenRef: ref });
    expect(readClaudeSeatTokenRef(flatDb, node.id)).toEqual(ref);
    const flatSpec = new RigSpecExporter({ rigRepo: repo, sessionRegistry: new SessionRegistry(flatDb) }).exportRig(rig.id);
    const flatParsed = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(flatSpec as LegacyRigSpec));
    expect(LegacyRigSpecSchema.normalize(flatParsed).nodes[0]!.claudeTokenRef).toEqual(ref);
    expect(() => repo.addNode(rig.id, "other", { runtime: "codex", claudeTokenRef: ref })).toThrow(/claude_token/);
  });

  it.each([
    ["a label that doesn't start with a letter or digit", { claude_token: { label: "-dev", file: tokenFile } }],
    ["a relative token file", { claude_token: { label: "dev-sub", file: "tokens/dev.token" } }],
    ["a bare path", { claude_token: tokenFile }],
    ["no file", { claude_token: { label: "dev-sub" } }],
    ["a field besides label and file", { claude_token: { label: "dev-sub", file: tokenFile, token: "not-a-token" } }],
    ["a seat that isn't Claude", { runtime: "codex" }],
  ])("refuses %s when the spec is validated", (_why, extra) => {
    // The field's own refusal, not the one any unknown key gets.
    const named = (errors: string[]) => errors.filter((error) => error.includes("claude_token") && !error.includes("unknown key"));
    expect(named(RigSpecSchema.validate(spec(member(extra))).errors)).not.toEqual([]);
    const node = { id: "dev", runtime: "claude-code", claude_token: { label: "dev-sub", file: tokenFile }, ...extra };
    expect(named(LegacyRigSpecSchema.validate(flat(node)).errors)).not.toEqual([]);
  });
});
