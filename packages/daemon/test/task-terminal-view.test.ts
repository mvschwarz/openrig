import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { readTaskTerminalView, resolveLocalTaskSeat, type TaskSeat } from "../src/domain/terminal/task-terminal-view.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { terminalRoutes } from "../src/routes/terminal.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db);
  db.exec(`CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY,destination_session TEXT,state TEXT,handed_off_from TEXT,chain_of_record TEXT,summary TEXT);
    CREATE INDEX idx_queue_items_state ON queue_items(state);
    CREATE TABLE rigs(id TEXT PRIMARY KEY,name TEXT,archived_at TEXT);
    CREATE TABLE nodes(id TEXT PRIMARY KEY,rig_id TEXT,logical_id TEXT,runtime TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,node_id TEXT,session_name TEXT,status TEXT);
    CREATE TABLE bindings(node_id TEXT,tmux_session TEXT,attachment_type TEXT);`);
  const add = (id: string, owner = "a@team", state = "in-progress", parent: string | null = null, chain: string[] = []) =>
    db.prepare("INSERT INTO queue_items(qitem_id,destination_session,state,handed_off_from,chain_of_record) VALUES (?,?,?,?,?)").run(id, owner, state, parent, JSON.stringify(chain));
  const seat = (address: string): TaskSeat | null => address.includes("@remote") ? null
    : { hostId: "box", nodeId: address.split("@")[0]!, seat: address, runtime: "stub", stopped: false, attachmentType: "tmux", tmuxSession: address };
  const read = (root = "qitem-root") => readTaskTerminalView(db, root, seat);
  return { db, add, seat, read };
}

