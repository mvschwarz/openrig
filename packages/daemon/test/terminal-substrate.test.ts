import { describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { readStoredSubstrate, resolveTerminalSubstrate, substrateFence } from "../src/domain/terminal-substrate.js";
import { seatTerminalSubstrate } from "../src/domain/terminal-substrate-host.js";
import { createTerminalRouter, SubstrateResolver } from "../src/adapters/terminal-router.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

/** Like a real adapter, the verbs live on the prototype (the router passes an adapter's own fields through). */
function fakeTmux() {
  return Object.create({
    sendText: vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: vi.fn(async () => "tmux screen"),
    probeSession: vi.fn(async () => ({ state: "present" as const })),
    createSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => [{ name: "s", windows: 1, created: "", attached: false }]),
    deliveryGuard: undefined as unknown,
  });
}

function seatDb() {
  const db = createFullTestDb();
  const repo = new RigRepository(db);
  const rig = repo.createRig("mixed");
  const tmuxNode = repo.addNode(rig.id, "dev.old", { runtime: "terminal" });
  const herdrNode = repo.addNode(rig.id, "dev.new", { runtime: "terminal", terminalSubstrate: "herdr" });
  return { db, repo, rig, tmuxNode, herdrNode };
}

describe("terminal substrate: precedence and stored values", () => {
  it("member > rig > host > tmux", () => {
    expect(resolveTerminalSubstrate({})).toBe("tmux");
    expect(resolveTerminalSubstrate({ hostDefault: "herdr" })).toBe("herdr");
    expect(resolveTerminalSubstrate({ rig: "tmux", hostDefault: "herdr" })).toBe("tmux");
    expect(resolveTerminalSubstrate({ member: "herdr", rig: "tmux", hostDefault: "tmux" })).toBe("herdr");
    expect(seatTerminalSubstrate(undefined, undefined, () => "herdr")).toBe("herdr");
    expect(seatTerminalSubstrate({ terminalSubstrate: "tmux" }, { terminalSubstrate: "herdr" }, () => "herdr")).toBe("tmux");
  });

  it("a stored value reads as tmux when absent and as unknown when not known, never as tmux", () => {
    expect(readStoredSubstrate(null)).toEqual({ kind: "tmux" });
    expect(readStoredSubstrate("herdr")).toEqual({ kind: "herdr" });
    expect(readStoredSubstrate("zellij")).toEqual({ kind: "unknown", value: "zellij" });
  });

  it("stores herdr on the node and leaves tmux as NULL", () => {
    const { db, tmuxNode, herdrNode } = seatDb();
    const rows = db.prepare("SELECT id, terminal_substrate FROM nodes").all() as Array<{ id: string; terminal_substrate: string | null }>;
    expect(rows.find(r => r.id === tmuxNode.id)?.terminal_substrate).toBeNull();
    expect(rows.find(r => r.id === herdrNode.id)?.terminal_substrate).toBe("herdr");
  });
});

describe("terminal substrate: rig spec", () => {
  const spec = (memberExtra: string, rigExtra = "") => `
version: "0.2"
name: t
${rigExtra}
pods:
  - id: dev
    label: Dev
    members:
      - id: a
        agent_ref: "builtin:terminal"
        runtime: terminal
        profile: none
        cwd: "."
${memberExtra}
    edges: []
edges: []
`;
  it("accepts tmux/herdr on a member and on the rig, and rejects other values", () => {
    expect(RigSpecSchema.validate(RigSpecCodec.parse(spec("        terminal_substrate: herdr", "terminal_substrate: tmux"))).valid).toBe(true);
    const bad = RigSpecSchema.validate(RigSpecCodec.parse(spec("        terminal_substrate: zellij")));
    expect(bad.valid).toBe(false);
    expect(bad.errors.join("\n")).toMatch(/terminal_substrate: must be one of "tmux", "herdr"/);
  });

  it("normalizes and round-trips the field", () => {
    const parsed = RigSpecSchema.normalize(RigSpecCodec.parse(spec("        terminal_substrate: herdr", "terminal_substrate: tmux")) as Record<string, unknown>);
    expect(parsed.terminalSubstrate).toBe("tmux");
    expect(parsed.pods[0]!.members[0]!.terminalSubstrate).toBe("herdr");
    const again = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(parsed)) as Record<string, unknown>);
    expect(again.pods[0]!.members[0]!.terminalSubstrate).toBe("herdr");
    expect(again.terminalSubstrate).toBe("tmux");
  });
});

