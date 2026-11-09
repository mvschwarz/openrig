import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createDaemon } from "../../daemon/src/startup.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { getSelfHostId, setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";

describe("queue destination advisory through CLI and route", () => {
  it("prints the accepted typo unchanged for create and both handoffs", async () => {
    const saved = { noKernel: process.env.OPENRIG_NO_KERNEL, session: process.env.OPENRIG_SESSION_NAME };
    process.env.OPENRIG_NO_KERNEL = "1";
    process.env.OPENRIG_SESSION_NAME = "sender-ba@advisory-source";
    const daemon = await createDaemon({ cmuxFactory: async () => {
      throw Object.assign(new Error("no fixture socket"), { code: "ENOENT" });
    }, tmuxExec: async () => "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const source = daemon.deps.rigRepo.createRig("advisory-source");
      daemon.deps.rigRepo.addNode(source.id, "sender.ba", { runtime: null });
      const target = daemon.deps.rigRepo.createRig("advisory-target");
      daemon.deps.rigRepo.addNode(target.id, "product.ba", { runtime: null });
      const client = { post: async (url: string, body: unknown) => {
        const response = await daemon.app.request(url, { method: "POST", headers: {
          "Content-Type": "application/json", "X-OpenRig-Session": "sender-ba@advisory-source",
        }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
      } };
      const deps: QueueDeps = {
        lifecycleDeps: { readFile: () => null, exists: () => false,
          fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
        clientFactory: () => client as unknown as ReturnType<QueueDeps["clientFactory"]>,
      };
      for (const json of [false, true]) {
        for (const verb of ["create", "handoff", "handoff-and-complete"]) {
          const original = await daemon.deps.queueRepo.create({ sourceSession: "sender-ba@advisory-source",
            destinationSession: "sender-ba@advisory-source", body: "fixture source", nudge: false });
          const args = verb === "create"
            ? [verb, "--destination", "prodcut-ba@advisory-target", "--body", "fixture", "--summary", "fixture"]
            : [verb, original.qitemId, "--to", "prodcut-ba@advisory-target"];
          log.mockClear();
          await queueCommand(deps).parseAsync([...args, "--no-nudge", ...(json ? ["--json"] : [])], { from: "user" });
          const result = JSON.parse(log.mock.calls.map(call => call.join(" ")).join("\n"));
          expect(result.advisories[0].code).toBe("unmatched_destination_seat");
          expect(result.advisories[0].availableDestinations).toEqual(["product-ba@advisory-target"]);
          expect(result.advisories[0].message).toContain("does not guarantee pickup or delivery");
          const row = result.created ?? result;
          expect(row.destinationSession).toBe("prodcut-ba@advisory-target");
          expect(daemon.deps.queueRepo.getById(row.qitemId)?.destinationSession).toBe(row.destinationSession);
        }
      }
    } finally {
      log.mockRestore();
      daemon.eventLoopMonitor.stop(); daemon.contextMonitor.stop(); daemon.deps.seatActivityService?.stop();
      daemon.db.close();
      if (saved.noKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = saved.noKernel;
      if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved.session;
    }
  }, 30_000);
});

describe("queue create scope advisories preserve admission and output", () => {
  type Daemon = Awaited<ReturnType<typeof createDaemon>>;
  type Fixture = { daemon: Daemon; app: Hono; root: string; missions: string; hostId: string | null };
  let scratch: string;
  let daemons: Daemon[];
  let source: Fixture;
  let stdout: string[];
  let stderr: string[];
  let savedHost: string | null;
  let savedExit: typeof process.exitCode;

  function spec(directory: string, id: string): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SPEC.md"), `---\nid: ${id}\n---\n# Fixture\n`);
  }

  async function fixture(name: string): Promise<Fixture> {
    const root = path.join(scratch, name);
    const missions = path.join(root, "alpha", "missions");
    spec(path.join(root, "alpha"), "alpha");
    fs.writeFileSync(path.join(root, "workspace.yaml"), "projects:\n  - id: alpha\n    root: alpha\n");
    fs.writeFileSync(path.join(root, "alpha", "project.yaml"), "id: alpha\nmissions:\n  root: missions\n");
    spec(path.join(missions, "release"), "MISSION.ONE");
    spec(path.join(missions, "release", "slices", "build"), "SLICE.ONE");
    for (const dir of ["duplicate-a", "duplicate-b"]) {
      spec(path.join(missions, dir), "DUP.MISSION");
      spec(path.join(missions, "release", "slices", dir), "DUP.SLICE");
    }
    const fallback = path.join(root, "fallback");
    spec(path.join(fallback, "release"), "FALLBACK.MISSION");
    spec(path.join(fallback, "release", "slices", "build"), "FALLBACK.SLICE");
    const config = path.join(root, "settings.json");
    fs.writeFileSync(config, JSON.stringify({ workspace: {
      root, slicesRoot: fallback, catalogPath: path.join(root, "workspace.yaml"),
    } }));
    const daemon = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "",
      cmuxFactory: async () => { throw Object.assign(new Error("no fixture socket"), { code: "ENOENT" }); } });
    daemons.push(daemon);
    const rig = daemon.deps.rigRepo.createRig("scope");
    for (const member of ["writer", "worker"]) daemon.deps.rigRepo.addNode(rig.id, member, { runtime: null });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (key: string, value: unknown) => void;
      for (const key of ["eventBus", "queueRepo", "inboxHandler", "outboxHandler", "rigRepo"] as const) {
        set(key, daemon.deps[key]);
      }
      set("settingsStore", new SettingsStore(config));
      await next();
    });
    app.route("/api/queue", queueRoutes());
    return { daemon, app, root, missions, hostId: getSelfHostId() };
  }

  beforeEach(async () => {
    savedExit = process.exitCode;
    savedHost = getSelfHostId();
    process.exitCode = undefined;
    daemons = [];
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "queue-scope-"));
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    vi.stubEnv("OPENRIG_SESSION_NAME", "writer@scope");
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "0");
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { stdout.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(args.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
    source = await fixture("sender");
  });

  afterEach(() => {
    for (const daemon of daemons) {
      daemon.eventLoopMonitor.stop();
      daemon.contextMonitor.stop();
      daemon.deps.seatActivityService?.stop();
      daemon.db.close();
    }
    setSelfHostId(savedHost);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = savedExit;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function create(app: Hono, args: string[], json: boolean, id = "qitem-create-contract"): Promise<void> {
    stdout.length = 0;
    stderr.length = 0;
    const deps: QueueDeps = {
      lifecycleDeps: { readFile: () => null, exists: () => false,
        fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        post: async (url: string, body: unknown) => {
          const response = await app.request(url, { method: "POST",
            headers: { "Content-Type": "application/json", "X-OpenRig-Session": "writer@scope" },
            body: JSON.stringify(body) });
          return { status: response.status, data: await response.json() };
        },
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    await queueCommand(deps).parseAsync(["create", "--destination", "worker@scope",
      "--body", "scope contract body", "--summary", "scope contract", "--id", id,
      "--no-nudge", "--full", ...args, ...(json ? ["--json"] : [])], { from: "user" });
  }

  function committed(f: Fixture, id: string, tags: string[] | null): void {
    const stored = f.daemon.deps.queueRepo.getById(id);
    expect(stored).toMatchObject({ qitemId: id, destinationSession: "worker@scope",
      body: "scope contract body", summary: "scope contract", state: "pending", priority: "routine", tags });
    expect(f.daemon.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = ?").get(id)).toEqual({ n: 1 });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toHaveLength(1);
    // The independent read of the committed row pins the complete existing JSON contract.
    expect(JSON.parse(stdout[0]!)).toEqual(JSON.parse(JSON.stringify(stored)));
  }

  const scopeLines = () => stderr.join("\n").split("\n")
    .filter(line => /\bscope\b|mission:|slice:/i.test(line)).join("\n");

  it.each([false, true])("keeps valid project scope successful with unchanged JSON (json=%s)", async json => {
    await create(source.app, ["--mission", "release", "--slice", "SLICE.ONE", "--tags", "project:alpha"], json);
    committed(source, "qitem-create-contract", ["mission:release", "slice:SLICE.ONE", "project:alpha"]);
    expect(scopeLines()).not.toMatch(/unresolved|ambiguous|unavailable|could not|skipped/i);
  });

  it.each([false, true])("keeps untagged create unchanged (json=%s)", async json => {
    await create(source.app, [], json);
    committed(source, "qitem-create-contract", null);
    expect(scopeLines()).toBe("");
  });

  it.each([
    { label: "missing mission", mission: "missing-mission", slice: "SLICE.ONE", tag: "mission:missing-mission", kind: /unresolved|not found|does not (?:exist|resolve)|resolves to 0|cannot.*uniquely/i },
    { label: "ambiguous mission", mission: "DUP.MISSION", slice: "SLICE.ONE", tag: "mission:DUP.MISSION", kind: /ambiguous|more than one|resolves to 2|not.*uniquely|cannot.*uniquely/i },
    { label: "missing slice", mission: "release", slice: "MISSING.SLICE", tag: "slice:MISSING.SLICE", kind: /unresolved|not found|does not (?:exist|resolve)|resolves to 0|cannot.*uniquely/i },
    { label: "ambiguous slice", mission: "release", slice: "DUP.SLICE", tag: "slice:DUP.SLICE", kind: /ambiguous|more than one|resolves to 2|not.*uniquely|cannot.*uniquely/i },
    { label: "completed empty-directory check", mission: "missing-mission", slice: "SLICE.ONE", tag: "mission:missing-mission", kind: /unresolved|not found|does not (?:exist|resolve)|resolves to 0|cannot.*uniquely/i },
  ])("commits $label and reports checked nonunique scope only on stderr", async row => {
    if (row.label === "completed empty-directory check") {
      fs.rmSync(source.missions, { recursive: true });
      fs.mkdirSync(source.missions);
    }
    await create(source.app, ["--mission", row.mission, "--slice", row.slice, "--tags", "project:alpha"], true);
    committed(source, "qitem-create-contract", [`mission:${row.mission}`, `slice:${row.slice}`, "project:alpha"]);
    expect(scopeLines()).toContain(row.tag);
    expect(scopeLines()).toMatch(row.kind);
    expect(scopeLines()).not.toMatch(/unavailable|could not (?:run|check)|skipped/i);
  });

  it.each(["non-directory missions root", "invalid catalogue"])(
    "commits when the check cannot run: %s, without calling it checked unresolved", async cause => {
      if (cause === "non-directory missions root") {
        fs.rmSync(source.missions, { recursive: true });
        fs.writeFileSync(source.missions, "not a directory");
      } else {
        fs.writeFileSync(path.join(source.root, "workspace.yaml"), "projects: invalid\n");
      }
      await create(source.app, ["--mission", "release", "--slice", "SLICE.ONE", "--tags", "project:alpha"], true);
      committed(source, "qitem-create-contract", ["mission:release", "slice:SLICE.ONE", "project:alpha"]);
      expect(scopeLines()).toMatch(/unavailable|could not (?:run|check)|unable to (?:run|check)/i);
      expect(scopeLines()).not.toMatch(/resolves to 0|not found|checked.*unresolved/i);
    },
  );

  it.each(["valid", "missing"])("remote create is SKIPPED even when sender scope is %s", async senderState => {
    const receiver = await fixture("receiver");
    fs.rmSync(receiver.missions, { recursive: true });
    fs.mkdirSync(receiver.missions);
    if (senderState === "missing") {
      fs.rmSync(source.missions, { recursive: true });
      fs.mkdirSync(source.missions);
      spec(path.join(receiver.missions, "release"), "MISSION.ONE");
      spec(path.join(receiver.missions, "release", "slices", "build"), "SLICE.ONE");
    }
    const senderReads: string[] = [];
    for (const method of ["readdirSync", "readFileSync", "statSync", "existsSync"] as const) {
      const original = fs[method].bind(fs) as (...args: unknown[]) => unknown;
      vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) === path.join(source.root, "workspace.yaml")
          || String(args[0]) === source.missions || String(args[0]).startsWith(source.missions + path.sep)) {
          senderReads.push(method + ":" + String(args[0]));
        }
        return original(...args);
      }) as never);
    }
    let forwarded = 0;
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (key: string, value: unknown) => void;
      for (const key of ["eventBus", "queueRepo", "inboxHandler", "outboxHandler", "rigRepo"] as const) set(key, source.daemon.deps[key]);
      set("settingsStore", new SettingsStore(path.join(source.root, "settings.json")));
      set("hostRegistryLoader", () => ({ ok: true, registry: { hosts: [
        { id: "remote-fixture", transport: "http", url: "http://remote-fixture.invalid:39001" },
      ] } }));
      set("remoteFetchImpl", async (_url: unknown, init: RequestInit) => {
        forwarded++;
        const body = JSON.parse(String(init.body));
        const previous = getSelfHostId();
        setSelfHostId(receiver.hostId);
        try {
          return await receiver.app.request("/api/queue/create", { ...init,
            headers: { "Content-Type": "application/json", "X-OpenRig-Session": body.sourceSession } });
        } finally { setSelfHostId(previous); }
      });
      await next();
    });
    app.route("/api/queue", queueRoutes());
    setSelfHostId(source.hostId);
    await create(app, ["--host", "remote-fixture", "--mission", "release", "--slice", "SLICE.ONE", "--tags", "project:alpha"], true);
    expect(forwarded).toBe(1);
    expect(source.daemon.deps.queueRepo.getById("qitem-create-contract")).toBeNull();
    const stored = receiver.daemon.deps.queueRepo.getById("qitem-create-contract");
    expect(stored).toMatchObject({ destinationSession: "worker@scope", body: "scope contract body", state: "pending" });
    expect(stored?.sourceSession).toBe(`writer@scope@${source.hostId}`);
    expect(stored?.tags).toEqual(expect.arrayContaining(["mission:release", "slice:SLICE.ONE", "project:alpha"]));
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(JSON.parse(JSON.stringify(stored)));
    expect(senderReads).toEqual([]);
    expect(scopeLines()).toMatch(/\bskipped\b/i);
    expect(scopeLines()).not.toMatch(/unresolved|ambiguous|unavailable/i);
  });
});
