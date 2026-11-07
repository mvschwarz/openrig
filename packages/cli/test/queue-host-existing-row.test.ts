// #2637 — `--host <id>` on the queue verbs that name an existing row: show, transitions, list, claim, update, block.
// The CLI calls the remote host's daemon directly, with that host's bearer, as `send --host` does; the selected
// daemon is asked only for its own host id. Real DaemonClients against two local HTTP servers (the selected
// daemon and the remote one), so the paths, the bearer and the sender header are the ones on the wire.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../src/client.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";

let localPort = 0;

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: localPort })),
    getDaemonUrl: vi.fn(() => `http://127.0.0.1:${localPort}`),
    // This instance's own host id, as the durable store would give it.
    resolveOriginSelfHostId: vi.fn(async () => "vm-a"),
  };
});

interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: unknown }
type Answer = (req: Seen) => { status: number; data: unknown };

async function serve(answer: Answer): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      seen.push(entry);
      const { status, data } = answer(entry);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const ROW = { qitemId: "qitem-remote-1", state: "pending", body: "the remote row", sourceSession: "dev@fabrica@vm-a", destinationSession: "ops@devbox" };

describe("queue verbs on an existing row with --host (#2637)", () => {
  let local: Awaited<ReturnType<typeof serve>>;
  let remote: Awaited<ReturnType<typeof serve>>;
  let remoteAnswer: Answer;
  let home: string;
  let out: string[];
  let err: string[];
  let hosts: Array<Record<string, unknown>>;

  const deps = (): QueueDeps => ({
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: (url: string) => new DaemonClient(url),
    hostRegistryLoader: () => ({ ok: true, registry: { hosts } }) as ReturnType<NonNullable<QueueDeps["hostRegistryLoader"]>>,
  });
  const run = async (...args: string[]) => {
    process.exitCode = undefined;
    await queueCommand(deps()).parseAsync(["node", "queue", ...args]);
  };
  const remoteQueueCalls = () => remote.seen.filter((s) => s.path.startsWith("/api/queue"));
  const localQueueCalls = () => local.seen.filter((s) => s.path.startsWith("/api/queue"));

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "openrig-queue-host-"));
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_URL", "");
    vi.stubEnv("OPENRIG_SESSION_NAME", "dev@fabrica");
    vi.stubEnv("DEVBOX_BEARER", "s3cret");
    local = await serve((req) => req.path === "/healthz"
      ? { status: 200, data: { healthy: true, selfHostId: "vm-a" } }
      : { status: 500, data: { error: "the selected daemon must not be asked for the row" } });
    localPort = Number(new URL(local.url).port);
    remoteAnswer = (req) => {
      if (req.path === "/healthz") return { status: 200, data: { healthy: true, selfHostId: "devbox-id" } };
      if (req.path.endsWith("/transitions")) return { status: 200, data: [{ transitionId: 1, state: "pending" }] };
      if (req.path.startsWith("/api/queue/list")) return { status: 200, data: [ROW] };
      return { status: 200, data: ROW };
    };
    remote = await serve((req) => remoteAnswer(req));
    hosts = [
      { id: "devbox", transport: "http", url: remote.url, bearer_env: "DEVBOX_BEARER" },
      { id: "mac", transport: "ssh", target: "bruno@mac" },
      { id: "nobearer", transport: "http", url: remote.url, bearer_env: "UNSET_BEARER_VAR" },
    ];
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    await local.close();
    await remote.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("show --host reads the row from the remote daemon with its bearer, and its full command keeps --host", async () => {
    await run("show", "qitem-remote-1", "--host", "devbox", "--json");
    const [call] = remoteQueueCalls();
    expect(call).toMatchObject({ method: "GET", path: "/api/queue/qitem-remote-1" });
    expect(call!.headers.authorization).toBe("Bearer s3cret");
    expect(localQueueCalls()).toEqual([]);
    const shown = JSON.parse(out.join("\n"));
    expect(shown.qitemId).toBe("qitem-remote-1");
    expect(shown.readView.fullCommand).toBe("rig queue show 'qitem-remote-1' --host 'devbox' --full --json");
    expect(process.exitCode).toBeUndefined();
  });

  it("transitions --host reads the remote log", async () => {
    await run("transitions", "qitem-remote-1", "--host", "devbox", "--json", "--full");
    expect(remoteQueueCalls().map((c) => c.path)).toEqual(["/api/queue/qitem-remote-1/transitions"]);
    expect(JSON.parse(out.join("\n"))).toEqual([{ transitionId: 1, state: "pending" }]);
  });

  it("list --host lists the remote rows, its filters kept and no rig derived from this host's seat", async () => {
    await run("list", "--host", "devbox", "--state", "pending", "--json");
    const [call] = remoteQueueCalls();
    const query = new URL(call!.path, "http://x").searchParams;
    expect(query.get("state")).toBe("pending");
    expect(query.has("rig")).toBe(false);
    expect(query.has("as")).toBe(false);
    expect(JSON.parse(out.join("\n"))).toEqual([ROW]);
  });

  it.each(["--mine", "--owned"])("list --host %s is refused before any request: it names this host's seat", async (scope) => {
    await run("list", "--host", "devbox", scope, "--json");
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join("\n")).error).toBe("host_scope_unsupported");
    expect(remote.seen).toEqual([]);
  });

  it("update --host writes on the remote daemon, the actor stamped with this host's id", async () => {
    await run("update", "qitem-remote-1", "--host", "devbox", "--state", "done", "--closure-reason", "no-follow-on", "--note", "settled from vm-a", "--json");
    const [call] = remoteQueueCalls();
    expect(call).toMatchObject({ method: "POST", path: "/api/queue/qitem-remote-1/update" });
    expect(call!.headers["x-openrig-session"]).toBe("dev@fabrica@vm-a");
    expect(call!.headers.authorization).toBe("Bearer s3cret");
    expect(call!.body).toMatchObject({ state: "done", closureReason: "no-follow-on", transitionNote: "settled from vm-a" });
    expect(localQueueCalls()).toEqual([]);
  });

  it("block --host parks the remote row through the remote update route", async () => {
    await run("block", "qitem-remote-1", "--host", "devbox", "--on", "external:ci", "--wake-after", "30m", "--json");
    const [call] = remoteQueueCalls();
    expect(call).toMatchObject({ method: "POST", path: "/api/queue/qitem-remote-1/update" });
    expect(call!.body).toMatchObject({ state: "blocked", blockedOn: "external:ci", wakeAfterSeconds: 1800 });
    expect(call!.headers["x-openrig-session"]).toBe("dev@fabrica@vm-a");
  });

  it("claim takes no --host: a row is claimed by its destination seat, on the host that holds it", async () => {
    await run("claim", "qitem-remote-1", "--host", "devbox", "--json").catch(() => undefined);
    expect(remote.seen).toEqual([]);
    expect(localQueueCalls()).toEqual([]);
  });

  it("a --host naming the selected daemon's own host id stays local", async () => {
    local.close();
    local = await serve((req) => req.path === "/healthz"
      ? { status: 200, data: { selfHostId: "vm-a" } }
      : { status: 200, data: { ...ROW, qitemId: "qitem-local-1" } });
    localPort = Number(new URL(local.url).port);
    await run("show", "qitem-local-1", "--host", "vm-a", "--json");
    expect(localQueueCalls().map((c) => c.path)).toEqual(["/api/queue/qitem-local-1"]);
    expect(remote.seen).toEqual([]);
    expect(JSON.parse(out.join("\n")).readView.fullCommand).toBe("rig queue show 'qitem-local-1' --full --json");
  });

  it("list --host naming the selected daemon's own id is a local list: the seat's rig and --mine apply", async () => {
    local.close();
    local = await serve((req) => req.path === "/healthz" ? { status: 200, data: { selfHostId: "vm-a" } } : { status: 200, data: [] });
    localPort = Number(new URL(local.url).port);
    await run("list", "--host", "vm-a", "--json");
    await run("list", "--host", "vm-a", "--mine", "--json");
    expect(process.exitCode).toBeUndefined();
    const [plain, mine] = localQueueCalls().map((c) => new URL(c.path, "http://x").searchParams);
    expect(plain!.get("rig")).toBe("fabrica");
    expect(mine!.get("as")).toBe("dev@fabrica");
    expect(remote.seen).toEqual([]);
  });

  it.each([
    ["mac", "host_not_http"],
    ["nobearer", "host_bearer_unavailable"],
  ])("--host %s fails with %s and sends no queue request; only this daemon's own id is asked first", async (host, code) => {
    await run("update", "qitem-remote-1", "--host", host, "--state", "done", "--json");
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join("\n")).error).toBe(code);
    expect(remote.seen).toEqual([]);
    expect(local.seen.map((s) => s.path)).toEqual(["/healthz"]);
  });

  // The learned bindings: a self-id names a registry entry only through a binding the queue forwarder would use.
  const bind = (binding: Record<string, unknown>) => writeFileSync(join(home, "host-bindings.json"),
    JSON.stringify({ version: 1, bindings: { devbox: { hostId: "devbox-self-id", firstObservedAt: "2026-11-01T00:00:00Z", lastObservedAt: "2026-11-07T00:00:00Z", ...binding } } }));

  it("a self-id learned at the entry's current URL routes to that entry", async () => {
    bind({ observedUrl: remote.url });
    await run("update", "qitem-remote-1", "--host", "devbox-self-id", "--state", "done", "--json");
    expect(remoteQueueCalls().map((c) => c.path)).toEqual(["/api/queue/qitem-remote-1/update"]);
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["the entry's URL changed since it was learned", { observedUrl: "http://127.0.0.1:1" }, "but the entry now points at"],
    ["it has no observed URL", {}, "learned before its URL was recorded"],
    ["it records a conflict", { observedUrl: "PLACEHOLDER", conflict: { hostId: "other-id", observedAt: "2026-11-07T01:00:00Z" } }, "recorded conflict"],
  ])("a self-id whose binding isn't eligible (%s) is not routed, and says why", async (_why, binding, reason) => {
    bind(binding.observedUrl === "PLACEHOLDER" ? { ...binding, observedUrl: remote.url } : binding);
    await run("update", "qitem-remote-1", "--host", "devbox-self-id", "--state", "done", "--json");
    expect(process.exitCode).toBe(1);
    const body = JSON.parse(out.join("\n"));
    expect(body.error).toBe("unknown_host");
    expect(body.message).toContain(reason);
    expect(body.message).toContain("--host devbox");
    expect(remoteQueueCalls()).toEqual([]);
  });

  it("a direct write's receipt keeps the host it used when this daemon's later health read fails", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    let probes = 0;
    local.close();
    local = await serve((req) => req.path === "/healthz"
      ? (++probes === 1 ? { status: 200, data: { selfHostId: "vm-a" } } : { status: 500, data: { error: "busy" } })
      : { status: 500, data: { error: "the selected daemon must not be asked for the row" } });
    localPort = Number(new URL(local.url).port);
    await run("update", "qitem-remote-1", "--host", "devbox", "--state", "in-progress", "--json");
    const receipt = JSON.parse(out.join("\n"));
    expect(receipt.host).toBe("devbox");
    expect(receipt.hostUnconfirmed).toBeUndefined();
    expect(receipt.receipt.fullCommand).toBe("rig queue show 'qitem-remote-1' --host 'devbox' --full --json");
  });

  it("an unknown --host fails with unknown_host; only the selected daemon's own id is asked, to keep its own id local", async () => {
    await run("update", "qitem-remote-1", "--host", "nowhere", "--state", "done", "--json");
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join("\n")).error).toBe("unknown_host");
    expect(remote.seen).toEqual([]);
    expect(local.seen.map((s) => s.path)).toEqual(["/healthz"]);
  });

  it("a registry entry with no bearer configured is an anonymous host: called with no Authorization header", async () => {
    hosts.push({ id: "open", transport: "http", url: remote.url });
    await run("show", "qitem-remote-1", "--host", "open", "--json");
    const [call] = remoteQueueCalls();
    expect(call!.path).toBe("/api/queue/qitem-remote-1");
    expect(call!.headers.authorization).toBeUndefined();
  });

  it("a remote write's compact receipt names the host and a full read that reaches it", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    const { compactOutputEnabled } = await import("../src/queue-receipt.js");
    expect(compactOutputEnabled()).toBe(true);
    // The remote daemon's own id equals the alias: the receipt must still call the row remote.
    remoteAnswer = (req) => req.path === "/healthz" ? { status: 200, data: { selfHostId: "devbox" } } : { status: 200, data: ROW };
    await run("update", "qitem-remote-1", "--host", "devbox", "--state", "in-progress", "--json");
    const receipt = JSON.parse(out.join("\n"));
    expect(receipt.host).toBe("devbox");
    expect(receipt.receipt.fullCommand).toBe("rig queue show 'qitem-remote-1' --host 'devbox' --full --json");
  });

  it("without --host every verb asks the selected daemon, as before", async () => {
    local.close();
    local = await serve((req) => req.path === "/healthz"
      ? { status: 200, data: { selfHostId: "vm-a" } }
      : { status: 200, data: req.path.startsWith("/api/queue/list") ? [] : ROW });
    localPort = Number(new URL(local.url).port);
    await run("show", "qitem-remote-1", "--json");
    await run("list", "--json");
    await run("update", "qitem-remote-1", "--state", "done", "--json");
    expect(remote.seen).toEqual([]);
    expect(localQueueCalls().map((c) => c.path.split("?")[0])).toEqual(["/api/queue/qitem-remote-1", "/api/queue/list", "/api/queue/qitem-remote-1/update"]);
    // The local list still derives the rig from the seat, and no sender is stamped with a host id.
    expect(new URL(localQueueCalls()[1]!.path, "http://x").searchParams.get("rig")).toBe("fabrica");
    expect(localQueueCalls()[2]!.headers["x-openrig-session"]).toBe("dev@fabrica");
  });
});
