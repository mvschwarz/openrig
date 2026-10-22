// OPR.0.7.0.13 (Codex C2, Root's A and B). A: one constant pointer in the project's managed guidance, the same for every
// pod-mate, naming no seat, path or skill, and telling a non-OpenRig agent it doesn't apply. B: the seat mode of
// `rig skill loadout`, which reconciles a seat's stored selection and tells its running occupant once, reporting only
// the transport's own evidence, bound to the occupant that received it, and never resending an uncertain attempt.
// Hermetic: real catalog, reconciler and adapter writes; the transport is a scripted sender. Native Codex behaviour
// (compaction, resume, fork, handover discovery) is NOT RUN here.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";
import { seatSkillLocation, seatSkillPaths, writeSeatSkillCatalog } from "../src/domain/seat-skill-storage.js";
import { applySeatSkills, inspectSeatSkills, type SeatRef, type SeatSkillSender } from "../src/domain/seat-skill-apply.js";
import { reanchorBuiltinStartupFile } from "../src/domain/builtin-startup-files.js";

const POINTER = resolve(fileURLToPath(new URL(".", import.meta.url)), "../assets/guidance/openrig-seat-skills.md");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = (name: string) => { const dir = mkdtempSync(join(tmpdir(), name)); roots.push(dir); return dir; };
// The daemon's own schema, with the outbox each `--apply` attempt is reserved in.
const dbs: Array<{ close(): void }> = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const daemonDb = () => { const db = createDb(); migrate(db, ALL_MIGRATIONS); dbs.push(db); return db; };

describe("A: the constant seat-skills pointer in the project's guidance", () => {
  const text = readFileSync(POINTER, "utf8");

  it("is the one constant line: it names no seat, path or skill, sends a managed seat to its own list and router, and tells anyone else it doesn't apply", () => {
    expect(text).toBe("OpenRig seat skills: if `OPENRIG_SESSION_NAME` is set, run `rig skill loadout --seat self` and use the router skill it names; if it isn't set, this line doesn't apply to you.\n");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(text).not.toMatch(/@|\/state\/seats|SKILL\.md|openrig:/);
  });

  it("is one identical managed block in a shared AGENTS.md, however many pod-mates merge it", async () => {
    const project = scratch("seat-pointer-");
    const fsOps = {
      readFile: (p: string) => readFileSync(p, "utf8"), writeFile: (p: string, c: string) => writeFileSync(p, c),
      exists: (p: string) => existsSync(p), mkdirp: (p: string) => { mkdirSync(p, { recursive: true }); }, copyFile: () => {},
    };
    const adapter = new CodexRuntimeAdapter({
      fsOps, tmux: new Proxy({}, { get() { throw new Error("No tmux calls allowed"); } }) as never,
      listProcesses: () => { throw new Error("No process survey allowed"); },
    });
    const file = { path: "openrig-seat-skills.md", absolutePath: POINTER, ownerRoot: resolve(POINTER, "../.."), deliveryHint: "guidance_merge" as const, required: false, appliesOn: ["fresh_start", "restore"] as ("fresh_start" | "restore")[] };
    for (const seat of ["dev-impl@team", "dev-qa@team"]) {
      await adapter.deliverStartup([file], { id: seat, nodeId: seat, tmuxSession: null, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: project });
    }
    const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(agents.split("BEGIN OpenRig MANAGED BLOCK: openrig-seat-skills.md").length - 1).toBe(1);
    expect(agents).toContain(text.trim());
    expect(agents).not.toMatch(/dev-impl|dev-qa/);
  });

  it("is a built-in, so a restore after an upgrade follows the running install's copy", () => {
    const moved = reanchorBuiltinStartupFile({ path: "openrig-seat-skills.md", absolutePath: "/old/install/packages/daemon/assets/guidance/openrig-seat-skills.md",
      ownerRoot: "/old/install/packages/daemon/assets", deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] }, undefined, undefined, (p) => p === POINTER);
    expect(moved.absolutePath).toBe(POINTER);
  });
});

