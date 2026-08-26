import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../src/index.js";
import { gatewayCommand, type HumanRowsLookup } from "../src/commands/gateway.js";
import { humansDir, loadHumanRegistry } from "@openrig/daemon/gateway-human-registry";

// OPR.0.5.5.12 — `rig gateway human list|show|set|remove` verb wiring. Same harness as the
// add-verb test: temp OPENRIG_HOME, real command end-to-end, fs effects asserted at source.
// remove's queue-row check is injected (HumanRowsLookup) so these tests never need a daemon —
// the INDETERMINATE path is pinned with a lookup that fails like an unreachable daemon.

async function runAdd(name: string, extra: string[] = []): Promise<void> {
  const p = createProgram();
  p.exitOverride();
  await p.parseAsync([
    "node", "rig", "gateway", "human", "add", name,
    "--display-name", name,
    "--binding", `slack:main:vault://slack/${name}:primary`,
    "--delivery-class", "B",
    ...extra,
  ]);
}

describe("rig gateway human lifecycle verbs (S12)", () => {
  let home: string;
  let prevHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "s12-verb-"));
    prevHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log");
    errSpy = vi.spyOn(console, "error");
    await runAdd("mike");
    logSpy.mockClear();
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("is wired via createProgram: list, show, set, remove all exist under gateway human", () => {
    const gw = createProgram().commands.find((c) => c.name() === "gateway")!;
    const human = gw.commands.find((c) => c.name() === "human")!;
    for (const verb of ["list", "show", "set", "remove"]) {
      expect(human.commands.find((c) => c.name() === verb), `gateway human ${verb}`).toBeDefined();
    }
  });

  it("list --json emits the complete records", async () => {
    const p = createProgram();
    p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", "list", "--json"]);
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; humans: Array<Record<string, unknown>> };
    expect(out.ok).toBe(true);
    expect(out.humans).toHaveLength(1);
    expect(out.humans[0]!.entityId).toBe("mike");
    expect(out.humans[0]!.deliveryClass).toBe("B");
  });

  it("show --json carries authored-vs-default provenance and the fragment path", async () => {
    const p = createProgram();
    p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", "show", "mike", "--json"]);
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; record: { prefs: { away: { source: string } }; fragmentPath: string } };
    expect(out.ok).toBe(true);
    expect(out.record.prefs.away.source).toBe("default");
    expect(out.record.fragmentPath).toContain("mike.yaml");
  });

  it("set delivery-class lands in the fragment (verified at source, not from the echo)", async () => {
    const p = createProgram();
    p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", "set", "mike", "delivery-class", "D"]);
    expect(process.exitCode).toBeUndefined();
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.entities[0]!.prefs.deliveryClass).toBe("D");
  });

  it("set with a bad enum exits 1 and names the allowed set", async () => {
    const p = createProgram();
    p.exitOverride();
    try { await p.parseAsync(["node", "rig", "gateway", "human", "set", "mike", "delivery-class", "Z"]); } catch { /* exitCode path */ }
    expect(process.exitCode).toBe(1);
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toMatch(/A.*B.*C.*D/);
  });

  it("remove refuses with a teaching refusal enumerating in-flight rows from the injected lookup", async () => {
    const rows: HumanRowsLookup = async () => ({ ok: true, rows: [{ id: "qitem-777", state: "pending", summary: "ping mike" }] });
    const p = createProgram();
    p.exitOverride();
    const gw = gatewayCommand({ queueRows: rows });
    // Drive the injected command directly (same commander surface the program mounts).
    gw.exitOverride();
    try { await gw.parseAsync(["node", "gateway", "human", "remove", "mike"], { from: "node" as never }); } catch { /* exitCode */ }
    expect(process.exitCode).toBe(1);
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("qitem-777");
    expect(err).toContain("--force");
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
  });

  it("remove with an UNREACHABLE rows lookup refuses as INDETERMINATE — force does not override ignorance", async () => {
    const rows: HumanRowsLookup = async () => ({ ok: false, error: "daemon unreachable at http://127.0.0.1:9" });
    for (const args of [["remove", "mike"], ["remove", "mike", "--force"]]) {
      process.exitCode = undefined;
      const gw = gatewayCommand({ queueRows: rows });
      gw.exitOverride();
      try { await gw.parseAsync(["node", "gateway", "human", ...args], { from: "node" as never }); } catch { /* exitCode */ }
      expect(process.exitCode).toBe(1);
    }
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("could not be checked"); // names the unchecked surface, never fabricates absence
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
  });

  it("remove with a clean board archives and reports the archive path", async () => {
    const rows: HumanRowsLookup = async () => ({ ok: true, rows: [] });
    const gw = gatewayCommand({ queueRows: rows });
    gw.exitOverride();
    await gw.parseAsync(["node", "gateway", "human", "remove", "mike"], { from: "node" as never });
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(false);
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; archivedPath: string };
    expect(out.ok).toBe(true);
    expect(existsSync(out.archivedPath)).toBe(true);
  });
});
