// rig host approve|deny <request>: the explicit pairing decision on this host, from the agent that reads the person's
// answer or from a person at a plain terminal. A local HTTP server stands in for the daemon; no real token.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { hostCommand } from "../src/commands/host.js";

describe("rig host approve|deny", () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;
  let server: http.Server;
  let requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }>;
  let reply: { status: number; body: unknown };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostdecide-"));
    savedEnv = {};
    for (const k of ["OPENRIG_HOME", "RIGGED_HOME", "OPENRIG_URL", "RIGGED_URL", "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME", "OPENRIG_TERMINAL_BEARER_TOKEN"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.OPENRIG_HOME = dir;
    // A plain terminal's write credential (terminalAuthHeaders reads it from the OpenRig home).
    fs.writeFileSync(path.join(dir, "terminal-token"), "synthetic-terminal-token\n");
    requests = [];
    reply = { status: 200, body: { ok: true, decision: "approve", code: "424242", requester: "alex@laptop", by: "human@host" } };
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        requests.push({ url: req.url ?? "", headers: req.headers, body });
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.OPENRIG_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function run(argv: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
    const out: string[] = []; const err: string[] = [];
    const ol = console.log; const oe = console.error; const oc = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    try {
      const prog = new Command();
      prog.exitOverride();
      prog.addCommand(hostCommand());
      await prog.parseAsync(["node", "rig", "host", ...argv]);
    } finally { console.log = ol; console.error = oe; }
    const exitCode = process.exitCode as number | undefined;
    process.exitCode = oc;
    return { out: out.join("\n"), err: err.join("\n"), exitCode };
  }

  it("approve from a plain terminal: one authenticated write naming the request, no seat, and the result printed", async () => {
    const { out, err, exitCode } = await run(["approve", "424242"]);
    expect(exitCode).toBeUndefined();
    expect(err).toBe("");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/hosts/pair-decision");
    expect(JSON.parse(requests[0]!.body)).toEqual({ request: "424242", decision: "approve" });
    expect(requests[0]!.headers.authorization).toBe("Bearer synthetic-terminal-token");
    expect(requests[0]!.headers["x-openrig-session"]).toBeUndefined();
    expect(out).toBe("Approved pairing 424242 from alex@laptop, as human@host. The requesting machine receives this host's token when it next checks.");
  });

  it("deny from a seat carries the seat, and a refusal prints the daemon's message and exits 1", async () => {
    process.env.OPENRIG_SESSION_NAME = "operator-agent@kernel";
    reply = { status: 409, body: { error: "pair_request_decided", decision: "approve", by: "human@host",
      message: "Pairing request 424242 was already approved by human@host; that stands." } };
    const { out, err, exitCode } = await run(["deny", "qitem-pair-1"]);
    expect(exitCode).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("Pairing request 424242 was already approved by human@host; that stands.");
    expect(JSON.parse(requests[0]!.body)).toEqual({ request: "qitem-pair-1", decision: "deny" });
    expect(requests[0]!.headers["x-openrig-session"]).toBe("operator-agent@kernel");
  });
});