function catalogWith(ids: Record<string, string>): { root: string; catalog: string; commit: () => void } {
  const root = scratch("seat-apply-");
  const catalog = join(root, "skills");
  mkdirSync(catalog, { recursive: true });
  const write = () => {
    for (const [id, trigger] of Object.entries(ids)) {
      mkdirSync(join(catalog, id), { recursive: true });
      writeFileSync(join(catalog, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${trigger}\n---\n\n# ${id}\n`);
    }
  };
  write();
  writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@openrig.invalid"); git("config", "user.name", "T");
  const commit = () => { write(); git("add", "."); git("commit", "-qm", "c", "--allow-empty"); };
  commit();
  return { root, catalog, commit };
}

describe("B: `rig skill loadout --seat` reconciles a seat's own selection and tells its occupant once, by the transport's evidence", () => {
  function seatFixture() {
    const ids: Record<string, string> = { "queue-handoff": "Use when handing work to another seat." };
    const cat = catalogWith(ids);
    const home = scratch("seat-apply-home-");
    const seat: SeatRef = { nodeId: "node-1", rigId: `rig-${Math.random().toString(36).slice(2)}`, logicalId: "dev.impl", runtime: "codex", sessionName: "dev-impl@team", cwd: join(home, "project") };
    mkdirSync(seat.cwd, { recursive: true });
    const paths = seatSkillPaths({ rigId: seat.rigId, logicalId: seat.logicalId, runtime: "codex" });
    // The seat's launch: its selection recorded in its own storage.
    const resolved = resolveSkillLoadout({ catalogRoot: cat.catalog, topologySkills: ["queue-handoff"] });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));
    expect(reconcileSkillLoadout({ loadout: resolved.loadout, runtime: "codex", cwd: seat.cwd, apply: true, topologyOwner: seat.sessionName, location: seatSkillLocation(paths, "codex") }).ok).toBe(true);
    const sent: Array<{ text: string; deliveryId: string }> = [];
    const sender = (outcome: string, extra: Partial<{ ok: boolean; error: string }> = {}): SeatSkillSender => ({
      send: async (_s, text, opts) => { sent.push({ text, deliveryId: opts.deliveryId }); return { ok: outcome !== "failed", outcome: outcome as never, ...extra }; },
    });
    return { ids, cat, seat, paths, sent, sender, db: daemonDb() };
  }

  it("sends the seat's list once to its occupant, and not again while the list is unchanged", async () => {
    const f = seatFixture();
    const first = await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-1", catalogRoot: f.cat.catalog, sender: f.sender("delivered") });
    expect(first.disk.ok).toBe(true);
    expect(first.delivery).toMatchObject({ state: "sent", record: { occupant: "gen-1", outcome: "delivered" } });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).toContain("- **queue-handoff**: Use when handing work to another seat.");
    const again = await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-1", catalogRoot: f.cat.catalog, sender: f.sender("delivered") });
    expect(again.delivery).toMatchObject({ state: "already-delivered" });
    expect(f.sent).toHaveLength(1);
  });

  it("never treats an unconfirmed, retained, failed or thrown attempt as delivered, and doesn't resend it blindly", async () => {
    for (const outcome of ["rendered-unconfirmed", "retained", "failed", "throws"] as const) {
      const f = seatFixture();
      const sender: SeatSkillSender = outcome === "throws"
        ? { send: async () => { f.sent.push({ text: "", deliveryId: "" }); throw new Error("daemon timed out"); } }
        : f.sender(outcome);
      const first = await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-1", catalogRoot: f.cat.catalog, sender });
      // What the transport said is reported as it said it; the attempt's record is the outbox's state.
      expect(first.delivery, outcome).toMatchObject({ state: "sent", transportOutcome: outcome === "throws" ? "unknown" : outcome,
        record: { outcome: outcome === "retained" ? "retained" : outcome === "failed" ? "failed" : "unconfirmed" } });
      const again = await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-1", catalogRoot: f.cat.catalog, sender: f.sender("delivered") });
      expect(again.delivery, outcome).toMatchObject({ state: "earlier-attempt-unconfirmed", record: { deliveryId: first.delivery.state === "sent" ? first.delivery.record.deliveryId : "" } });
      expect(f.sent, outcome).toHaveLength(1);
      // Disk success is reported either way.
      expect(again.disk.ok, outcome).toBe(true);
    }
  });

  it("doesn't count a predecessor's delivery for a fresh successor in the same seat", async () => {
    const f = seatFixture();
    await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-1", catalogRoot: f.cat.catalog, sender: f.sender("delivered") });
    const successor = await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-2", catalogRoot: f.cat.catalog, sender: f.sender("delivered") });
    expect(successor.delivery).toMatchObject({ state: "sent", record: { occupant: "gen-2" } });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.deliveryId).not.toBe(f.sent[0]!.deliveryId);
  });

  it("reconciles a changed catalog into the seat's storage, and sends the changed list as a replacement", async () => {
    const f = seatFixture();
    await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-1", catalogRoot: f.cat.catalog, sender: f.sender("delivered") });
    f.ids["queue-handoff"] = "Use when handing work to another seat, with its row.";
    f.cat.commit();
    const changed = await applySeatSkills({ db: f.db, seat: f.seat, occupant: "gen-1", catalogRoot: f.cat.catalog, sender: f.sender("delivered") });
    expect(changed.disk.ok).toBe(true);
    expect(readFileSync(join(f.paths.skillsRoot, "queue-handoff", "SKILL.md"), "utf8")).toContain("with its row.");
    expect(changed.delivery).toMatchObject({ state: "sent" });
    expect(f.sent[1]!.text).toContain("This list replaces any earlier OpenRig skill list in this conversation.");
    expect(f.sent[1]!.text).toContain("with its row.");
  });

  it("reads without changing anything, and says why it sends nothing to a seat it can't tell", async () => {
    const f = seatFixture();
    writeSeatSkillCatalog(f.paths);
    const before = readFileSync(f.paths.catalogPath, "utf8");
    const seen = inspectSeatSkills(f.seat, "gen-1", f.db);
    expect(seen.skills).toEqual([{ id: "queue-handoff", trigger: "Use when handing work to another seat.", path: join(f.paths.skillsRoot, "queue-handoff", "SKILL.md") }]);
    expect(seen.delivery).toBeNull();
    expect(readFileSync(f.paths.catalogPath, "utf8")).toBe(before);
    expect((await applySeatSkills({ db: f.db, seat: f.seat, occupant: null, catalogRoot: f.cat.catalog, sender: f.sender("delivered") })).delivery)
      .toEqual({ state: "not-sent", reason: "the seat has no running occupant to send to" });
    const claude = { ...f.seat, runtime: "claude-code" as const, rigId: `${f.seat.rigId}-c` };
    expect((await applySeatSkills({ db: f.db, seat: claude, occupant: "gen-1", catalogRoot: f.cat.catalog, sender: f.sender("delivered") })).delivery.state).toBe("not-sent");
    expect(f.sent).toHaveLength(0);
  });
});

