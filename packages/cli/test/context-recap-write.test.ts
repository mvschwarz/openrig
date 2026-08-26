// OPR.0.5.3.5 recap-write atom — the outgoing occupant's write verb (the Q2
// boundary requirement the store alone does not satisfy). Daemon-independent
// like trace: seat dir resolves from topology.root CONFIG (slice-06 D1 layout),
// the write flows through the ONE store (supersession + addressability gate),
// advisory contract findings ride stderr, and the gate refuses loud.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";

async function runRecapWrite(argv: string[]): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errLogs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(contextCommand());
    await program.parseAsync(["node", "rig", "context", ...argv]);
  } catch { /* commander exitOverride */ } finally {
    exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  return { logs, errLogs, exitCode };
}

describe("rig context recap-write — the boundary write verb", () => {
  it("writes RECAP.md to the topology seat dir, supersedes into the chain, and echoes advisory findings on stderr", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s05-recap-verb-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(join(tmp, "topology", "rigs", "r1", "seats", "s1"), { recursive: true });
      const f1 = join(tmp, "era1.md");
      writeFileSync(f1, "## Recent Decisions\nchose X because Y");
      const first = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", f1]);
      expect(first.exitCode ?? 0).toBe(0);
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("chose X because Y");
      // Second write supersedes; content missing a decisions section draws the
      // ADVISORY finding on stderr but still lands (never gated on prose).
      const f2 = join(tmp, "era2.md");
      writeFileSync(f2, "## Status\nall done");
      const second = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", f2]);
      expect(second.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("all done");
      expect(readdirSync(join(seatDir, "recap-superseded"))).toHaveLength(1);
      expect(second.errLogs.join("\n")).toMatch(/decisions/i);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("provisions a missing seat directory beneath an existing topology rig", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-provision-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const rigDir = join(tmp, "topology", "rigs", "r1");
      const seatDir = join(rigDir, "seats", "s1");
      mkdirSync(rigDir, { recursive: true });
      expect(existsSync(seatDir)).toBe(false);
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nchose provisioning because manual mkdir is not a product path");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);

      expect(res.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("chose provisioning");
      writeFileSync(recap, "## Recent Decisions\nkept the supported store path because it preserves the chain");
      const second = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);
      expect(second.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("preserves the chain");
      expect(readdirSync(join(seatDir, "recap-superseded"))).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a missing rig instead of manufacturing an arbitrary topology", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-missing-rig-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "missing", "--seat", "s1", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/rig.*does not exist|topology/i);
      expect(existsSync(join(tmp, "topology", "rigs", "missing"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses unsafe rig or seat path segments before provisioning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-path-guard-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(join(tmp, "topology", "rigs", "r1"), { recursive: true });
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "../escape", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/unsafe|segment/i);
      expect(existsSync(join(tmp, "topology", "rigs", "r1", "escape"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to provision through a symlinked topology namespace", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-symlink-guard-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const rigDir = join(tmp, "topology", "rigs", "r1");
      const outside = join(tmp, "outside");
      mkdirSync(rigDir, { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(rigDir, "seats"));
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/symlink|escape|unsafe/i);
      expect(existsSync(join(outside, "s1"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the addressability gate refuses LOUD and leaves nothing behind", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s05-recap-verb2-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      mkdirSync(seatDir, { recursive: true });
      const bad = join(tmp, "bad.md");
      writeFileSync(bad, "## Same\na\n## Same\nb");
      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", bad]);
      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/addressab|duplicate/i);
      expect(existsSync(join(seatDir, "RECAP.md"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
