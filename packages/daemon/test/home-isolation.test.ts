// An isolated OPENRIG_HOME that still carries the real HOME or CODEX_HOME is how an isolated test daemon
// once rewrote the user's ~/.codex/config.toml. The daemon warns and still starts.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeIsolationAdvisory } from "../src/domain/home-isolation.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "home-isolation-")); roots.push(root);
  const real = path.join(root, "real-home"), scratch = path.join(root, "scratch");
  fs.mkdirSync(real); fs.mkdirSync(scratch);
  return { root, real, scratch };
}

describe("homeIsolationAdvisory", () => {
  it("is silent for the default layout, whatever CODEX_HOME is", () => {
    const d = dirs();
    const account = { accountHome: d.real };
    expect(homeIsolationAdvisory({ ...account, openrigHome: path.join(d.real, ".openrig"), home: d.real })).toBeUndefined();
    expect(homeIsolationAdvisory({ ...account, openrigHome: path.join(d.real, ".openrig"), home: d.real, codexHome: path.join(d.scratch, "codex") })).toBeUndefined();
  });

  it("is silent when HOME, CODEX_HOME and OPENRIG_HOME are consistently isolated", () => {
    const d = dirs();
    expect(homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.scratch, ".openrig"), home: d.scratch, codexHome: path.join(d.scratch, ".codex") })).toBeUndefined();
    expect(homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.scratch, ".openrig"), home: d.scratch })).toBeUndefined();
    expect(homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.scratch, "custom"), home: d.scratch })).toBeUndefined();
    // HOME nested inside OPENRIG_HOME is consistent too.
    const nested = path.join(d.scratch, "home");
    expect(homeIsolationAdvisory({ accountHome: d.real, openrigHome: d.scratch, home: nested, codexHome: path.join(nested, ".codex") })).toBeUndefined();
    expect(homeIsolationAdvisory({ accountHome: d.real, openrigHome: d.scratch, home: nested })).toBeUndefined();
  });

  it("warns when the isolated OPENRIG_HOME still has the real HOME", () => {
    const d = dirs();
    const msg = homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.scratch, ".openrig"), home: d.real, codexHome: path.join(d.scratch, ".openrig", "codex") });
    expect(msg).toContain(`OPENRIG_HOME=${path.join(d.scratch, ".openrig")}`);
    expect(msg).toContain(`HOME=${d.real}`);
    expect(msg).not.toContain("CODEX_HOME=");
    expect(msg).toContain("Starting anyway");
  });

  it("warns when OPENRIG_HOME sits inside the real HOME, naming HOME and the derived CODEX_HOME", () => {
    const d = dirs();
    const msg = homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.real, ".openrig-dev"), home: d.real })!;
    expect(msg).toContain(`HOME=${d.real}`);
    expect(msg).toContain(`CODEX_HOME=${path.join(d.real, ".codex")} (derived from HOME)`);
    const explicit = homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.real, ".openrig-dev"), home: d.real, codexHome: path.join(d.real, ".codex") })!;
    expect(explicit).toContain(`CODEX_HOME=${path.join(d.real, ".codex")}`);
    expect(explicit).toMatch(/(?<![A-Z_])HOME=/);
  });

  it("warns when the isolation root contains the real home", () => {
    const d = dirs();
    for (const input of [
      { openrigHome: d.real, home: d.real },
      { openrigHome: d.root, home: d.real },
      { openrigHome: d.root, home: d.scratch, codexHome: path.join(d.scratch, ".codex") },
      { openrigHome: path.join(d.scratch, ".openrig"), home: path.parse(d.root).root },
    ]) {
      const msg = homeIsolationAdvisory({ accountHome: d.real, ...input });
      expect(msg, JSON.stringify(input)).toContain(`contains the real home ${d.real}`);
    }
  });

  it("warns when the isolated OPENRIG_HOME and HOME carry the real CODEX_HOME", () => {
    const d = dirs();
    const real = path.join(d.real, ".codex");
    const msg = homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.scratch, ".openrig"), home: d.scratch, codexHome: real });
    expect(msg).toContain(`CODEX_HOME=${real}`);
    expect(msg).not.toMatch(/(?<![A-Z_])HOME=/);
  });

  it("names a derived CODEX_HOME when only HOME leaks", () => {
    const d = dirs();
    const msg = homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.scratch, ".openrig"), home: d.real })!;
    expect(msg).toContain(`HOME=${d.real}`);
    expect(msg).toContain(`CODEX_HOME=${path.join(d.real, ".codex")} (derived from HOME)`);
  });

  it("warns when HOME is nested in OPENRIG_HOME but CODEX_HOME is outside both", () => {
    const d = dirs(); const nested = path.join(d.scratch, "home"); const real = path.join(d.real, ".codex");
    const msg = homeIsolationAdvisory({ accountHome: d.real, openrigHome: d.scratch, home: nested, codexHome: real })!;
    expect(msg).toContain(`CODEX_HOME=${real}`);
    expect(msg).not.toMatch(/(?<![A-Z_])HOME=/);
  });

  it("warns for a scratch CODEX_HOME that sits outside the isolation root", () => {
    const d = dirs();
    const msg = homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(d.scratch, ".openrig"), home: d.scratch, codexHome: path.join(d.root, "elsewhere") });
    expect(msg).toContain(`CODEX_HOME=${path.join(d.root, "elsewhere")}`);
  });

  it("compares through symlinks", () => {
    const d = dirs(); const link = path.join(d.root, "link"); fs.symlinkSync(d.scratch, link);
    expect(homeIsolationAdvisory({ accountHome: d.real, openrigHome: path.join(link, ".openrig"), home: d.scratch, codexHome: path.join(d.scratch, ".codex") })).toBeUndefined();
  });
});

describe("daemon startup", () => {
  async function start(opts: { account: string; home: string; openrigHome: string; codexHome?: string; root: string }) {
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(opts.home);
    vi.spyOn(os, "userInfo").mockReturnValue({ homedir: opts.account } as os.UserInfo<string>);
    vi.stubEnv("HOME", opts.home); vi.stubEnv("OPENRIG_HOME", opts.openrigHome); vi.stubEnv("CODEX_HOME", opts.codexHome);
    vi.stubEnv("OPENRIG_DB", path.join(opts.root, "instance.sqlite")); vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    vi.stubEnv("OPENRIG_URL", undefined); vi.stubEnv("OPENRIG_PORT", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createDaemon } = await import("../src/startup.js");
    const daemon = await createDaemon({ dbPath: process.env.OPENRIG_DB!, tmuxExec: async () => "", cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
    daemon.db.close();
    return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("home isolation advisory"));
  }

  it("logs one advisory and still starts when CODEX_HOME is left real", async () => {
    const d = dirs(); const realCodex = path.join(d.real, ".codex");
    const advisories = await start({ root: d.root, account: d.real, home: d.scratch, openrigHome: path.join(d.scratch, ".openrig"), codexHome: realCodex });
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain(`CODEX_HOME=${realCodex}`);
  }, 60000);

  it("logs nothing for full isolation", async () => {
    const d = dirs();
    expect(await start({ root: d.root, account: d.real, home: d.scratch, openrigHome: path.join(d.scratch, ".openrig"), codexHome: path.join(d.scratch, ".codex") })).toEqual([]);
  }, 60000);

  it("logs nothing for the default layout", async () => {
    const d = dirs();
    expect(await start({ root: d.root, account: d.real, home: d.real, openrigHome: path.join(d.real, ".openrig") })).toEqual([]);
  }, 60000);
});