describe("task terminal membership", () => {
  it("tracks three to four to three current owners without historical senders", () => {
    const { db, add, read } = fixture();
    add("qitem-root"); add("qitem-b", "b@team", "pending", "qitem-root"); add("qitem-c", "c@team", "blocked", null, ["qitem-root"]);
    add("qitem-old", "old@team", "done", "qitem-root");
    expect(read()!.task.members.map(m => m.seat)).toEqual(["a@team", "b@team", "c@team"]);
    add("qitem-d", "d@team", "in-progress", "qitem-b");
    expect(read()!.task.members).toHaveLength(4);
    db.prepare("UPDATE queue_items SET state='handed-off' WHERE qitem_id='qitem-b'").run();
    expect(read()!.task.members.map(m => m.seat)).toEqual(["a@team", "c@team", "d@team"]);
    expect(read()!.task.members.find(m => m.seat === "c@team")!.obligations).toEqual([{ qitemId: "qitem-c", state: "blocked" }]);
  });
  it("does not widen a child episode into its parent, siblings or unrelated rows", () => {
    const { add, read } = fixture();
    add("qitem-parent", "parent@team"); add("qitem-root", "a@team", "in-progress", "qitem-parent", ["qitem-parent"]);
    add("qitem-sibling", "sibling@team", "pending", "qitem-parent"); add("qitem-unrelated", "other@team");
    expect(read()!.task.members.map(m => m.seat)).toEqual(["a@team"]);
  });
  it("keeps chain-only descendants of caller-supplied task ids", () => {
    const { add, read } = fixture();
    add("custom-task"); add("custom-child", "b@team", "pending", null, ["custom-task"]);
    add("qitem-root"); add("qitem-child", "c@team", "pending", null, ["qitem-root"]);
    expect(read("custom-task")!.task).toMatchObject({ complete: true, members: [{ seat: "a@team" }, { seat: "b@team" }] });
    expect(read()!.task).toMatchObject({ complete: true, members: [{ seat: "a@team" }, { seat: "c@team" }] });
  });
  it("retains earlier active children through closed intermediaries before a later root", () => {
    for (const root of ["qitem-root", "custom-task"]) {
      const { add, read } = fixture();
      add("earlier-child", "b@team", "pending", null, [root]);
      add("closed-bridge", "old@team", "done", null, [root]);
      add("earlier-via-bridge", "c@team", "blocked", null, ["closed-bridge"]);
      add(root);
      add("later-via-bridge", "d@team", "pending", null, ["closed-bridge"]);
      expect(read(root)!.task).toMatchObject({ complete: true,
        members: [{ seat: "a@team" }, { seat: "b@team" }, { seat: "c@team" }, { seat: "d@team" }] });
    }
  });
  it("shares the row budget with older active probes and closed ancestry", () => {
    for (const mode of ["older-active", "ancestors"]) {
      const { db, add, read } = fixture();
      db.transaction(() => {
        let parent = "qitem-root";
        for (let i = 0; i < 50002; i++) {
          const id = `qitem-earlier-${i}`;
          add(id, "other@team", mode === "ancestors" ? "done" : "pending", null,
            mode === "ancestors" ? [parent] : []);
          parent = id;
        }
        if (mode === "ancestors") add("qitem-earlier-active", "b@team", "pending", null, [parent]);
        add("qitem-root");
      })();
      let visits = 0, ancestorProbes = 0, olderProjection = "";
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        if (sql.includes("/* task-lineage")) {
          if (sql.includes("older-active")) olderProjection = sql;
          const iterate = statement.iterate.bind(statement);
          vi.spyOn(statement, "iterate").mockImplementation(function* (...params: unknown[]) {
            for (const row of iterate(...params)) { visits++; yield row; }
          });
        } else if (sql.includes("AS chain_bytes") && sql.includes("WHERE qitem_id=?")) {
          const get = statement.get.bind(statement);
          vi.spyOn(statement, "get").mockImplementation((...params: unknown[]) => {
            ancestorProbes++; return get(...params);
          });
        }
        return statement;
      });
      const result = read()!;
      expect(result.task.complete).toBe(false);
      expect(result.task.issues.join(" ")).toContain("50000-row work limit");
      expect(result.task.members.map(member => member.seat)).toEqual(["a@team"]);
      // Includes one overflow sentinel. The root's initial read precedes the scan.
      expect(visits + ancestorProbes - 1).toBe(50001);
      const plan = prepare(`EXPLAIN QUERY PLAN ${olderProjection}`).all("qitem-root", 50001) as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes("idx_queue_items_state"))).toBe(true);
      expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
      console.info("task shared work", JSON.stringify({ mode, visits, ancestorProbes, complete: result.task.complete }));
    }
  }, 20000);
  it("deduplicates actual host/node identities and explains each active obligation", () => {
    const { db, add, seat } = fixture(); add("qitem-root"); add("qitem-alias", "alias@team", "blocked", "qitem-root");
    const result = readTaskTerminalView(db, "qitem-root", address => address === "alias@team" ? seat("a@team") : seat(address))!;
    expect(result.task.members).toHaveLength(1); expect(result.members).toHaveLength(1);
    expect(result.task.members[0]!.obligations).toHaveLength(2);
  });
  it("retains same-named nodes on different hosts and distinct unresolved destinations", () => {
    const { db, add, seat } = fixture(); add("qitem-root"); add("qitem-foreign", "a@remote", "pending", "qitem-root");
    const result = readTaskTerminalView(db, "qitem-root", address => ({ ...seat("a@team")!, hostId: address === "a@remote" ? "other" : "box" }))!;
    expect(result.task.members).toHaveLength(2);
    add("qitem-unknown", "b@remote", "blocked", "qitem-root");
    expect(readTaskTerminalView(db, "qitem-root", seat)!.task.members.filter(m => m.availability === "unresolved")).toHaveLength(2);
  });
  it("does not hide stopped, unbound or external owners, and never provisions a viewer", () => {
    const { db, add, seat } = fixture(); add("qitem-root"); add("qitem-stopped", "stopped@team", "blocked", "qitem-root");
    add("qitem-hosted", "hosted@team", "pending", "qitem-root"); add("qitem-missing", "missing@team", "pending", "qitem-root");
    const result = readTaskTerminalView(db, "qitem-root", address => ({ ...seat(address)!, stopped: address.startsWith("stopped"),
      tmuxSession: address.startsWith("missing") ? null : address, attachmentType: address.startsWith("hosted") ? "external_cli" : "tmux" }))!;
    expect(result.task.members.map(m => m.availability).sort()).toEqual(["available", "hosted", "missing", "stopped"]);
    expect(result.members).toHaveLength(1);
    expect(result.task.members.every(m => m.viewerStatus === "not-provisioned")).toBe(true);
  });
  it("returns a truthful empty completed episode and distinguishes an unknown root", () => {
    const { add, read } = fixture(); add("qitem-root", "old@team", "done");
    expect(read()!.task).toMatchObject({ complete: true, members: [] });
    const { db } = fixture();
    db.prepare("INSERT INTO queue_items(qitem_id,summary,state,destination_session) VALUES (?,?,?,?)").run("qitem-named", "Prepare report", "pending", "a@team");
    expect(readTaskTerminalView(db, "qitem-named", () => null)!.task.name).toBe("Prepare report"); expect(read("qitem-absent")).toBeNull();
  });
  it("does not use a latest-100 window and discloses the explicit episode bound", () => {
    const { add, read } = fixture(); add("qitem-root");
    for (let i = 0; i < 260; i++) add(`qitem-child-${i}`, `member${i}@team`, "pending", "qitem-root");
    const result = read()!; expect(result.task.members).toHaveLength(256); expect(result.task.complete).toBe(false);
    expect(result.task.issues.join(" ")).toContain("incomplete");
  });
  it("discloses cycles and missing local lineage without walking foreign queues", () => {
    const { db, add, read } = fixture(); add("qitem-root", "a@team", "in-progress", "qitem-cycle");
    add("qitem-cycle", "b@team", "pending", "qitem-root", ["qitem-root", "qitem-unavailable"]);
    expect(read()!.task.complete).toBe(false); expect(read()!.task.issues.join(" ")).toContain("Cyclic");
    expect(read()!.task.issues.join(" ")).toContain("not available locally");
    db.prepare("UPDATE queue_items SET chain_of_record='broken' WHERE qitem_id='qitem-cycle'").run();
    expect(read()!.task.issues.join(" ")).toContain("Unreadable");
  });
  it("resolves stopped and never-launched nodes through local identity, without guessed sockets", () => {
    const { db } = fixture(); db.exec(`INSERT INTO rigs VALUES('rig','team',NULL);
      INSERT INTO nodes VALUES('stopped','rig','dev.stopped','stub'),('new','rig','dev.new','stub');
      INSERT INTO sessions VALUES('s','stopped','dev-stopped@team','exited');`);
    expect(resolveLocalTaskSeat(db, "dev-stopped@team", "box")).toMatchObject({ nodeId: "stopped", stopped: true, tmuxSession: null });
    expect(resolveLocalTaskSeat(db, "dev-new@team", "box")).toMatchObject({ nodeId: "new", tmuxSession: null });
    expect(resolveLocalTaskSeat(db, "dev-new@team@foreign", "box")).toBeNull();
    db.exec("INSERT INTO nodes VALUES('duplicate','rig','dev.new','stub')");
    expect(resolveLocalTaskSeat(db, "dev-new@team", "box")).toBeNull();
    db.exec(`DELETE FROM nodes WHERE id='duplicate';
      INSERT INTO rigs VALUES('archived','different-team','earlier');
      INSERT INTO nodes VALUES('old-owner','archived','someone.else','stub');
      INSERT INTO sessions VALUES('old','old-owner','dev-new@team','exited');`);
    // The stopped-seat fallback must not bypass the registry's reserved-name history.
    expect(resolveLocalTaskSeat(db, "dev-new@team", "box")).toBeNull();
  });
  it("composes the same truthful task in HTTP preview/open, preserves preconditions and scopes input read-only", async () => {
    const { add, read } = fixture(); add("qitem-root"); add("qitem-unresolved", "b@remote", "blocked", "qitem-root");
    const opened: string[][] = [];
    const svc = new TerminalService({ resolveTaskView: () => read(), viewsStore: { list: () => [], get: () => null },
      listRigSeats: () => null, listPodSeats: () => null, listRigNames: () => [], resolveHost: () => null,
      hasSession: () => true, resolveProvider: () => ({ name: "herdr", status: async () => ({ provider: "herdr", available: true, capabilities: {} }),
        liveness: async () => ({ alive: true }), openView: async view => {
          expect(view.opened.every(member => member.readOnly)).toBe(true); opened.push(view.opened.map(m => m.seat));
          return { provider: "herdr", ok: true, opened: view.opened.map(m => m.seat), absent: view.absent, degraded: [], pages: view.pages.length };
        } }) } satisfies TerminalServiceDeps);
    const app = new Hono(); app.use("*", async (c, next) => { c.set("terminalService" as never, svc as never); await next(); });
    app.route("/api/terminal", terminalRoutes());
    const response = await app.request("/api/terminal/preview?view=qitem:qitem-root&provider=herdr");
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.viewDescriptor).toEqual({ kind: "following", name: "qitem-root" });
    expect(preview.task.members).toHaveLength(2); expect(preview.composed.absent[0].seat).toBe("b@remote"); expect(opened).toHaveLength(0);
    const send = (expectedPlan: string) => app.request("/api/terminal/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: "qitem:qitem-root", provider: "herdr", expectedPlan }) });
    expect((await send("stale")).status).toBe(409); expect(opened).toHaveLength(0);
    const result = await (await send(preview.planId)).json(); expect(result.viewDescriptor).toEqual(preview.viewDescriptor); expect(result.task).toEqual(preview.task); expect(opened).toEqual([["a@team"]]);
    add("qitem-join", "c@team", "pending", "qitem-root");
    expect((await send(preview.planId)).status).toBe(409); expect(opened).toHaveLength(1);
  });
  it("never attaches a latest session through its predecessor's binding", () => {
    const { db, add } = fixture(); add("qitem-root", "dev-worker@team");
    db.exec(`INSERT INTO rigs VALUES('rig','team',NULL);
      INSERT INTO nodes VALUES('worker','rig','dev.worker','stub');
      INSERT INTO sessions VALUES('01','worker','old-worker@team','superseded'),('02','worker','new-worker@team','running');
      INSERT INTO bindings VALUES('worker','old-worker@team','tmux');`);
    const read = () => readTaskTerminalView(db, "qitem-root", address => resolveLocalTaskSeat(db, address, "box"))!;
    expect(read().task.members[0]).toMatchObject({ key: { nodeId: "worker" }, seat: "new-worker@team", availability: "missing" });
    expect(read().members).toEqual([]);
    // A fresh matching binding restores attachment; a currentNodeId cannot bypass the same join.
    expect(resolveLocalTaskSeat(db, "dev-worker@team", "box", "worker")!.tmuxSession).toBeNull();
    db.prepare("UPDATE bindings SET tmux_session='new-worker@team'").run();
    expect(read().members[0]!.tmuxSession).toBe("new-worker@team");
  });
  it("caps actual lineage rows even when unrelated history hides an episode beyond the scan", () => {
    const { db, add, read } = fixture(); add("qitem-root");
    db.transaction(() => {
      for (let i = 0; i < 50002; i++) add(`qitem-noise-${i}`, "unrelated@team", "done");
      add("qitem-z-descendant", "unseen@team", "pending", "qitem-root");
    })();
    let scanned = 0, projection = "", parameters: unknown[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes("/* task-lineage */")) {
        projection = sql;
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...params: unknown[]) {
          parameters = params;
          for (const row of iterate(...params)) { scanned++; yield row; }
        });
      }
      return statement;
    });
    const result = read()!;
    expect(result.task.complete).toBe(false);
    expect(result.task.issues.join(" ")).toContain("50000-row work limit");
    expect(scanned).toBe(50001); // Includes the one overflow sentinel, never the remaining history.
    expect(result.task.members.map(member => member.seat)).toEqual(["a@team"]);
    const plan = prepare(`EXPLAIN QUERY PLAN ${projection}`).all(...parameters) as Array<{ detail: string }>;
    expect(plan.some(row => /USING INDEX|INTEGER PRIMARY KEY/.test(row.detail))).toBe(true);
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    console.info("task lineage work", JSON.stringify({ storedRows: 50004, scannedRows: scanned, complete: result.task.complete, plan: plan.map(row => row.detail) }));
  }, 20000);
  it("starts the bounded scan at the root after unrelated history and resolves older ancestry", () => {
    const { db, add, read } = fixture();
    db.transaction(() => {
      add("qitem-older-parent", "older@team", "done");
      for (let i = 0; i < 50001; i++) add(`qitem-noise-${i}`, "unrelated@team", "done");
      add("qitem-root", "a@team", "in-progress", "qitem-older-parent", ["qitem-older-parent"]);
      add("qitem-z-descendant", "b@team", "pending", null, ["qitem-root", "qitem-older-parent"]);
    })();
    let scanned = 0, projection = "", parameters: unknown[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes("/* task-lineage */")) {
        projection = sql;
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...params: unknown[]) {
          parameters = params;
          for (const row of iterate(...params)) { scanned++; yield row; }
        });
      }
      return statement;
    });
    const result = read()!;
    expect(result.task.complete).toBe(true);
    expect(result.task.members.map(member => member.seat)).toEqual(["a@team", "b@team"]);
    expect(scanned).toBe(2);
    const plan = prepare(`EXPLAIN QUERY PLAN ${projection}`).all(...parameters) as Array<{ detail: string }>;
    expect(plan.some(row => /SEARCH queue_items USING INTEGER PRIMARY KEY/.test(row.detail))).toBe(true);
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    console.info("task root-forward work", JSON.stringify({ storedRows: 50004, scannedRows: scanned, complete: result.task.complete, plan: plan.map(row => row.detail) }));
  }, 20000);
  it("does not parse an oversized lineage record or report a complete team", () => {
    const { add, read } = fixture(); add("qitem-root");
    add("qitem-big", "b@team", "pending", null, ["qitem-root", "x".repeat(20000)]);
    const result = read()!;
    expect(result.task.complete).toBe(false);
    expect(result.task.issues.join(" ")).toContain("per-record work limit");
    expect(result.task.members.map(member => member.seat)).toEqual(["a@team"]);
  });
  it("caps total encoded lineage bytes and links independently of the episode size", () => {
    const bytes = fixture(); bytes.add("qitem-root");
    bytes.db.transaction(() => { for (let i = 0; i < 530; i++) bytes.add(`qitem-blob-${i}`, "other@team", "done", null, ["x".repeat(16000)]); })();
    expect(bytes.read()!.task.complete).toBe(false);
    expect(bytes.read()!.task.issues.join(" ")).toContain("encoded-byte work limit");
    const links = fixture(); links.add("qitem-root");
    const chain = Array.from({ length: 500 }, (_, i) => `qitem-other-${i}`);
    links.db.transaction(() => { for (let i = 0; i < 210; i++) links.add(`qitem-link-${i}`, "other@team", "done", null, chain); })();
    expect(links.read()!.task.complete).toBe(false);
    expect(links.read()!.task.issues.join(" ")).toContain("link work limit");
  });
});


it("identifies genuine qitem tasks without changing their legacy qitemId", () => {
  const { add, read } = fixture(); add("qitem-root");
  expect(read()?.task).toMatchObject({ kind: "qitem", id: "qitem-root", qitemId: "qitem-root" });
});
