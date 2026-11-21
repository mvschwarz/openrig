// The rig setting `seat_slice: rig` (#80): validated and normalized from the spec, written back by the codec and the
// exporter, and stored on the rig record, where each seat launch reads it (TmuxAdapter.seatSliceRig, wired in startup.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createDaemon } from "../src/startup.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { RigSpec } from "../src/domain/types.js";

const rig = (extra: Record<string, unknown> = {}) => ({
  version: "0.2",
  name: "alpha",
  pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
  edges: [],
  ...extra,
});

describe("seat_slice in a rig spec", () => {
  it('accepts "rig" and absence; anything else is a spec error that names the one value', () => {
    expect(RigSpecSchema.validate(rig({ seat_slice: "rig" })).valid).toBe(true);
    expect(RigSpecSchema.validate(rig()).valid).toBe(true);
    for (const bad of [true, "Rig", "pod", "", null, { rig: true }]) {
      const result = RigSpecSchema.validate(rig({ seat_slice: bad }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('seat_slice: must be "rig" (omit it to keep seats ungrouped)');
    }
  });

  it("normalizes to seatSlice and round-trips through the codec; absent stays absent", () => {
    const on = RigSpecSchema.normalize(rig({ seat_slice: "rig" }));
    expect(on.seatSlice).toBe("rig");
    const again = RigSpecCodec.parse(RigSpecCodec.serialize(on)) as Record<string, unknown>;
    expect(again["seat_slice"]).toBe("rig");
    const off = RigSpecSchema.normalize(rig());
    expect(off).not.toHaveProperty("seatSlice");
    expect(RigSpecCodec.parse(RigSpecCodec.serialize(off))).not.toHaveProperty("seat_slice");
  });
});

describe("seat_slice on the rig record", () => {
  let db: Database.Database;
  let repo: RigRepository;
  beforeEach(() => { db = createFullTestDb(); repo = new RigRepository(db); });
  afterEach(() => db.close());

  it("each seat reads its own rig's grouping; a rig without it gives none", () => {
    const alpha = repo.createRig("alpha");
    const beta = repo.createRig("beta");
    const a = repo.addNode(alpha.id, "dev.impl", { runtime: "claude-code" });
    const b = repo.addNode(beta.id, "dev.impl", { runtime: "codex" });
    expect(repo.getNodeSeatSliceRig(a.id)).toBeUndefined();
    repo.setRigSeatSlice(alpha.id, "rig");
    expect(repo.getRigSeatSlice(alpha.id)).toBe("rig");
    expect(repo.getNodeSeatSliceRig(a.id)).toBe("alpha");
    expect(repo.getNodeSeatSliceRig(b.id)).toBeUndefined();
    expect(repo.getNodeSeatSliceRig("no-such-node")).toBeUndefined();
    repo.setRigSeatSlice(alpha.id, null);
    expect(repo.getNodeSeatSliceRig(a.id)).toBeUndefined();
  });

  it("the column refuses any value but rig", () => {
    const alpha = repo.createRig("alpha");
    expect(() => db.prepare("UPDATE rigs SET seat_slice = 'pod' WHERE id = ?").run(alpha.id)).toThrow(/CHECK/);
  });
});

describe("seat_slice from a spec to each seat launch", () => {
  it("leaves no rig behind if its grouping cannot be stored", async () => {
    const db = createFullTestDb();
    const setup = createTestApp(db, { podInstantiatorFsOps: {
      exists: () => true,
      readFile: () => 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n',
    } });
    try {
      db.exec("ALTER TABLE rigs DROP COLUMN seat_slice");
      const spec = RigSpecCodec.serialize(RigSpecSchema.normalize(rig({ seat_slice: "rig" })));
      const result = await setup.podInstantiator.instantiate(spec, "/work/fixture");
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, message: expect.stringContaining("migration is required") });
      expect(db.prepare("SELECT name FROM rigs").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("a rig created from a spec stores its grouping before any seat launches, and exports it", async () => {
    for (const declared of [true, false]) {
      const db = createFullTestDb();
      const bindings: NodeBinding[] = [];
      const adapter = { runtime: "claude-code", listInstalled: async () => [],
        project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async () => ({ delivered: 0, failed: [] }),
        launchHarness: async (b: NodeBinding) => { bindings.push(b); return { ok: true }; },
        checkReady: async () => ({ ready: true }) } as RuntimeAdapter;
      const agent = 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n';
      const setup = createTestApp(db, { adapters: { "claude-code": adapter }, podInstantiatorFsOps: {
        exists: (p: string) => p.includes("agents/impl"),
        readFile: (p: string) => { if (p.includes("agents/impl")) return agent; throw new Error("missing"); },
      } });
      try {
        const spec = RigSpecCodec.serialize(RigSpecSchema.normalize(rig(declared ? { name: "grouped", seat_slice: "rig" } : { name: "plain" })));
        const result = await setup.podInstantiator.instantiate(spec, "/work/fixture");
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const rigId = (result as { ok: true; result: { rigId: string } }).result.rigId;
        expect(setup.rigRepo.getRigSeatSlice(rigId)).toBe(declared ? "rig" : null);
        const node = setup.rigRepo.getRig(rigId)!.nodes[0]!;
        expect(setup.rigRepo.getNodeSeatSliceRig(node.id)).toBe(declared ? "grouped" : undefined);
        const exported = setup.rigSpecExporter.exportRig(rigId) as RigSpec;
        if (declared) expect(RigSpecCodec.serialize(exported)).toContain("seat_slice: rig");
        else expect(RigSpecCodec.serialize(exported)).not.toContain("seat_slice");
      } finally { db.close(); }
    }
  });

  it("the daemon's tmux adapter reads each seat's rig grouping at each launch (removing the wiring fails here)", async () => {
    const { db, deps } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "",
      cmuxFactory: async () => { throw Object.assign(new Error("fixture: no cmux"), { code: "ENOENT" }); } });
    try {
      const alpha = deps.rigRepo.createRig("alpha");
      const node = deps.rigRepo.addNode(alpha.id, "dev.impl", { runtime: "terminal" });
      expect(deps.tmuxAdapter.seatSliceRig?.(node.id)).toBeUndefined();
      deps.rigRepo.setRigSeatSlice(alpha.id, "rig");
      expect(deps.tmuxAdapter.seatSliceRig?.(node.id)).toBe("alpha");
    } finally { db.close(); }
  });
});
