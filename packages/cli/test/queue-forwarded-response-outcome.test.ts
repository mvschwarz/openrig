import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Command } from "commander";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";

// The remote origin is real HTTP; the CLI client reaches the real forwarding route
// through Hono's request entry point. No queue repository or local fallback is installed.
describe("forwarded queue response outcomes reach the CLI", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    if (server) {
      server.close();
      await once(server, "close");
      server = undefined;
    }
  });

  it.each(["interrupted", "success", "refused"] as const)("renders %s without retrying, with a preallocated ID", async (mode) => {
    const requests: Array<{ method?: string; path?: string; body: Record<string, unknown> }> = [];
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
      if (mode === "interrupted") {
        res.writeHead(201, { "content-type": "application/json", "content-length": "200" });
        res.flushHeaders();
        res.write('{"qitemId":');
        // Give fetch time to observe the headers; this is not a deadline test.
        setTimeout(() => res.destroy(), 50);
      } else {
        res.writeHead(mode === "success" ? 201 : 409, { "content-type": "application/json" });
        res.end(JSON.stringify(mode === "success" ? { qitemId: requests[0]!.body.qitemId } : { error: "qitem_id_reuse" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c.set as (key: string, value: unknown) => void)("hostRegistryLoader", () => ({
        ok: true, registry: { hosts: [{ id: "edge", transport: "http", url: `http://127.0.0.1:${address.port}` }] },
      }));
      await next();
    });
    app.route("/api/queue", queueRoutes());
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps: QueueDeps = {
      lifecycleDeps: {
        spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
        readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(),
        exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 0),
        isProcessAlive: vi.fn(() => false), sleep: async () => {},
      } as unknown as QueueDeps["lifecycleDeps"],
      clientFactory: () => new DaemonClient("http://forwarder", {
        fetchImpl: ((url, init) => app.request(new Request(url as string, init))) as typeof fetch,
      }),
    };
    const program = new Command();
    program.addCommand(queueCommand(deps));
    await program.parseAsync([
      "node", "rig", "queue", "create", "--destination", "worker@rig", "--body", "proof",
      "--summary", "proof", "--host", "edge", "--no-nudge", "--json",
    ]);
    const response = JSON.parse(String(output.mock.calls[0]?.[0]));
    const stderr = errors.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(requests).toHaveLength(1);
    const id = requests[0]!.body.qitemId;
    expect(typeof id).toBe("string");
    expect(requests[0]).toMatchObject({ method: "POST", path: "/api/queue/create", body: { nudge: false } });
    expect(stderr).toContain(`Queue create request ID: ${id}`);
    expect(stderr).toContain("not proof of persistence");
    expect(stderr).toContain("destination host 'edge'");
    expect(stderr).toContain(`OPENRIG_URL='<destination-daemon-url>' rig queue show '${id}' --full --json`);
    expect(stderr).not.toContain("--full --json on destination host");
    if (mode === "interrupted") {
      expect(response).toMatchObject({ error: "remote_queue_write_failed", hostId: "edge", remoteStatus: 201, outcome: "indeterminate" });
      expect(response.qitemId).toBe(id);
      expect(response.recovery).toContain(`--id '${id}'`);
      expect(stderr).toContain("INDETERMINATE");
      expect(stderr).toContain("reconcile by ID before any retry");
      expect(process.exitCode).toBe(2);
    } else if (mode === "success") {
      expect(response).toEqual({ qitemId: id });
      expect(stderr).not.toContain("INDETERMINATE");
      expect(process.exitCode).toBeUndefined();
    } else {
      expect(response).toMatchObject({ failureClass: "remote-error", remoteStatus: 409, detail: "qitem_id_reuse" });
      expect(response.outcome).toBeUndefined();
      expect(stderr).not.toContain("INDETERMINATE");
      expect(process.exitCode).toBe(2);
    }
  });
});
