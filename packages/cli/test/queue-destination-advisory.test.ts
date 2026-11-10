import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createDaemon } from "../../daemon/src/startup.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { getSelfHostId, setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { deriveCurrentWork, resolveWorkNodeDirs } from "../../daemon/src/domain/current-work.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { DaemonResponseError } from "../src/client.js";

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
  let responseHeaders: Headers[];
  let createResponses: Array<{ status: number; data: Record<string, unknown> }>;
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
    responseHeaders = [];
    createResponses = [];
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

  async function create(app: Hono, args: string[], json: boolean, id = "qitem-create-contract", clientFactory?: QueueDeps["clientFactory"], destination = "worker@scope", jsonOnlyResponse = false): Promise<void> {
    stdout.length = 0;
    stderr.length = 0;
    const deps: QueueDeps = {
      lifecycleDeps: { readFile: () => null, exists: () => false,
        fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
      clientFactory: clientFactory ?? (() => ({
        post: async (url: string, body: unknown) => {
          const response = await app.request(url, { method: "POST",
            headers: { "Content-Type": "application/json", "X-OpenRig-Session": "writer@scope" },
            body: JSON.stringify(body) });
          responseHeaders.push(response.headers);
          const data = await response.json() as Record<string, unknown>;
          createResponses.push({ status: response.status, data });
          return { status: response.status, data, ...(jsonOnlyResponse ? {} : { headers: response.headers }) };
        },
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>),
    };
    await queueCommand(deps).parseAsync(["create", "--destination", destination,
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
    // The independent read pins the unchanged primary row; advisories are the additive response field.
    const output = JSON.parse(stdout[0]!) as Record<string, unknown>;
    const { advisories, ...primary } = output;
    expect(primary).toEqual(JSON.parse(JSON.stringify(stored)));
    expect(advisories === undefined || Array.isArray(advisories)).toBe(true);
  }

  const scopeLines = () => stderr.join("\n").split("\n")
    .filter(line => /\bscope\b|mission:|slice:/i.test(line)).join("\n");

  function assertJsonCreate(f: Fixture, destination: string, tags: string[]): Record<string, unknown> {
    expect(createResponses).toHaveLength(1);
    expect(createResponses[0]!.status).toBe(201);
    const data = createResponses[0]!.data;
    const stored = f.daemon.deps.queueRepo.getById("qitem-create-contract");
    expect(stored).toMatchObject({ destinationSession: destination, body: "scope contract body", tags });
    expect(f.daemon.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = ?")
      .get("qitem-create-contract")).toEqual({ n: 1 });
    const { advisories: _advisories, ...primary } = data;
    expect(primary).toEqual(JSON.parse(JSON.stringify(stored)));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(data);
    expect(process.exitCode ?? 0).toBe(0);
    return data;
  }

  it.each([
    { mission: "MISSING.MISSION", code: "unresolved_scope", diagnostic: /unresolved|resolves to 0/i },
    { mission: "DUP.MISSION", code: "ambiguous_scope", diagnostic: /ambiguous|resolves to 2/i },
    { mission: "release", code: "scope_check_unavailable", diagnostic: /unavailable|could not.*check/i },
  ])("carries $code in the real create JSON and renders it once without response headers", async row => {
    if (row.code === "scope_check_unavailable") {
      fs.writeFileSync(path.join(source.root, "workspace.yaml"), "projects: invalid\n");
    }
    const unchanged = preserveAuthored(source);
    const tag = "mission:" + row.mission;
    await create(source.app, ["--mission", row.mission, "--tags", "project:alpha"], true,
      "qitem-create-contract", undefined, "worker@scope", true);
    const data = assertJsonCreate(source, "worker@scope", [tag, "project:alpha"]);
    unchanged();
    expect.soft(data.advisories).toEqual([expect.objectContaining({ code: row.code,
      message: expect.stringMatching(row.diagnostic) })]);
    const advice = Array.isArray(data.advisories) ? data.advisories : [];
    expect.soft(advice.map(item => item.message).join("\n")).toContain(tag);
    expect.soft(responseHeaders[0]!.has("X-OpenRig-Scope-Advisory")).toBe(false);
    const rendered = scopeLines().split("\n").filter(line => line.includes(tag) && row.diagnostic.test(line));
    expect.soft(rendered).toHaveLength(1);
  });

  it("keeps the destination advisory before scope advice in the real JSON response", async () => {
    const destination = "missing-worker@scope";
    await create(source.app, ["--mission", "MISSING.MISSION", "--tags", "project:alpha"], true,
      "qitem-create-contract", undefined, destination, true);
    const data = assertJsonCreate(source, destination, ["mission:MISSING.MISSION", "project:alpha"]);
    const advice = Array.isArray(data.advisories) ? data.advisories : [];
    expect.soft(advice.map(item => item.code)).toEqual(["unmatched_destination_seat", "unresolved_scope"]);
    expect.soft(advice[0]).toMatchObject({ destinationSession: destination,
      availableDestinations: expect.arrayContaining(["worker@scope", "writer@scope"]) });
    expect.soft(scopeLines().split("\n").filter(line => /mission:MISSING.MISSION.*unresolved|unresolved.*mission:MISSING.MISSION/i.test(line)))
      .toHaveLength(1);
  });

  it("keeps long Unicode scope messages in JSON and stderr without a header-sized limit", async () => {
    fs.writeFileSync(path.join(source.root, "workspace.yaml"), "projects: invalid\n");
    const tags = ["project:alpha", ...Array.from({ length: 9 }, (_, i) =>
      "mission:" + ("部署_" + i + "_").padEnd(150, "x") + "_末尾")];
    await create(source.app, ["--tags", tags.join(",")], true,
      "qitem-create-contract", undefined, "worker@scope", true);
    const data = assertJsonCreate(source, "worker@scope", tags);
    const advice = Array.isArray(data.advisories) ? data.advisories : [];
    const messages = advice.map(item => item.message).join("\n");
    expect.soft(advice).toEqual([expect.objectContaining({ code: "scope_check_unavailable", message: expect.any(String) })]);
    expect.soft(messages.length).toBeGreaterThan(1024);
    for (const tag of tags.slice(1)) {
      expect.soft(messages).toContain(tag);
      expect.soft(scopeLines()).toContain(tag);
    }
    expect.soft(scopeLines().split("\n").filter(line => /unavailable|could not.*check/i.test(line))).toHaveLength(1);
    expect.soft(responseHeaders[0]!.has("X-OpenRig-Scope-Advisory")).toBe(false);
  });

  it("returns skipped scope advice for a forwarded create without sender scope reads", async () => {
    const receiver = await fixture("json-receiver");
    const { app, observation } = forwardingApp(receiver);
    const senderReads = observeSenderScopeReads();
    setSelfHostId(source.hostId);
    await create(app, ["--host", "remote-fixture", "--mission", "MISSING.MISSION", "--tags", "project:alpha"], true,
      "qitem-create-contract", undefined, "worker@scope", true);
    const data = assertJsonCreate(receiver, "worker@scope", ["mission:MISSING.MISSION", "project:alpha", "cross-host", "from-host:" + os.hostname()]);
    expect(observation.forwards).toBe(1);
    expect(source.daemon.deps.queueRepo.getById("qitem-create-contract")).toBeNull();
    expect(senderReads).toEqual([]);
    const advice = Array.isArray(data.advisories) ? data.advisories : [];
    expect.soft(advice).toEqual([expect.objectContaining({ code: expect.any(String), message: expect.stringMatching(/skipped.*cross-host|cross-host.*skipped/i) })]);
    expect.soft(scopeLines()).toMatch(/skipped/i);
    expect.soft(scopeLines()).not.toMatch(/unresolved|unavailable|resolves to 0/i);
    expect.soft(responseHeaders[0]!.has("X-OpenRig-Scope-Advisory")).toBe(false);
  });

  it("keeps receiver destination advice before forwarded skipped scope advice", async () => {
    const receiver = await fixture("advisory-receiver");
    const { app, observation } = forwardingApp(receiver);
    const senderReads = observeSenderScopeReads();
    setSelfHostId(source.hostId);
    const destination = "missing-worker@scope";
    const tags = ["mission:release", "slice:SLICE.ONE", "project:alpha", "cross-host", "from-host:" + os.hostname()];

    await create(app, ["--host", "remote-fixture", "--mission", "release", "--slice", "SLICE.ONE",
      "--tags", "project:alpha"], true, "qitem-create-contract", undefined, destination);

    const data = assertJsonCreate(receiver, destination, tags);
    const advisories = Array.isArray(data.advisories)
      ? data.advisories as Array<{ code?: unknown; message?: unknown }>
      : [];
    expect(advisories.map(advisory => advisory.code)).toEqual(["unmatched_destination_seat", "scope_check_skipped"]);
    expect(advisories[0]).toMatchObject({ destinationSession: destination,
      availableDestinations: expect.arrayContaining(["worker@scope", "writer@scope"]) });
    expect(advisories[1]).toMatchObject({ message: expect.stringMatching(/skipped.*cross-host|cross-host.*skipped/i) });
    expect(observation.forwards).toBe(1);
    expect(observation.committedStatuses).toEqual([201]);
    expect(source.daemon.deps.queueRepo.getById("qitem-create-contract")).toBeNull();
    expect(receiver.daemon.deps.queueRepo.getById("qitem-create-contract")?.sourceSession)
      .toBe("writer@scope@" + source.hostId);
    expect(senderReads).toEqual([]);
  });

  it.each([
    { label: "JSON null", reply: () => Response.json(null, { status: 202 }), expectedBody: "null" },
    { label: "JSON array", reply: () => Response.json(["receiver-payload"], { status: 202 }), expectedBody: '["receiver-payload"]' },
    { label: "non-JSON body", reply: () => new Response("receiver-payload", {
      status: 202, headers: { "Content-Type": "text/plain" },
    }), expectedBody: "" },
  ])("passes through a forwarded $label response unchanged", async row => {
    const receiver = await fixture("malformed-response-receiver");
    const { app, observation } = forwardingApp(receiver, false, row.reply);
    const senderReads = observeSenderScopeReads();
    setSelfHostId(source.hostId);
    const id = "qitem-create-contract";
    const response = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "writer@scope" },
      body: JSON.stringify({ qitemId: id, destinationSession: "worker@scope", body: "scope contract body",
        summary: "scope contract", nudge: false, hostId: "remote-fixture",
        tags: ["mission:release", "slice:SLICE.ONE", "project:alpha"] }),
    });
    const responseBody = await response.text();

    expect(response.status).toBe(202);
    expect(responseBody).toBe(row.expectedBody);
    expect(observation.forwards).toBe(1);
    expect(observation.committedStatuses).toEqual([202]);
    expect(source.daemon.deps.queueRepo.getById(id)).toBeNull();
    expect(receiver.daemon.deps.queueRepo.getById(id)).toBeNull();
    expect(senderReads).toEqual([]);
  });

  function preserveAuthored(f: Fixture): () => void {
    const read = fs.readFileSync.bind(fs);
    const stat = fs.statSync.bind(fs);
    const list = fs.readdirSync.bind(fs);
    const snapshot = (): Record<string, string> => {
      const files: Record<string, string> = {};
      const visit = (file: string): void => {
        if (stat(file).isDirectory()) {
          for (const child of list(file).sort()) visit(path.join(file, child));
        } else files[path.relative(f.root, file)] = read(file, "utf8");
      };
      for (const file of ["workspace.yaml", "alpha/project.yaml", "alpha/missions"]) visit(path.join(f.root, file));
      return files;
    };
    const before = snapshot();
    return () => expect(snapshot()).toEqual(before);
  }

  function observeSenderScopeReads(): string[] {
    const reads: string[] = [];
    for (const method of ["readdirSync", "readFileSync", "statSync", "existsSync"] as const) {
      const original = fs[method].bind(fs) as (...args: unknown[]) => unknown;
      vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) === path.join(source.root, "workspace.yaml")
          || String(args[0]) === source.missions || String(args[0]).startsWith(source.missions + path.sep)) {
          reads.push(method + ":" + String(args[0]));
        }
        return original(...args);
      }) as never);
    }
    return reads;
  }

  function forwardingApp(receiver: Fixture, loseResponse = false, remoteResponse?: () => Response) {
    const observation = { forwards: 0, committedStatuses: [] as number[] };
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (key: string, value: unknown) => void;
      for (const key of ["eventBus", "queueRepo", "inboxHandler", "outboxHandler", "rigRepo"] as const) set(key, source.daemon.deps[key]);
      set("settingsStore", new SettingsStore(path.join(source.root, "settings.json")));
      set("hostRegistryLoader", () => ({ ok: true, registry: { hosts: [
        { id: "remote-fixture", transport: "http", url: "http://remote-fixture.invalid:39001" },
      ] } }));
      set("remoteFetchImpl", async (_url: unknown, init: RequestInit) => {
        observation.forwards++;
        const body = JSON.parse(String(init.body));
        const previous = getSelfHostId();
        setSelfHostId(receiver.hostId);
        try {
          const response = remoteResponse
            ? remoteResponse()
            : await receiver.app.request("/api/queue/create", { ...init,
              headers: { "Content-Type": "application/json", "X-OpenRig-Session": body.sourceSession } });
          observation.committedStatuses.push(response.status);
          if (loseResponse) {
            await response.text();
            return new Response(new ReadableStream({ start(controller) {
              controller.error(new Error("fixture lost receiver body after commit"));
            } }), { status: response.status, headers: response.headers });
          }
          return response;
        } finally { setSelfHostId(previous); }
      });
      await next();
    });
    app.route("/api/queue", queueRoutes());
    return { app, observation };
  }

  function recoveredClient(app: Hono, target: Fixture, typedLoss: boolean, readHealth?: (observation: number) => string | null) {
    const calls = { posts: [] as string[], readbacks: [] as Array<{ base: string; url: string }>, postStatuses: [] as number[],
      postBodies: [] as unknown[], committedBeforeLoss: [] as unknown[], healthReads: 0,
      healthResults: [] as Array<string | null> };
    const factory: QueueDeps["clientFactory"] = (base: string) => ({
      senderIdentity: async () => ({ session: "writer@scope", originUnknown: false }),
      post: async (url: string, body: unknown) => {
        calls.posts.push(url);
        calls.postBodies.push(body);
        const response = await app.request(url, { method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": "writer@scope" },
          body: JSON.stringify(body) });
        calls.postStatuses.push(response.status);
        if (typedLoss) {
          await response.text();
          calls.committedBeforeLoss.push(target.daemon.deps.queueRepo.getById((body as { qitemId: string }).qitemId));
          throw new DaemonResponseError(response.status, "fixture lost committed response body");
        }
        return { status: response.status, data: await response.json(), headers: response.headers };
      },
      get: async (url: string) => {
        if (url === "/healthz") {
          calls.healthReads++;
          try {
            const selfHostId = readHealth ? readHealth(calls.healthReads) : source.hostId;
            calls.healthResults.push(selfHostId);
            return { status: 200, data: { selfHostId } };
          } catch (error) {
            calls.healthResults.push("unreadable");
            throw error;
          }
        }
        calls.readbacks.push({ base, url });
        const row = target.daemon.deps.queueRepo.getById(decodeURIComponent(url.slice("/api/queue/".length)));
        return row ? { status: 200, data: row } : { status: 404, data: { error: "not_found" } };
      },
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>;
    return { factory, calls };
  }

  it.each(["SLICE.ONE", "MISSING.SLICE"])("reports slice-only %s as unavailable without mission context", async slice => {
    const unchanged = preserveAuthored(source);
    await create(source.app, ["--slice", slice, "--tags", "project:alpha"], true);
    committed(source, "qitem-create-contract", ["slice:" + slice, "project:alpha"]);
    unchanged();
    expect.soft(scopeLines()).toContain("slice:" + slice);
    expect.soft(scopeLines()).toMatch(/\bunavailable\b/i);
    expect.soft(scopeLines()).toMatch(/\bmission\b/i);
    expect.soft(scopeLines()).toMatch(/absent|missing|need|requir|without|not supplied/i);
    expect.soft(scopeLines()).not.toMatch(/resolves to 0|checked.*unresolved|not found/i);
  });

  it.each([
    { label: "mission alone", tags: ["mission:"], empty: "mission:", valid: null },
    { label: "slice alone", tags: ["slice:"], empty: "slice:", valid: null },
    { label: "mission beside valid slice", tags: ["mission:", "slice:SLICE.ONE"], empty: "mission:", valid: "slice:SLICE.ONE" },
    { label: "slice beside valid mission", tags: ["mission:release", "slice:"], empty: "slice:", valid: "mission:release" },
  ])("identifies the empty value for $label without blaming the other tag", async row => {
    const unchanged = preserveAuthored(source);
    const tags = [...row.tags, "project:alpha"];
    await create(source.app, ["--tags", tags.join(",")], true);
    committed(source, "qitem-create-contract", tags);
    unchanged();
    expect.soft(scopeLines()).toContain(row.empty);
    expect.soft(scopeLines()).toMatch(/\bempty\b/i);
    expect.soft(scopeLines()).not.toMatch(/resolves to 0|checked.*unresolved/i);
    if (row.valid) expect.soft(scopeLines()).not.toContain(row.valid + " is unresolved");
  });

  it.each(["mission:", "slice:"])("keeps remote empty-only %s SKIPPED without sender scope reads", async empty => {
    const receiver = await fixture("receiver");
    const sourceUnchanged = preserveAuthored(source);
    const receiverUnchanged = preserveAuthored(receiver);
    const { app, observation } = forwardingApp(receiver);
    const senderReads = observeSenderScopeReads();
    setSelfHostId(source.hostId);
    await create(app, ["--host", "remote-fixture", "--tags", empty + ",project:alpha"], true);
    const tags = [empty, "project:alpha", "cross-host", "from-host:" + os.hostname()];
    committed(receiver, "qitem-create-contract", tags);
    expect(source.daemon.deps.queueRepo.getById("qitem-create-contract")).toBeNull();
    expect(receiver.daemon.deps.queueRepo.getById("qitem-create-contract")?.sourceSession).toBe("writer@scope@" + source.hostId);
    expect(observation.forwards).toBe(1);
    expect(observation.committedStatuses).toEqual([201]);
    expect(senderReads).toEqual([]);
    sourceUnchanged();
    receiverUnchanged();
    expect.soft(scopeLines()).toMatch(/\bskipped\b/i);
    expect.soft(scopeLines()).toContain(empty);
    expect.soft(scopeLines()).not.toMatch(/unresolved|unavailable|resolves to 0/i);
  });

  it.each(["mission", "slice"] as const)("checks an exact-name regular file at %s level as unresolved", async level => {
    const parent = level === "mission" ? source.missions : path.join(source.missions, "release", "slices");
    const wanted = level === "mission" ? "release" : "build";
    const target = path.join(parent, wanted);
    fs.rmSync(target, { recursive: true });
    fs.writeFileSync(target, "a regular file is not a work directory");
    expect(fs.statSync(target).isFile()).toBe(true);
    // Historical current-work resolution stays permissive; this advisory has a stricter directory contract.
    expect(resolveWorkNodeDirs(parent, wanted)).toEqual([{ dir: wanted, form: "directory name" }]);
    const unchanged = preserveAuthored(source);
    const args = level === "mission" ? ["--mission", wanted] : ["--mission", "release", "--slice", wanted];
    const tags = level === "mission" ? ["mission:release", "project:alpha"] : ["mission:release", "slice:build", "project:alpha"];
    await create(source.app, [...args, "--tags", "project:alpha"], true);
    committed(source, "qitem-create-contract", tags);
    unchanged();
    expect.soft(scopeLines()).toContain(level + ":" + wanted);
    expect.soft(scopeLines()).toMatch(/\bunresolved\b/i);
    expect.soft(scopeLines()).not.toMatch(/unavailable|skipped/i);
  });

  it.each([true, false])("reconciles a real local commit once with scope-tagged=%s", async tagged => {
    const unchanged = preserveAuthored(source);
    const { factory, calls } = recoveredClient(source.app, source, true);
    const args = tagged ? ["--mission", "missing-mission", "--tags", "project:alpha"] : [];
    await create(source.app, args, true, "qitem-create-contract", factory);
    committed(source, "qitem-create-contract", tagged ? ["mission:missing-mission", "project:alpha"] : null);
    expect(calls.posts).toEqual(["/api/queue/create"]);
    expect(calls.postStatuses).toEqual([201]);
    expect(calls.readbacks.map(call => call.url)).toEqual(["/api/queue/qitem-create-contract"]);
    expect(stderr.join("\n")).toContain("committed after all: row qitem-create-contract");
    unchanged();
    if (tagged) {
      expect.soft(scopeLines()).toContain("mission:missing-mission");
      expect.soft(scopeLines()).toMatch(/\bunavailable\b/i);
      expect.soft(scopeLines()).toMatch(/\boutcome\b|\bresult\b/i);
      expect.soft(scopeLines()).not.toMatch(/resolves to 0|checked.*unresolved/i);
    } else expect(scopeLines()).toBe("");
  });

  async function recoverOwnHost(form: "--host" | "qualified destination", readHealth?: (observation: number) => string | null) {
    expect(source.hostId).toEqual(expect.any(String));
    expect(source.hostId).not.toBe("local");
    expect(getSelfHostId()).toBe(source.hostId);
    const health = await source.daemon.app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ selfHostId: source.hostId });
    const unchanged = preserveAuthored(source);
    const { factory, calls } = recoveredClient(source.app, source, true, readHealth);
    const args = ["--mission", "missing-mission", "--tags", "project:alpha"];
    if (form === "--host") args.push("--host", source.hostId!);
    const destination = form === "qualified destination" ? "worker@scope@" + source.hostId : "worker@scope";
    await create(source.app, args, true, "qitem-create-contract", factory, destination);
    const tags = ["mission:missing-mission", "project:alpha"];
    committed(source, "qitem-create-contract", tags);
    const stored = source.daemon.deps.queueRepo.getById("qitem-create-contract");
    expect(stored?.sourceSession).toBe("writer@scope");
    expect(stored?.destinationSession).toBe("worker@scope");
    expect(stored?.tags).toEqual(tags);
    expect(source.daemon.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE body = ?").get("scope contract body")).toEqual({ n: 1 });
    expect(calls.posts).toEqual(["/api/queue/create"]);
    expect(calls.postStatuses).toEqual([201]);
    expect(calls.postBodies).toEqual([expect.objectContaining({ hostId: source.hostId,
      destinationSession: "worker@scope", qitemId: "qitem-create-contract", tags })]);
    expect(calls.committedBeforeLoss).toEqual([stored]);
    expect(calls.healthReads).toBeGreaterThan(0);
    expect(calls.readbacks.map(call => call.url)).toEqual(["/api/queue/qitem-create-contract"]);
    expect(stderr.join("\n")).toContain("committed after all: row qitem-create-contract");
    unchanged();
    return calls;
  }

  it.each(["--host", "qualified destination"] as const)("keeps recovered own-host %s advice local after a committed response is lost", async form => {
    await recoverOwnHost(form);
    expect.soft(scopeLines()).toContain("mission:missing-mission");
    expect.soft(scopeLines()).toMatch(/\bunavailable\b/i);
    expect.soft(scopeLines()).toMatch(/\boutcome\b|\bresult\b/i);
    expect.soft(scopeLines()).toMatch(/response recovery/i);
    expect.soft(scopeLines()).not.toMatch(/\bskipped\b|cross-host|\bforwarded\b/i);
  });

  it.each(["--host", "qualified destination"] as const)(
    "keeps own-host %s recovery advice unknown when the first identity read fails but the later match succeeds",
    async form => {
      const registryUrl = "http://own-host-recovery.invalid:39001";
      const home = path.join(scratch, "cli-home-own-host-recovery");
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: ${source.hostId}\n    transport: http\n    url: ${registryUrl}\n`);
      vi.stubEnv("OPENRIG_HOME", home);

      const calls = await recoverOwnHost(form, observation => {
        if (observation === 1) throw new Error("fixture first identity read is unavailable");
        return source.hostId;
      });

      expect(calls.healthResults).toEqual(["unreadable", source.hostId]);
      expect(calls.healthReads).toBe(2);
      expect(calls.readbacks).toEqual([{
        base: registryUrl,
        url: "/api/queue/qitem-create-contract",
      }]);
      expect(scopeLines()).toContain("mission:missing-mission");
      expect(scopeLines()).toMatch(/scope check outcome unavailable after response recovery/i);
      expect(scopeLines()).not.toMatch(/\bskipped\b|cross-host|\bforwarded\b/i);
    },
  );

  function healthAfterMatchedRecovery(later: "different" | "null" | "unreadable") {
    return (observation: number): string | null => {
      // The target and source checks see the real host. Only the later advice read changes.
      if (observation <= 2) return source.hostId;
      if (later === "unreadable") throw new Error("fixture health became unreadable after matching recovery");
      return later === "null" ? null : "replacement-fixture";
    };
  }

  it.each((["--host", "qualified destination"] as const).flatMap(form =>
    (["different", "null", "unreadable"] as const).map(later => ({ form, later }))))(
    "keeps matched own-host $form recovery local when later health is $later", async ({ form, later }) => {
      const calls = await recoverOwnHost(form, healthAfterMatchedRecovery(later));
      const evidence = "observed health sequence: " + JSON.stringify(calls.healthResults);
      expect.soft(scopeLines(), evidence).toContain("mission:missing-mission");
      expect.soft(scopeLines(), evidence).toMatch(/\bunavailable\b/i);
      expect.soft(scopeLines(), evidence).toMatch(/\boutcome\b|\bresult\b/i);
      expect.soft(scopeLines(), evidence).toMatch(/response recovery/i);
      expect.soft(scopeLines(), evidence).not.toMatch(/\bskipped\b|cross-host|\bforwarded\b/i);
    },
  );

  it.each(["--host", "qualified destination"] as const)(
    "keeps own-host %s outcome unknown when health becomes unreadable before source matching", async form => {
      expect(source.hostId).toEqual(expect.any(String));
      expect(getSelfHostId()).toBe(source.hostId);
      const unchanged = preserveAuthored(source);
      const { factory, calls } = recoveredClient(source.app, source, true, observation => {
        if (observation === 1) return source.hostId;
        throw new Error("fixture health unreadable while matching the stored source");
      });
      const args = ["--mission", "missing-mission", "--tags", "project:alpha"];
      if (form === "--host") args.push("--host", source.hostId!);
      const destination = form === "qualified destination" ? "worker@scope@" + source.hostId : "worker@scope";
      await expect(create(source.app, args, true, "qitem-create-contract", factory, destination))
        .rejects.toMatchObject({ name: "DaemonResponseError", status: 201 });
      const stored = source.daemon.deps.queueRepo.getById("qitem-create-contract");
      expect(stored).toMatchObject({ qitemId: "qitem-create-contract", sourceSession: "writer@scope",
        destinationSession: "worker@scope", body: "scope contract body", summary: "scope contract", state: "pending",
        tags: ["mission:missing-mission", "project:alpha"] });
      expect(source.daemon.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE body = ?")
        .get("scope contract body")).toEqual({ n: 1 });
      expect(calls.committedBeforeLoss).toEqual([stored]);
      expect(calls.posts).toEqual(["/api/queue/create"]);
      expect(calls.postStatuses).toEqual([201]);
      expect(calls.readbacks.map(call => call.url)).toEqual(["/api/queue/qitem-create-contract"]);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("couldn't read this daemon's host id to tell whether its source is this create's");
      expect(stderr.join("\n")).toContain("outcome is still unknown");
      expect(stderr.join("\n")).not.toContain("committed after all");
      expect(scopeLines()).not.toMatch(/scope check|\bforwarded\b/i);
      unchanged();
    },
  );

  async function recoverForwardedCommit(readHealth?: (observation: number) => string | null) {
    const receiver = await fixture("receiver");
    const sourceUnchanged = preserveAuthored(source);
    const receiverUnchanged = preserveAuthored(receiver);
    const { app, observation } = forwardingApp(receiver, true);
    const { factory, calls } = recoveredClient(app, receiver, false, readHealth);
    const home = path.join(scratch, "cli-home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "hosts.yaml"), "hosts:\n  - id: remote-fixture\n    transport: http\n    url: http://remote-fixture.invalid:39001\n");
    vi.stubEnv("OPENRIG_HOME", home);
    const senderReads = observeSenderScopeReads();
    setSelfHostId(source.hostId);
    await create(app, ["--host", "remote-fixture", "--mission", "release", "--slice", "SLICE.ONE", "--tags", "project:alpha"], true,
      "qitem-create-contract", factory);
    committed(receiver, "qitem-create-contract", ["mission:release", "slice:SLICE.ONE", "project:alpha", "cross-host", "from-host:" + os.hostname()]);
    expect(source.daemon.deps.queueRepo.getById("qitem-create-contract")).toBeNull();
    expect(receiver.daemon.deps.queueRepo.getById("qitem-create-contract")?.sourceSession).toBe("writer@scope@" + source.hostId);
    expect(calls.posts).toEqual(["/api/queue/create"]);
    expect(calls.postStatuses).toEqual([502]);
    expect(observation.forwards).toBe(1);
    expect(observation.committedStatuses).toEqual([201]);
    expect(calls.readbacks).toEqual([{ base: "http://remote-fixture.invalid:39001", url: "/api/queue/qitem-create-contract" }]);
    expect(stderr.join("\n")).toContain("committed after all: row qitem-create-contract on host 'remote-fixture'");
    expect(senderReads).toEqual([]);
    sourceUnchanged();
    receiverUnchanged();
    expect.soft(scopeLines()).toMatch(/\bskipped\b/i);
    expect.soft(scopeLines()).toContain("mission:release");
    expect.soft(scopeLines()).toContain("slice:SLICE.ONE");
    expect.soft(scopeLines()).not.toMatch(/unavailable|unresolved|resolves to 0/i);
  }

  it("reconciles a forwarded indeterminate commit with SKIPPED and destination provenance", async () => {
    await recoverForwardedCommit();
  });

  it.each(["null", "unreadable"] as const)(
    "keeps confirmed remote recovery SKIPPED when later health is %s", async later => {
      await recoverForwardedCommit(healthAfterMatchedRecovery(later));
    },
  );

  it.each([
    { level: "mission", tags: ["mission:release", "mission:MISSION.ONE", "slice:SLICE.ONE", "project:alpha"] },
    { level: "slice", tags: ["mission:release", "slice:SLICE.ONE", "slice:build", "project:alpha"] },
  ])("reports distinct $level inputs as a conflict, not a directory count", async row => {
    const unchanged = preserveAuthored(source);
    const old = deriveCurrentWork([{ qitemId: "input-conflict", state: "in-progress", tags: row.tags }], source.missions);
    expect(old.currentWork).toBeNull();
    expect(old.currentWorkBasis).toContain("conflicting typed tags:");
    expect(old.currentWorkBasis).toContain("2 distinct " + row.level + " tags");
    await create(source.app, ["--tags", row.tags.join(",")], true);
    committed(source, "qitem-create-contract", row.tags);
    unchanged();
    expect.soft(scopeLines()).toMatch(/\bconflict(?:ing)?\b/i);
    expect.soft(scopeLines()).toContain(row.level + ":");
    expect.soft(scopeLines()).not.toMatch(/resolves to \d+ directories/i);
  });

  it.each(["mission", "slice"] as const)("retains a visible %s conflict when long values share a display prefix", async level => {
    const common = ("ordinary_" + level + "_").padEnd(220, "x");
    const first = level + ":" + common + "A";
    const second = level + ":" + common + "B";
    const tags = level === "mission"
      ? [first, second, "project:alpha"] : ["mission:release", first, second, "project:alpha"];
    const unchanged = preserveAuthored(source);
    await create(source.app, ["--tags", tags.join(",")], true);
    committed(source, "qitem-create-contract", tags);
    unchanged();
    const advisories = createResponses[0]?.data.advisories as Array<{ code?: unknown; message?: unknown }> | undefined;
    expect(advisories).toHaveLength(1);
    expect(advisories?.[0]).toMatchObject({ code: "conflicting_scope", message: expect.any(String) });
    const message = advisories?.[0]?.message as string;
    expect(message).toContain(first);
    expect(message).toContain(second);
    expect.soft(scopeLines()).toMatch(/\bconflict(?:ing)?\b/i);
    expect.soft(scopeLines()).toContain(level + ":");
    expect.soft(scopeLines()).toContain(first);
    expect.soft(scopeLines()).toContain(second);
    expect.soft(scopeLines()).not.toMatch(/resolves to \d+ directories/i);
  });

  it.each([
    { level: "mission", code: "EACCES", wanted: "DUP.MISSION" },
    { level: "slice", code: "EIO", wanted: "DUP.SLICE" },
  ])("reports unavailable for two $level matches plus unreadable extra SPEC ($code)", async row => {
    const lookup = row.level === "mission" ? source.missions : path.join(source.missions, "release", "slices");
    for (const child of ["duplicate-a", "duplicate-b"]) {
      expect(fs.statSync(path.join(lookup, child)).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(lookup, child, "SPEC.md"), "utf8")).toContain("id: " + row.wanted);
    }
    const extra = path.join(lookup, "unreadable-extra");
    spec(extra, "EXTRA");
    const file = path.join(extra, "SPEC.md");
    expect(fs.statSync(file).isFile()).toBe(true);
    const unchanged = preserveAuthored(source);
    const read = fs.readFileSync.bind(fs);
    let faults = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      if (String(args[0]) === file) {
        faults++;
        throw Object.assign(new Error("fixture extra SPEC read failed"), { code: row.code });
      }
      return (read as (...input: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync);
    const args = row.level === "mission" ? ["--mission", row.wanted] : ["--mission", "release", "--slice", row.wanted];
    const tags = row.level === "mission"
      ? ["mission:DUP.MISSION", "project:alpha"] : ["mission:release", "slice:DUP.SLICE", "project:alpha"];
    await create(source.app, [...args, "--tags", "project:alpha"], true);
    committed(source, "qitem-create-contract", tags);
    expect(faults).toBeGreaterThan(0);
    unchanged();
    expect.soft(scopeLines()).toContain(row.level + ":" + row.wanted);
    expect.soft(scopeLines()).toMatch(/\bunavailable\b/i);
    expect.soft(scopeLines()).not.toMatch(/resolves to \d+ directories/i);
  });

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

  const longScopeTags = () => [
    ...Array.from({ length: 7 }, (_, i) => "mission:" + ("ordinary_mission_" + i + "_").padEnd(150, "x")),
    ...Array.from({ length: 2 }, (_, i) => "slice:" + ("ordinary_slice_" + i + "_").padEnd(150, "x")),
  ];

  it.each([
    { level: "mission", code: "EACCES", mission: "MISSION.ONE", slice: "SLICE.ONE" },
    { level: "slice", code: "EIO", mission: "release", slice: "SLICE.ONE" },
  ])("reports unavailable when existing $level SPEC lookup fails with $code", async row => {
    const file = row.level === "mission"
      ? path.join(source.missions, "release", "SPEC.md")
      : path.join(source.missions, "release", "slices", "build", "SPEC.md");
    expect(fs.statSync(file).isFile()).toBe(true);
    const read = fs.readFileSync.bind(fs);
    let faults = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      if (String(args[0]) === file) {
        faults++;
        throw Object.assign(new Error("fixture SPEC read failed"), { code: row.code });
      }
      return (read as (...input: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync);
    await create(source.app, ["--mission", row.mission, "--slice", row.slice, "--tags", "project:alpha"], true);
    committed(source, "qitem-create-contract", [`mission:${row.mission}`, `slice:${row.slice}`, "project:alpha"]);
    expect(faults).toBeGreaterThan(0);
    expect(scopeLines()).toMatch(/unavailable|could not (?:run|check)|unable to (?:run|check)/i);
    expect(scopeLines()).not.toMatch(/resolves to 0|checked.*unresolved/i);
  });

  it("keeps absent unrelated metadata distinct from an unreadable existing SPEC", async () => {
    fs.unlinkSync(path.join(source.missions, "duplicate-a", "SPEC.md"));
    await create(source.app, ["--mission", "MISSION.ONE", "--slice", "SLICE.ONE", "--tags", "project:alpha"], true);
    committed(source, "qitem-create-contract", ["mission:MISSION.ONE", "slice:SLICE.ONE", "project:alpha"]);
    expect(scopeLines()).toBe("");
  });

  it("keeps the unavailable notice for ordinary long scope tags without changing the committed result", async () => {
    fs.writeFileSync(path.join(source.root, "workspace.yaml"), "projects: invalid\n");
    const tags = ["project:alpha", ...longScopeTags()];
    await create(source.app, ["--tags", tags.join(",")], true);
    committed(source, "qitem-create-contract", tags);
    expect(JSON.stringify(tags).length).toBeGreaterThan(1024);
    const advisories = createResponses[0]?.data.advisories as Array<{ code?: unknown; message?: unknown }> | undefined;
    expect(advisories).toEqual([expect.objectContaining({ code: "scope_check_unavailable", message: expect.any(String) })]);
    const message = advisories?.[0]?.message as string;
    for (const tag of tags.slice(1)) expect(message).toContain(tag);
    expect(scopeLines()).toMatch(/unavailable|could not (?:run|check)|unable to (?:run|check)/i);
    expect(scopeLines()).not.toMatch(/resolves to 0|checked.*unresolved/i);
  });

  it.each(["valid", "missing", "long tags"])("remote create is SKIPPED even when sender scope is %s", async senderState => {
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
    const extraTags = senderState === "long tags" ? longScopeTags() : [];
    await create(app, ["--host", "remote-fixture", "--mission", "release", "--slice", "SLICE.ONE", "--tags", ["project:alpha", ...extraTags].join(",")], true);
    expect(forwarded).toBe(1);
    expect(source.daemon.deps.queueRepo.getById("qitem-create-contract")).toBeNull();
    const stored = receiver.daemon.deps.queueRepo.getById("qitem-create-contract");
    expect(stored).toMatchObject({ destinationSession: "worker@scope", body: "scope contract body", state: "pending" });
    expect(stored?.sourceSession).toBe(`writer@scope@${source.hostId}`);
    expect(stored?.tags).toEqual(expect.arrayContaining(["mission:release", "slice:SLICE.ONE", "project:alpha"]));
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toHaveLength(1);
    const output = JSON.parse(stdout[0]!) as Record<string, unknown>;
    const { advisories: _advisories, ...primary } = output;
    expect(primary).toEqual(JSON.parse(JSON.stringify(stored)));
    expect(output).toEqual(createResponses[0]?.data);
    expect(senderReads).toEqual([]);
    if (senderState === "long tags") {
      expect(stored?.tags).toEqual(["mission:release", "slice:SLICE.ONE", "project:alpha", ...extraTags, "cross-host", `from-host:${os.hostname()}`]);
      expect(JSON.stringify(extraTags).length).toBeGreaterThan(1024);
    }
    const advisories = createResponses[0]?.data.advisories as Array<{ code?: unknown; message?: unknown }> | undefined;
    expect(advisories).toEqual([expect.objectContaining({ code: "scope_check_skipped", message: expect.any(String) })]);
    const message = advisories?.[0]?.message as string;
    expect(message).toContain("mission:release");
    expect(message).toContain("slice:SLICE.ONE");
    if (senderState === "long tags") for (const tag of extraTags) expect(message).toContain(tag);
    expect(scopeLines()).toMatch(/\bskipped\b/i);
    expect(scopeLines()).not.toMatch(/unresolved|ambiguous|unavailable/i);
  });
});
