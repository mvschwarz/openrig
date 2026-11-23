import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createProgram } from "../src/index.js";
// The registry module is home-state owned by the daemon; the verb (and this test) reach
// it via the narrow @openrig/daemon/gateway-human-registry subpath (the C3/crash-cart rail).
import { humansDir, loadHumanRegistry } from "@openrig/daemon/gateway-human-registry";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { REGISTRATION_OFFER } from "../src/person-registration-offer.js";
import { seatsReadAsPerson } from "../src/commands/gateway.js";
import * as localOrigin from "../src/local-origin.js";

// M1 A3 pt2 / A4b relocate — `rig gateway human add` verb integration. The verb lazy-imports
// the relocated daemon surface; these tests drive the real command end-to-end.
describe("rig gateway human add verb (post-relocate)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevUrl: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "a3-verb-"));
    prevHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    // add reads the daemon's seats for its name warning: a closed port keeps these tests off any live daemon.
    prevUrl = process.env.OPENRIG_URL;
    process.env.OPENRIG_URL = "http://127.0.0.1:9";
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = prevUrl;
    rmSync(home, { recursive: true, force: true });
  });

  // The kernel operator runs `rig gateway participants` before its greeting: with nobody registered, the output ends with
  // the same offer `rig daemon start` prints; once someone is, it doesn't.
  it("participants ends with the registration offer while nobody is registered, and drops it once someone is", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const empty = createProgram(); empty.exitOverride();
    await empty.parseAsync(["node", "rig", "gateway", "participants"]);
    const before = log.mock.calls.map((call) => String(call[0]));
    expect(before.slice(-REGISTRATION_OFFER.length)).toEqual([...REGISTRATION_OFFER]);
    expect(existsSync(humansDir(home))).toBe(false);
    const add = createProgram(); add.exitOverride();
    await add.parseAsync(["node", "rig", "gateway", "human", "add", "mike", "--display-name", "Mike", "--delivery-class", "B"]);
    log.mockClear();
    const after = createProgram(); after.exitOverride();
    await after.parseAsync(["node", "rig", "gateway", "participants"]);
    expect(log.mock.calls.map((call) => String(call[0]))).not.toContain(REGISTRATION_OFFER[0]);
  });

  it("participants --json and the daemon route expose the same filtered view", async () => {
    const add = createProgram(); add.exitOverride();
    await add.parseAsync(["node", "rig", "gateway", "human", "add", "mike", "--display-name", "Mike", "--delivery-class", "B"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const command = createProgram(); command.exitOverride();
    await command.parseAsync(["node", "rig", "gateway", "participants", "--organization", "missing", "--json"]);
    const cli = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    const response = await gatewayRoutes({ home }).request("/participants?organization=missing");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cli);
    expect(cli).toMatchObject({ ok: true, participants: [], default: { id: "mike", source: "only-person" } });
  });

  it("is wired via createProgram (gateway human add)", () => {
    const gw = createProgram().commands.find((c) => c.name() === "gateway");
    expect(gw).toBeDefined();
    const human = gw!.commands.find((c) => c.name() === "human");
    const addCmd = human!.commands.find((c) => c.name() === "add");
    expect(addCmd).toBeDefined();
    const bindingOpt = addCmd!.options.find((o) => o.name() === "binding");
    expect(bindingOpt).toBeDefined();
    expect(bindingOpt!.description).toContain("connectorRef and secretsRef are config/vault labels");
    expect(bindingOpt!.description).toContain("tokens come from 'rig slack setup --secrets-env-file'");
    expect(bindingOpt!.description).toContain("or file:<path> for relay");
  });

  it("gateway human add help text documents relay binding syntax and requirements", () => {
    const gw = createProgram().commands.find((c) => c.name() === "gateway");
    const human = gw!.commands.find((c) => c.name() === "human");
    const addCmd = human!.commands.find((c) => c.name() === "add");
    let help = "";
    addCmd!.configureOutput({
      writeOut: (text) => { help += text; },
      writeErr: () => {},
    });
    addCmd!.outputHelp();
    expect(help).toContain("relay:<connectorRef>:file:<absolute-env-file>:primary:handle=<safe-alias>");
    expect(help).toContain("OPENRIG_RELAY_URL");
    expect(help).toContain("OPENRIG_RELAY_OUTBOUND_TOKEN");
    expect(help).toContain("OPENRIG_RELAY_INBOUND_TOKEN");
  });

  it("add writes a fragment + projection; address DERIVED; vault-pointer secretsRef (with ':') survives", async () => {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "gateway", "human", "add", "mike",
      "--display-name", "Mike",
      "--binding", "slack:main:vault://slack/mike:primary",
      "--delivery-class", "B",
    ]);
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.entities[0]!.address).toBe("mike@external");
      expect(loaded.entities[0]!.connectorBindings[0]!.secretsRef).toBe("vault://slack/mike");
    }
  });

  it("says a person added with no connector is asked in the Feed and Steering only, and says nothing of it with one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bare = createProgram(); bare.exitOverride();
    await bare.parseAsync(["node", "rig", "gateway", "human", "add", "ana", "--display-name", "Ana", "--delivery-class", "A"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: true, entityId: "ana", delivery: "Feed and Steering only" });
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
      "ana has no connector binding, so messages and questions reach them only in the TUI's Feed and Steering until one is added: rerun rig gateway human add ana --replace "
        + "with the same options plus --binding <kind:connectorRef:secretsRef:primary[:handle=<id>]> (rig gateway human set's binding.<n> changes only a binding that exists).",
    ]);
    expect(process.exitCode).toBeUndefined();
    // The hint's command adds the binding; binding.0 on a person with none is out of range, which is why the hint doesn't name it.
    const outOfRange = createProgram(); outOfRange.exitOverride();
    await outOfRange.parseAsync(["node", "rig", "gateway", "human", "set", "ana", "binding.0", "slack:main:vault://slack/ana:primary"]);
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("is out of range");
    process.exitCode = undefined;
    const replaced = createProgram(); replaced.exitOverride();
    await replaced.parseAsync(["node", "rig", "gateway", "human", "add", "ana", "--replace", "--display-name", "Ana", "--delivery-class", "A", "--binding", "slack:main:vault://slack/ana:primary"]);
    expect(process.exitCode).toBeUndefined();
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok && loaded.entities.find((e) => e.entityId === "ana")?.connectorBindings.length).toBe(1);
    error.mockClear();
    const bound = createProgram(); bound.exitOverride();
    await bound.parseAsync(["node", "rig", "gateway", "human", "add", "mike", "--display-name", "Mike", "--binding", "slack:main:vault://slack/mike:primary", "--delivery-class", "B"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).not.toHaveProperty("delivery");
    expect(error).not.toHaveBeenCalled();
  });

  /** A stand-in daemon answering `/api/ps?seats=true` with `rigs` (null: never answers it); the paths it was asked. */
  async function fakeDaemon(rigs: unknown[] | null, holdHealth = false): Promise<{ asked: string[]; close: () => Promise<void> }> {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/") || (holdHealth && req.url === "/healthz")) asked.push(req.url);
      if (holdHealth && req.url === "/healthz") return;
      if (req.url === "/api/ps?seats=true" && rigs === null) return; // holds the request open
      const body = req.url === "/api/ps?seats=true" ? rigs : null;
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    process.env.OPENRIG_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { asked, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
  }

  it("warns when a seat's member name is the new person's id, since that seat is then treated as the person", async () => {
    const daemon = await fakeDaemon([{ rigId: "r1", seats: ["mike@team", "ops-lead@team"] }, { rigId: "r2", seats: [] }]);
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const add = createProgram(); add.exitOverride();
      await add.parseAsync(["node", "rig", "gateway", "human", "add", "mike", "--display-name", "Mike", "--binding", "slack:main:vault://slack/mike:primary", "--delivery-class", "B"]);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: true, entityId: "mike" });
      expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
        "warning: mike@team is a seat whose member name is mike, so work and messages addressed to it are treated as addressed to the person mike. "
          + "That's intended for the person's own pane; otherwise rename the seat or choose another id.",
      ]);
      expect(process.exitCode).toBeUndefined();
      // One read for every rig's seats, not a node read per rig.
      expect(daemon.asked).toEqual(["/api/ps?seats=true"]);
      // No seat shares the name: nothing is said.
      error.mockClear();
      const other = createProgram(); other.exitOverride();
      await other.parseAsync(["node", "rig", "gateway", "human", "add", "ana", "--display-name", "Ana", "--binding", "slack:main:vault://slack/ana:primary", "--delivery-class", "B"]);
      expect(error).not.toHaveBeenCalled();
    } finally { await daemon.close(); }
  });

  it("registers without the warning when the daemon lists no seat names or doesn't answer in time", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const add = async (id: string) => {
      const program = createProgram(); program.exitOverride();
      await program.parseAsync(["node", "rig", "gateway", "human", "add", id, "--display-name", id, "--binding", `slack:main:vault://slack/${id}:primary`, "--delivery-class", "B"]);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: true, entityId: id });
    };
    // A daemon that doesn't list seat names (an earlier version): the person is registered, nothing is said.
    const older = await fakeDaemon([{ rigId: "r1" }]);
    try { await add("mike"); } finally { await older.close(); }
    // A daemon that holds the read: add stops waiting at its bound and still registers the person.
    const stalled = await fakeDaemon(null);
    try {
      const started = Date.now();
      await add("ana");
      expect(Date.now() - started).toBeLessThan(4_500);
    } finally { await stalled.close(); }
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  }, 10_000);

  it("includes a slow client preflight in the warning's two-second wait", async () => {
    const daemon = await fakeDaemon(null, true);
    // A seat using an explicit endpoint first asks /healthz for the endpoint's identity (up to a second).
    // Keep that real client/network path: its request timeout alone would make the whole lookup take about three seconds.
    vi.stubEnv("OPENRIG_SESSION_NAME", "reader@local");
    vi.spyOn(localOrigin, "readLocalOrigin").mockReturnValue("test-origin");
    try {
      const started = performance.now();
      expect(await seatsReadAsPerson(() => true)).toEqual([]);
      expect(performance.now() - started).toBeLessThan(2_600);
      expect(daemon.asked).toEqual(["/healthz", "/api/ps?seats=true"]);
    } finally { vi.unstubAllEnvs(); await daemon.close(); }
  }, 10_000);

  it("A6 v3: an OPTIONAL handle= token parses alongside a ':'-bearing secretsRef (inbound-resolvable)", async () => {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "gateway", "human", "add", "mike",
      "--display-name", "Mike",
      "--binding", "slack:main:vault://slack/mike:primary:handle=U012AB3CD",
      "--delivery-class", "B",
    ]);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const b = loaded.entities[0]!.connectorBindings[0]!;
      expect(b.secretsRef).toBe("vault://slack/mike"); // the ':'-bearing pointer survived intact
      expect(b.handle).toBe("U012AB3CD");              // and the handle was extracted
    }
  });

  it("add REFUSES an existing entityId (no silent clobber; exit 1)", async () => {
    const args = [
      "node", "rig", "gateway", "human", "add", "mike",
      "--display-name", "Mike", "--binding", "slack:main:vault://x:primary", "--delivery-class", "B",
    ];
    const p1 = createProgram(); p1.exitOverride();
    await p1.parseAsync(args);
    expect(process.exitCode).toBeUndefined();
    process.exitCode = undefined;
    const p2 = createProgram(); p2.exitOverride();
    try { await p2.parseAsync(args); } catch { /* action sets exitCode, not throw */ }
    expect(process.exitCode).toBe(1);
  });
});
