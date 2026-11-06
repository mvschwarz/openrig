import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ProbeStoppedError, ProbeTimeoutError } from "../src/adapters/bounded-probe-exec.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";

describe("Pi Node version probe", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => { db.close(); });

  it.each([
    ["v22.19.0", "verified"],
    ["v22.18.0", "error"],
  ])("checks the Node engine floor for %s", async (nodeVersion, status) => {
    const probeExec = vi.fn(async (cmd: string) => cmd === "pi --version" ? "pi 1.2.3" : nodeVersion);
    const result = await new RuntimeVerifier({ db, exec: vi.fn(), probeExec }).verifyPi();
    expect(result.status).toBe(status);
    expect(probeExec).toHaveBeenCalledWith("node --version");
  });

  it("retains the Pi result when Node is unavailable", async () => {
    const probeExec = vi.fn(async (cmd: string) => {
      if (cmd === "pi --version") return "pi 1.2.3";
      throw new Error("not found");
    });
    expect(await new RuntimeVerifier({ db, exec: vi.fn(), probeExec }).verifyPi()).toMatchObject({ status: "verified" });
  });

  it("reports a bounded Node probe timeout instead of leaving verification waiting", async () => {
    const exec = vi.fn(async () => "v22.19.0");
    const probeExec = vi.fn(async (cmd: string) => {
      if (cmd === "pi --version") return "pi 1.2.3";
      throw new ProbeTimeoutError(cmd, 30000);
    });
    const result = await new RuntimeVerifier({ db, exec, probeExec }).verifyPi();
    expect(result).toMatchObject({ status: "error", error: "node --version did not answer within 30 s; the probe was ended" });
    expect(probeExec).toHaveBeenCalledWith("node --version");
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not persist a verification when the Node probe is stopped", async () => {
    const stopped = new ProbeStoppedError("node --version", "ended");
    const probeExec = vi.fn(async (cmd: string) => {
      if (cmd === "pi --version") return "pi 1.2.3";
      throw stopped;
    });
    const exec = vi.fn(async () => "v22.19.0");
    await expect(new RuntimeVerifier({ db, exec, probeExec }).verifyPi()).rejects.toBe(stopped);
    expect(db.prepare("SELECT * FROM runtime_verifications WHERE runtime = 'pi'").get()).toBeUndefined();
  });
});
