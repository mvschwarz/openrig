import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";

// Lightweight test server that echoes request info as JSON
function createEchoServer(): { server: http.Server; port: number; close: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    // POST /api/conflict -> 409 (for non-2xx test)
    if (req.method === "POST" && url.pathname === "/api/conflict") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "already exists" }));
      return;
    }

    // GET /api/rigs/:id/spec -> text/yaml (for getText test)
    if (req.method === "GET" && url.pathname.endsWith("/spec")) {
      res.writeHead(200, { "Content-Type": "text/yaml" });
      res.end("schema_version: 1\nname: test-rig\n");
      return;
    }

    // POST /api/echo-raw -> echoes content-type and raw body (for postText test)
    if (req.method === "POST" && url.pathname === "/api/echo-raw") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ contentType: req.headers["content-type"], body }));
      });
      return;
    }

    // Collect body for POST
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        method: req.method,
        path: url.pathname,
        body: body || null,
      }));
    });
  });

  return {
    server,
    port: 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("DaemonClient", () => {
  let echoServer: ReturnType<typeof createEchoServer>;
  let baseUrl: string;

  beforeAll(async () => {
    echoServer = createEchoServer();
    await new Promise<void>((resolve) => {
      echoServer.server.listen(0, () => {
        const addr = echoServer.server.address();
        if (addr && typeof addr === "object") {
          echoServer.port = addr.port;
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await echoServer.close();
  });

  // Test 1: Client constructs correct URLs from base
  it("constructs correct URLs from base", () => {
    const client = new DaemonClient("http://localhost:9999");
    expect(client.baseUrl).toBe("http://localhost:9999");
  });

  // Test 2: Client GET returns { status, data } with parsed JSON
  it("GET returns { status, data } with parsed JSON", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.get("/api/rigs");

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      method: "GET",
      path: "/api/rigs",
      body: null,
    });
  });

  // Test 3: Client POST sends body, returns { status, data }
  it("POST sends body and returns { status, data }", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.post("/api/rigs", { name: "test-rig" });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      method: "POST",
      path: "/api/rigs",
      body: JSON.stringify({ name: "test-rig" }),
    });
  });

  // Test 4: Client handles connection refused -> throws DaemonConnectionError
  it("connection refused throws DaemonConnectionError", async () => {
    const client = new DaemonClient("http://localhost:1");
    await expect(client.get("/api/rigs")).rejects.toThrow(DaemonConnectionError);
  });

  // Test 5: Client uses OPENRIG_URL env, falls back to http://127.0.0.1:7433
  it("uses OPENRIG_URL env when set, falls back to http://127.0.0.1:7433", () => {
    // Default (no env)
    const saved = process.env["OPENRIG_URL"];
    delete process.env["OPENRIG_URL"];
    const defaultClient = new DaemonClient();
    expect(defaultClient.baseUrl).toBe("http://127.0.0.1:7433");

    // With env
    process.env["OPENRIG_URL"] = "http://custom:9000";
    const envClient = new DaemonClient();
    expect(envClient.baseUrl).toBe("http://custom:9000");

    // Cleanup
    if (saved !== undefined) {
      process.env["OPENRIG_URL"] = saved;
    } else {
      delete process.env["OPENRIG_URL"];
    }
  });

  // Test 6: CLI --version prints version string
  it("CLI --version prints version string", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { resolve } = await import("node:path");

    const cliEntry = resolve(import.meta.dirname, "../src/index.ts");
    const result = await execFileAsync("npx", ["tsx", cliEntry, "--version"], {
      cwd: resolve(import.meta.dirname, ".."),
    });

    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Test 7: Client non-2xx (409) -> returns { status: 409, data: errorBody }
  it("non-2xx response returns { status, data } without throwing", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.post("/api/conflict", {});

    expect(res.status).toBe(409);
    expect(res.data).toEqual({ error: "already exists" });
  });

  // Test 8: postText sends raw text body with correct Content-Type
  it("postText sends raw text body with text/yaml Content-Type", async () => {
    const client = new DaemonClient(baseUrl);
    const yaml = "schema_version: 1\nname: test\n";
    const res = await client.postText<{ contentType: string; body: string }>("/api/echo-raw", yaml);

    expect(res.status).toBe(200);
    expect(res.data.contentType).toBe("text/yaml");
    expect(res.data.body).toBe(yaml); // Raw text, NOT JSON-stringified
  });

  // Test 9: getText returns raw text body for non-JSON content (YAML export)
  it("getText returns raw text body for text/yaml response", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.getText("/api/rigs/r1/spec");

    expect(res.status).toBe(200);
    expect(res.data).toBe("schema_version: 1\nname: test-rig\n");
  });
});
