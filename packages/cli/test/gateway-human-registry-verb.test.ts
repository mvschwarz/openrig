import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../src/index.js";
// The registry module is home-state owned by the daemon; the verb (and this test) reach
// it via the narrow @openrig/daemon/gateway-human-registry subpath (the C3/crash-cart rail).
import { humansDir, loadHumanRegistry } from "@openrig/daemon/gateway-human-registry";

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
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("is wired via createProgram (gateway human add)", () => {
    const gw = createProgram().commands.find((c) => c.name() === "gateway");
    expect(gw).toBeDefined();
    const human = gw!.commands.find((c) => c.name() === "human");
    expect(human!.commands.find((c) => c.name() === "add")).toBeDefined();
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