describe("B: the seat routes", () => {
  it("inspect a seat by its session, and say what's wrong with an unknown or missing one", async () => {
    const { createFullTestDb, createTestApp } = await import("./helpers/test-app.js");
    const { RigRepository } = await import("../src/domain/rig-repository.js");
    const { SessionRegistry } = await import("../src/domain/session-registry.js");
    const db = createFullTestDb();
    migrate(db, ALL_MIGRATIONS);
    try {
      const rigRepo = new RigRepository(db);
      const rig = rigRepo.createRig("seat-routes");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
      new SessionRegistry(db).registerSession(node.id, "dev-impl@seat-routes");
      const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "codex" });
      mkdirSync(join(paths.skillsRoot, "queue-handoff"), { recursive: true });
      writeFileSync(join(paths.skillsRoot, "queue-handoff", "SKILL.md"), "---\nname: queue-handoff\ndescription: Use when handing work on.\n---\n\nbody\n");
      const { app } = createTestApp(db);
      const get = (q: string) => app.request(`/api/skills/seat${q}`, { headers: { Host: "127.0.0.1:7433" } });
      const seen = await get("?session=dev-impl%40seat-routes");
      expect(seen.status).toBe(200);
      expect(await seen.json()).toMatchObject({ seat: { logicalId: "dev.impl", runtime: "codex" }, storage: paths.root,
        skills: [{ id: "queue-handoff", trigger: "Use when handing work on." }] });
      expect((await get("?session=nobody%40nowhere")).status).toBe(404);
      expect((await get("")).status).toBe(400);
      rmSync(paths.root, { recursive: true, force: true });
    } finally {
      db.close();
    }
  });
});
