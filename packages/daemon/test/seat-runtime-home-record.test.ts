// Recording the runtime home an existing seat's original conversation lives under (rig seat record-runtime-home):
// what is written and where, what it's recorded against, and everything it leaves alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { effectiveRuntimeHome } from "../src/domain/seat-runtime-home.js";
import { observeRuntimeHome, selectedHomePlan } from "../src/domain/seat-runtime-home-record.js";

const ORIGINAL = "019a0000-0000-7000-8000-00000000a11a";

describe("rig seat record-runtime-home", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  let root: string;
  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    root = mkdtempSync(path.join(tmpdir(), "runtime-home-record-"));
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }); });

  /** A Codex home holding a rollout for the original, as Codex files them. */
  function codexHome(name: string, withOriginal = true) {
    const home = path.join(root, name);
    mkdirSync(path.join(home, "sessions", "2026", "11", "13"), { recursive: true });
    if (withOriginal) writeFileSync(path.join(home, "sessions", "2026", "11", "13", `rollout-2026-11-13T01-00-00-${ORIGINAL}.jsonl`), "{}\n");
    return home;
  }

  function seat(opts: { env?: Record<string, string>; accountHome?: string } = {}) {
    const rig = setup.rigRepo.createRig("homes");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", ...(opts.env ? { env: opts.env } : {}) });
    if (opts.accountHome) db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(opts.accountHome, node.id);
    db.prepare("UPDATE nodes SET claude_token_ref = 'token-ref-kept' WHERE id = ?").run(node.id);
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@homes");
    setup.sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("UPDATE sessions SET resume_type = 'codex_id', resume_token = ? WHERE id = ?").run(ORIGINAL, session.id);
    const generation = setup.sessionRegistry.mintOccupantTenure(node.id, "initial", ORIGINAL).generationUuid;
    return { rig, node, session, generation };
  }

  const read = async () => {
    const res = await setup.app.request("/api/seat/runtime-home/dev.impl");
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const record = async (body: Record<string, unknown>) => {
    const res = await setup.app.request("/api/seat/record-runtime-home/dev.impl", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "home after recovery", ...body }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const nodeRow = (id: string) => db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Record<string, unknown>;
  const counts = () => ({
    records: (db.prepare("SELECT COUNT(*) AS n FROM seat_runtime_home_records").get() as { n: number }).n,
    events: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'seat.runtime_home_recorded'").get() as { n: number }).n,
  });

  it("with the same original in homes A and B, records B for the next launch, and claims nothing about which copy is fresher", async () => {
    const a = codexHome("a"), b = codexHome("b");
    const s = seat({ env: { CODEX_HOME: a, OPENAI_BASE_URL: "https://proxy.example" } });
    const before = await read();
    expect(before.body).toMatchObject({ ok: true, runtime: "codex", variable: "CODEX_HOME", home: a, source: "member",
      occupantGeneration: s.generation, original: ORIGINAL, revision: 0, record: null });

    const recorded = await record({ home: b, expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-home-b-0001" });

    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({ ok: true, from: { home: a, source: "member" }, to: b, slot: "member_env", revision: 1,
      original: ORIGINAL, occupantGeneration: s.generation, changed: true, replayed: false, effect: "next_launch",
      observation: { home: "present", original: "found", runningProcess: "unverified" } });
    expect(JSON.stringify(recorded.body)).not.toMatch(/fresh/i);
    // Only the home variable changed in the member's env; the next launch reads B.
    expect(JSON.parse(nodeRow(s.node.id).env_json as string)).toEqual({ CODEX_HOME: b, OPENAI_BASE_URL: "https://proxy.example" });
    expect(effectiveRuntimeHome(db, s.node.id, "codex", undefined)).toBe(b);
    expect((await read()).body).toMatchObject({ home: b, revision: 1, record: { revision: 1, home: b, slot: "member_env", original: ORIGINAL } });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.runtime_home_recorded'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ from: a, to: b, revision: 1, operationId: "op-home-b-0001", reason: "home after recovery" });
  });

  it("records a home that's missing, or holds no record of the original, and says so instead of refusing", async () => {
    const s = seat();
    const missing = path.join(root, "not-yet");
    const first = await record({ home: missing, expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-missing-0001" });
    expect(first.body).toMatchObject({ ok: true, from: { home: null, source: "native_default" }, to: missing, observation: { home: "missing", original: "unknown" } });
    const empty = codexHome("empty", false);
    const second = await record({ home: empty, expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 1, operationId: "op-empty-0001" });
    expect(second.body).toMatchObject({ ok: true, revision: 2, observation: { home: "present", original: "not_found", runningProcess: "unverified" } });
  });

  it.each([
    ["occupant", { expectedOccupant: "an-earlier-generation" }],
    ["original", { expectedOriginal: "019a-some-other-conversation" }],
    ["revision", { expectedRevision: 3 }],
  ])("a stale %s applies nothing and reports the current values", async (_name, stale) => {
    const s = seat({ env: { CODEX_HOME: codexHome("a") } });
    const env = nodeRow(s.node.id).env_json;
    const result = await record({ home: codexHome("b"), expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0,
      operationId: "op-stale-0001", ...stale });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false, code: "runtime_home_conflict", applied: false,
      current: { occupantGeneration: s.generation, original: ORIGINAL, revision: 0 } });
    expect(nodeRow(s.node.id).env_json).toBe(env);
    expect(counts()).toEqual({ records: 0, events: 0 });
  });

  it("doesn't apply to a replacement occupant: a successor's own conversation is a conflict", async () => {
    const s = seat();
    const successor = setup.sessionRegistry.registerSession(s.node.id, "dev-impl@homes");
    db.prepare("UPDATE sessions SET resume_token = 'successor-conversation' WHERE id = ?").run(successor.id);
    setup.sessionRegistry.mintOccupantTenure(s.node.id, "fresh", "successor-conversation");
    const result = await record({ home: codexHome("b"), expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-successor-01" });
    expect(result.body).toMatchObject({ ok: false, code: "runtime_home_conflict", current: { original: "successor-conversation" } });
    expect(counts()).toEqual({ records: 0, events: 0 });
  });

  it("a repeat, or a retry after an unknown result, returns what was recorded once; the same id for another request applies nothing", async () => {
    const s = seat();
    const b = codexHome("b");
    const body = { home: b, expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-retry-00001" };
    const first = await record(body);
    const again = await record(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, revision: 1, to: b, replayed: true });
    expect(counts()).toEqual({ records: 1, events: 1 });
    expect({ ...again.body, replayed: false }).toEqual(first.body);
    const other = await record({ ...body, home: codexHome("c") });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ ok: false, code: "operation_conflict", applied: false });
    expect(effectiveRuntimeHome(db, s.node.id, "codex", undefined)).toBe(b);
    expect(counts()).toEqual({ records: 1, events: 1 });
  });

  it("keeps an account switch's home in its own slot, so launch still unsets provider credentials, and changes nothing else", async () => {
    const a = codexHome("account-a"), b = codexHome("account-b");
    const s = seat({ accountHome: a, env: { OPENAI_API_KEY: "sk-kept", CODEX_HOME: "/declared/but/shadowed" } });
    const node = nodeRow(s.node.id);
    const sessions = db.prepare("SELECT * FROM sessions WHERE node_id = ? ORDER BY id").all(s.node.id);
    const bindings = db.prepare("SELECT * FROM bindings WHERE node_id = ?").all(s.node.id);
    const tenures = db.prepare("SELECT * FROM occupant_tenures WHERE node_id = ?").all(s.node.id);
    const tmux = Object.values(setup.tmuxAdapter).filter((fn): fn is ReturnType<typeof vi.fn> => vi.isMockFunction(fn));
    for (const fn of tmux) fn.mockClear();

    const result = await record({ home: b, expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-account-0001" });

    expect(result.body).toMatchObject({ ok: true, slot: "account_home", from: { home: a, source: "account-switch" }, to: b });
    const after = nodeRow(s.node.id);
    expect(after.account_home).toBe(b);
    expect({ ...after, account_home: node.account_home }).toEqual(node);
    expect(db.prepare("SELECT * FROM sessions WHERE node_id = ? ORDER BY id").all(s.node.id)).toEqual(sessions);
    expect(db.prepare("SELECT * FROM bindings WHERE node_id = ?").all(s.node.id)).toEqual(bindings);
    expect(db.prepare("SELECT * FROM occupant_tenures WHERE node_id = ?").all(s.node.id)).toEqual(tenures);
    for (const fn of tmux) expect(fn).not.toHaveBeenCalled();
  });

  it("without an account switch, writes the member env, so no credential is unset at launch, and keeps every other env entry", async () => {
    const s = seat({ env: { OPENAI_API_KEY: "sk-kept", OTHER: "x" } });
    const node = nodeRow(s.node.id);
    await record({ home: codexHome("b"), expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-member-00001" });
    const after = nodeRow(s.node.id);
    expect(after.account_home).toBeNull();
    expect(JSON.parse(after.env_json as string)).toEqual({ OPENAI_API_KEY: "sk-kept", OTHER: "x", CODEX_HOME: codexHome("b") });
    expect({ ...after, env_json: node.env_json }).toEqual(node);
  });

  it("returns a recorded operation after the seat's runtime changed; a different request is still a conflict", async () => {
    const b = codexHome("b");
    const s = seat();
    const body = { home: b, expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-home-switch-01" };
    expect((await record(body)).body).toMatchObject({ ok: true, revision: 1, replayed: false });
    for (const runtime of ["claude-code", "pi"]) {
      db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, s.node.id);
      expect((await record(body)).body).toMatchObject({ ok: true, runtime: "codex", variable: "CODEX_HOME", to: b, revision: 1, replayed: true,
        observation: { home: "present", original: "found" } });
    }
    expect((await record({ ...body, home: codexHome("c") })).body).toMatchObject({ ok: false, code: "operation_conflict" });
    expect(counts()).toEqual({ records: 1, events: 1 });
  });

  it("reads the original from the seat's current session, not a newer row a failed launch left beside it", async () => {
    const s = seat();
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(s.session.id);
    const newer = (id: string, status: string, token: string) => db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, resume_type, resume_token) VALUES (?, ?, 'dev-impl@homes', ?, 'codex_id', ?)")
      .run(id, s.node.id, status, token);
    // A later launch's row, superseded when its launch failed and the earlier occupant was put back.
    newer("zz-failed-launch-row", "superseded", "newer-failed-token");
    expect((await read()).body).toMatchObject({ original: ORIGINAL });
    expect((await record({ home: codexHome("b"), expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0,
      operationId: "op-home-compensated" })).body).toMatchObject({ ok: true, original: ORIGINAL });
    // Two rows that could each be current, and neither running: no single original, and it says which.
    db.prepare("UPDATE sessions SET status = 'detached' WHERE id = ?").run(s.session.id);
    newer("zz-second-detached-row", "detached", "another-token");
    expect((await read()).body).toMatchObject({ original: null, originalCandidates: [s.session.id, "zz-second-detached-row"] });
  });

  it("reads an inner path it can't read as unknown, not absent, and still records", async () => {
    if (process.getuid?.() === 0) return; // permissions don't bind for root
    const b = codexHome("b");
    const s = seat();
    chmodSync(b, 0o600);
    try {
      const recorded = await record({ home: b, expectedOccupant: s.generation, expectedOriginal: ORIGINAL, expectedRevision: 0, operationId: "op-home-unreadable" });
      expect(recorded.body).toMatchObject({ ok: true, revision: 1, observation: { home: "present", original: "unknown" } });
    } finally { chmodSync(b, 0o700); }
  });

  it("follows a linked Claude project directory, and reads an ordinary file among the projects as holding nothing", () => {
    const target = path.join(root, "elsewhere", "project-x");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, `${ORIGINAL}.jsonl`), "{}\n");
    const home = path.join(root, "claude-home");
    mkdirSync(path.join(home, "projects"), { recursive: true });
    symlinkSync(target, path.join(home, "projects", "linked-project"));
    writeFileSync(path.join(home, "projects", "notes.txt"), "");
    expect(observeRuntimeHome(home, "claude-code", ORIGINAL)).toMatchObject({ home: "present", original: "found" });
    rmSync(path.join(home, "projects", "linked-project"));
    expect(observeRuntimeHome(home, "claude-code", ORIGINAL)).toMatchObject({ home: "present", original: "not_found" });
  });

  it("doesn't take the rig's declaration for an account-home record's home, even when it names the same path", () => {
    const a = codexHome("a"), b = codexHome("b");
    const s = seat();
    const insert = (revision: number, home: string, slot: string, original: string) => db.prepare(`INSERT INTO seat_runtime_home_records
      (operation_id, node_id, runtime, revision, home, slot, previous_home, previous_source, original, occupant_generation, request_hash,
      reason, operator, created_at) VALUES (?, ?, 'codex', ?, ?, ?, NULL, 'native_default', ?, NULL, 'fixture', 'fixture', NULL, ?)`)
      .run(`op-slot-${revision}`, s.node.id, revision, home, slot, original, new Date().toISOString());
    insert(1, b, "member_env", "selected-original");
    insert(2, a, "account_home", ORIGINAL);
    db.prepare("UPDATE rigs SET env_json = ? WHERE id = ?").run(JSON.stringify({ CODEX_HOME: a }), s.rig.id);
    // A switch cleared the account home that record wrote, so the rig's declaration of the same path decides now.
    expect(selectedHomePlan(db, s.node.id, "codex", "selected-original")).toEqual({ kind: "as_set", why: "home_changed_since_record" });
    // Still in the record's own slot, the same records apply the selected original's home.
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(a, s.node.id);
    expect(selectedHomePlan(db, s.node.id, "codex", "selected-original")).toMatchObject({ kind: "apply", record: { revision: 1, home: b } });
  });

  it("states what it's recorded against and refuses only a malformed request", async () => {
    seat();
    expect((await record({ home: "relative/home", expectedOccupant: null, expectedOriginal: null, expectedRevision: 0, operationId: "op-relative-01" })).body)
      .toMatchObject({ ok: false, code: "invalid_home" });
    expect((await record({ home: codexHome("b"), operationId: "op-no-expect-1" })).body).toMatchObject({ ok: false, code: "missing_expectation" });
    expect((await record({ home: codexHome("b"), expectedOccupant: null, expectedOriginal: null, expectedRevision: 0 })).body)
      .toMatchObject({ ok: false, code: "invalid_operation_id" });
    expect(counts()).toEqual({ records: 0, events: 0 });
  });
});
