import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendCommand, wrapSendBody, type SendDeps } from "../../cli/src/commands/send.js";
import { senderIdentityHeaders } from "../../cli/src/client.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { isBoundTerminalSeat, isTerminalSeat } from "../src/domain/terminal-seat.js";
import { transportRoutes } from "../src/routes/transport.js";
import { createFullTestDb } from "./helpers/test-app.js";

const BODY = "printf '%s\\n' 'terminal-body-marker' 'From: user-authored' '---' '↩ Reply: user-authored'";
const OUTPUT = "terminal-body-marker\nFrom: user-authored\n---\n↩ Reply: user-authored\n";

// Commander -> actual routes/SQLite/transport/file-backed adapter. The argv seam
// models a paste and Enter; only an owned /bin/sh executes that exact stream.
// This is not a live pane, SSH connection, agent or terminal-emulator claim.
describe("terminal-runtime send framing", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let scratch: string;
  beforeEach(() => {
    db = createFullTestDb();
    scratch = mkdtempSync(join(tmpdir(), "terminal-framing-"));
    vi.stubEnv("OPENRIG_URL", "http://local-fixture:7433");
    vi.stubEnv("OPENRIG_SESSION_NAME", "operator@framing");
    vi.stubEnv("OPENRIG_HOST_SELECTED", "");
  });
  afterEach(() => { db.close(); rmSync(scratch, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  function fixture(runtime: "terminal" | "claude-code" = "terminal", execute = true) {
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("framing");
    const name = "shell@framing";
    const node = rigRepo.addNode(rig.id, "shell", { runtime });
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name });
    const pasted: string[] = [];
    const commands: string[][] = [];
    const executions: Array<{ status: number | null; stdout: string; stderr: string }> = [];
    let buffer = "";
    let input = "";
    const tmux = new TmuxAdapter(async () => { throw new Error("argv executor expected"); }, {
      tmpName: () => join(scratch, "input"), bufferName: () => "terminal-framing",
      writeFile: async (_file, text) => { buffer = text; }, unlink: async () => {},
    }, async argv => {
      commands.push(argv);
      if (argv[1] === "paste-buffer") { pasted.push(buffer); input += buffer; }
      if (argv[1] === "send-keys" && argv.includes("Enter") && runtime === "terminal" && execute) {
        const result = spawnSync("/bin/sh", ["-s"], { input: input + "\n", cwd: scratch,
          env: { PATH: "/usr/bin:/bin", HOME: scratch }, encoding: "utf8", timeout: 3_000 });
        if (result.error) throw result.error;
        executions.push({ status: result.status, stdout: result.stdout, stderr: result.stderr });
        input = "";
      }
      return "";
    });
    tmux.getPanePid = async () => null;
    tmux.getPaneCommand = async () => null;
    tmux.capturePaneContent = async () => "idle\n❯ ";
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry: registry, tmuxAdapter: tmux, sleep: async () => {} });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport); await next(); });
    app.route("/api/transport", transportRoutes());
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const sshArgv: string[][] = [];
    const deps = {
      lifecycleDeps: { exists: () => false, readFile: () => null, isProcessAlive: () => false,
        fetch: async () => ({ ok: true, json: async () => ({ selfHostId: "fixture-host" }) }),
        spawn: () => { throw new Error("No lifecycle allowed"); }, kill: () => { throw new Error("No lifecycle allowed"); } },
      clientFactory: () => {
        const client = { originSelfHostId: undefined as string | undefined,
          post: async (path: string, body: Record<string, unknown>) => {
            requests.push({ path, body });
            const res = await app.request(path, { method: "POST", headers: {
              "Content-Type": "application/json", ...senderIdentityHeaders(client.originSelfHostId),
            }, body: JSON.stringify(body) });
            return { status: res.status, data: await res.json() };
          } };
        return client;
      },
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [
        { id: "remote-http", transport: "http", url: "http://remote-fixture:7433" },
        { id: "remote-ssh", transport: "ssh", target: "fixture.invalid" },
      ] } }),
      crossHostRun: async (_host: unknown, argv: readonly string[]) => {
        sshArgv.push([...argv]);
        await new Command().addCommand(sendCommand(deps as unknown as SendDeps)).parseAsync(["node", ...argv]);
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
    };
    return { name, pasted, commands, executions, requests, sshArgv, node, session, registry,
      rigRepo, rig, transport, deps: deps as unknown as SendDeps };
  }

  async function run(f: ReturnType<typeof fixture>, args: string[]) {
    const previous = process.exitCode;
    process.exitCode = undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await new Command().addCommand(sendCommand(f.deps)).parseAsync(["node", "rig", "send", ...args, "--json"]);
      return process.exitCode ?? 0;
    } finally { log.mockRestore(); error.mockRestore(); process.exitCode = previous; }
  }

  it.each(["local", "fan-out", "http", "ssh"])("%s delivers only the intended terminal body", async route => {
    const f = fixture();
    const args = route === "fan-out" ? ["--to", f.name, BODY]
      : [f.name, BODY, ...(route === "http" ? ["--host", "remote-http"] : route === "ssh" ? ["--host", "remote-ssh"] : [])];
    expect(await run(f, args)).toBe(0);
    expect(f.executions).toHaveLength(1);
    expect(f.executions[0]!.stdout).toBe(OUTPUT); // Body runs even on main; envelope also runs there.
    expect(f.executions[0]!.stderr).toBe("");
    expect(f.executions[0]!.status).toBe(0);
    expect(f.pasted).toEqual([BODY]); // No guessing at user-authored From:/---/reply bytes.
    if (route === "ssh") expect(f.sshArgv[0]!.slice(0, 4)).toEqual(["rig", "send", f.name, BODY]);
  });

  it("keeps deliberate raw terminal input byte-exact", async () => {
    const f = fixture();
    expect(await run(f, [f.name, BODY, "--raw"])).toBe(0);
    expect(f.pasted).toEqual([BODY]);
    expect(f.executions).toEqual([{ status: 0, stdout: OUTPUT, stderr: "" }]);
  });

  it("direct HTTP explicit interaction keeps text when exactText is also supplied", async () => {
    const f = fixture("terminal", false);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, f.transport); await next(); });
    app.route("/api/transport", transportRoutes());
    const response = await app.request("/api/transport/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: f.name, text: "explicit input", exactText: "different exact body",
        dangerouslyInteract: true, reason: "private explicit input control" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(f.pasted).toEqual(["explicit input"]);
    expect(f.commands.filter(argv => argv[1] === "send-keys" && argv.includes("Enter"))).toHaveLength(0);
  });

  it("keeps a non-terminal envelope with unreadable process observations", async () => {
    const f = fixture("claude-code");
    expect(await run(f, [f.name, BODY])).toBe(0);
    expect(f.pasted).toHaveLength(1);
    expect(f.pasted[0]).toContain("From: operator@framing\nTo: " + f.name);
    expect(f.pasted[0]).toContain("\n---\n" + BODY + "\n---\n↩ Reply:");
    expect(f.executions).toEqual([]);
  });

  it.each(["moved binding", "unbound canonical", "ambiguous binding"])(
    "does not infer an exact-text target from %s", async shape => {
      const f = fixture("terminal", false);
      if (shape === "moved binding") f.registry.updateBinding(f.node.id, { tmuxSession: "other@framing" });
      if (shape === "unbound canonical") {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(f.session.id);
        db.prepare("DELETE FROM bindings WHERE node_id = ?").run(f.node.id);
      }
      if (shape === "ambiguous binding") {
        const other = f.rigRepo.addNode(f.rig.id, "other", { runtime: "claude-code" });
        f.registry.updateBinding(other.id, { tmuxSession: f.name });
      }
      // Historical classification alone does not establish the current binding.
      expect(isTerminalSeat(db, f.name)).toBe(true);
      expect(isBoundTerminalSeat(db, f.name)).toBe(false);
      const original = wrapSendBody("operator@framing", f.name, BODY);
      const result = await f.transport.send(f.name, original, { exactText: BODY });
      expect(result.ok).toBe(true); // No new refusal or raw-mode inference.
      expect(result.envelopeOmitted).toBeUndefined();
      expect(f.pasted).toEqual([original]);
    });

  it("a real current binding establishes terminal input even without a session-history row", async () => {
    const f = fixture("terminal", false);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(f.session.id);
    expect(isBoundTerminalSeat(db, f.name)).toBe(true);
    const result = await f.transport.send(f.name, "rendered envelope", { exactText: BODY });
    expect(result).toMatchObject({ ok: true, envelopeOmitted: true });
    expect(f.pasted).toEqual([BODY]);
  });

  it("keeps an old client's unmarked envelope-looking text verbatim", async () => {
    const f = fixture("terminal", false);
    const original = wrapSendBody("operator@framing", f.name, BODY);
    const result = await f.transport.send(f.name, original);
    expect(result.ok).toBe(true);
    expect(result.envelopeOmitted).toBeUndefined();
    expect(f.pasted).toEqual([original]);
  });

  it("an OpenRig notice follows the current agent binding rather than old terminal history", async () => {
    const f = fixture("claude-code", false);
    const old = f.rigRepo.addNode(f.rig.id, "old.shell", { runtime: "terminal" });
    db.prepare("INSERT INTO sessions(id,node_id,session_name) VALUES ('zz-old-terminal',?,?)").run(old.id, f.name);
    f.registry.updateBinding(old.id, { tmuxSession: "old-shell@framing" });
    expect(isTerminalSeat(db, f.name)).toBe(true);
    expect(isBoundTerminalSeat(db, f.name)).toBe(false);
    const result = await f.transport.send(f.name, "current agent notice", { openrigNotice: true });
    expect(result.ok).toBe(true);
    expect(f.pasted).toEqual(["current agent notice"]);
  });

  it.each(["moved binding", "unbound canonical", "ambiguous binding"])(
    "an OpenRig notice takes the ordinary path for %s", async shape => {
      const f = fixture("terminal", false);
      if (shape === "moved binding") f.registry.updateBinding(f.node.id, { tmuxSession: "other@framing" });
      if (shape === "unbound canonical") db.prepare("DELETE FROM bindings WHERE node_id = ?").run(f.node.id);
      if (shape === "ambiguous binding") {
        const other = f.rigRepo.addNode(f.rig.id, "other", { runtime: "claude-code" });
        f.registry.updateBinding(other.id, { tmuxSession: f.name });
      }
      const result = await f.transport.send(f.name, "ordinary notice", { openrigNotice: true });
      expect(result.ok).toBe(true);
      expect(f.pasted).toEqual(["ordinary notice"]);
    });

  it("an OpenRig notice to a bound terminal seat types as before: the marker changes nothing by itself", async () => {
    const f = fixture("terminal", false);
    expect(isBoundTerminalSeat(db, f.name)).toBe(true);
    const result = await f.transport.send(f.name, "[OpenRig watchdog] a reminder", { openrigNotice: true });
    expect(result.ok).toBe(true);
    expect(result.envelopeOmitted).toBeUndefined();
    expect(f.pasted).toEqual(["[OpenRig watchdog] a reminder"]);
  });
});
