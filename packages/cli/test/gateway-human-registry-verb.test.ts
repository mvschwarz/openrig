import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../src/index.js";
// The registry module is home-state owned by the daemon; the verb (and this test) reach
// it via the narrow @openrig/daemon/gateway-human-registry subpath (the C3/crash-cart rail).
import { humansDir, loadHumanRegistry } from "@openrig/daemon/gateway-human-registry";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { REGISTRATION_OFFER } from "../src/person-registration-offer.js";

// M1 A3 pt2 / A4b relocate — `rig gateway human add` verb integration. The verb lazy-imports
// the relocated daemon surface; these tests drive the real command end-to-end.
describe("rig gateway human add verb (post-relocate)", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "a3-verb-"));
    prevHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
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