describe("terminal router", () => {
  it("sends everything to tmux when no seat has another substrate", async () => {
    const db = createFullTestDb();
    const tmux = fakeTmux();
    const router = createTerminalRouter(tmux as unknown as TmuxAdapter, { resolver: new SubstrateResolver(db) });
    await router.sendText("dev-a@r", "hi");
    expect(await router.capturePaneContent("%3")).toBe("tmux screen");
    expect(await router.listSessions()).toHaveLength(1);
    expect(tmux.sendText).toHaveBeenCalledWith("dev-a@r", "hi");
  });

  it("routes a Herdr seat by canonical name, binding pane, Herdr pane id and creating node, and refuses without an adapter", async () => {
    const { db, herdrNode } = seatDb();
    const tmux = fakeTmux();
    const router = createTerminalRouter(tmux as unknown as TmuxAdapter, { resolver: new SubstrateResolver(db) });
    const refused = await router.sendText("dev-new@mixed", "hi");
    expect(refused).toMatchObject({ ok: false, code: "herdr_unavailable" });
    expect(await router.probeSession("dev-new@mixed")).toMatchObject({ state: "transport_unavailable" });
    await expect(router.capturePaneContent("w1:p1")).rejects.toMatchObject({ code: "herdr_unavailable" });
    expect(await router.createSession("dev-new@mixed", "/tmp", { OPENRIG_NODE_ID: herdrNode.id })).toMatchObject({ ok: false });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    // The tmux seat in the same rig still reaches tmux.
    await router.sendText("dev-old@mixed", "hi");
    expect(tmux.sendText).toHaveBeenCalledWith("dev-old@mixed", "hi");
  });

  it("dispatches a Herdr seat to the Herdr adapter and shares the delivery guard", async () => {
    const { db } = seatDb();
    const tmux = fakeTmux();
    const herdr = Object.create({ sendText: vi.fn(async () => ({ ok: true as const })) });
    const router = createTerminalRouter(tmux as unknown as TmuxAdapter, { resolver: new SubstrateResolver(db), herdr: herdr as unknown as TmuxAdapter });
    await router.sendText("dev-new@mixed", "hi");
    expect(herdr.sendText).toHaveBeenCalledWith("dev-new@mixed", "hi");
    const guard = { marker: 1 };
    (router as unknown as { deliveryGuard: unknown }).deliveryGuard = guard;
    expect(herdr.deliveryGuard).toBe(guard);
    expect(tmux.deliveryGuard).toBe(guard);
  });

  it("refuses an unknown stored substrate and never sends it to tmux", async () => {
    const { db, herdrNode } = seatDb();
    db.prepare("UPDATE nodes SET terminal_substrate = 'zellij' WHERE id = ?").run(herdrNode.id);
    const tmux = fakeTmux();
    const router = createTerminalRouter(tmux as unknown as TmuxAdapter, { resolver: new SubstrateResolver(db) });
    expect(await router.sendText("dev-new@mixed", "hi")).toMatchObject({ ok: false, code: "substrate_unknown" });
    await expect(router.capturePaneContent("dev-new@mixed")).rejects.toMatchObject({ code: "substrate_unknown" });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });
});

describe("terminal substrate: service fences (design §5)", () => {
  it("refuses out-of-scope operations on a Herdr seat, allows tmux, and refuses an unknown value", () => {
    const { db, tmuxNode, herdrNode } = seatDb();
    expect(substrateFence(db, tmuxNode.id, "Seat handover")).toBeNull();
    expect(substrateFence(db, herdrNode.id, "Seat handover")).toMatchObject({ ok: false, code: "herdr_unsupported", message: expect.stringMatching(/^Seat handover is not supported/) });
    db.prepare("UPDATE nodes SET terminal_substrate = 'zellij' WHERE id = ?").run(herdrNode.id);
    expect(substrateFence(db, herdrNode.id, "A runtime switch")).toMatchObject({ code: "substrate_unknown" });
  });
});

describe("terminal router review fixes", () => {
  it("F1: a non-decimal Herdr pane id routes to Herdr, never tmux", async () => {
    const db = createFullTestDb();
    const tmux = fakeTmux();
    const router = createTerminalRouter(tmux as unknown as TmuxAdapter, { resolver: new SubstrateResolver(db) });
    await expect(router.capturePaneContent("w3A:p2")).rejects.toMatchObject({ code: "herdr_unavailable" });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("F2: a seat created after the cache loaded routes by node and then by name", async () => {
    const db = createFullTestDb();
    const repo = new RigRepository(db);
    const rig = repo.createRig("late");
    const resolver = new SubstrateResolver(db, 60_000);
    expect(resolver.forTarget("dev-new@late")).toEqual({ kind: "tmux" }); // cache loaded, no Herdr seat yet
    const node = repo.addNode(rig.id, "dev.new", { runtime: "terminal", terminalSubstrate: "herdr" });
    expect(resolver.forNode(node.id)).toEqual({ kind: "herdr" });
    expect(resolver.forTarget("dev-new@late")).toEqual({ kind: "herdr" });
  });
});

describe("terminal router: batched capture in a mixed rig (M4 finding)", () => {
  it("splits a mixed batch: tmux seats through tmux's batch, a Herdr seat on its own, never a null for the batch", async () => {
    const { db } = seatDb();
    const tmuxBatch = vi.fn(async (targets: string[]) => new Map(targets.map(t => [t, { text: `tmux:${t}`, capturedAt: new Date(0) }])));
    const tmux = Object.create({ capturePanesContent: tmuxBatch, capturePaneContent: vi.fn(async () => "wrong") });
    const herdr = Object.create({ capturePaneContent: vi.fn(async (t: string) => `herdr:${t}`) });
    const router = createTerminalRouter(tmux as TmuxAdapter, { resolver: new SubstrateResolver(db), herdr: herdr as TmuxAdapter });
    const out = await router.capturePanesContent(["dev-old@mixed", "dev-new@mixed"], 50);
    expect(out?.get("dev-old@mixed")?.text).toBe("tmux:dev-old@mixed");
    expect(out?.get("dev-new@mixed")?.text).toBe("herdr:dev-new@mixed");
    expect(tmuxBatch).toHaveBeenCalledWith(["dev-old@mixed"], 50, expect.any(Function));
  });
});
