// OPR.0.4.1.29 — seat->profile registry: product-native, METADATA only, NO resume_token (orch D2).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectPrivateFile } from "./helpers/private-file.js";
import {
  resolveCodexHome,
  authSeatSet,
  authSeatsList,
  authSeatShow,
  authSeatsReport,
  SEAT_REGISTRY_DISCLAIMER,
} from "../src/lib/codex-auth.js";

const NOW = () => "2026-06-26T00:00:00Z";
let home: string;
let paths: ReturnType<typeof resolveCodexHome>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-seats-"));
  paths = resolveCodexHome({ CODEX_HOME: home });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("auth seats registry (OPR.0.4.1.29)", () => {
  it("creates a private registry with the product columns (NO resume_token) and upserts in place", () => {
    expect(authSeatSet(paths, { seat: "dev1@rig", rig: "rig", runtime: "codex", cwd: "/x", authProfile: "work" }, NOW)).toMatchObject({ ok: true });
    const content = fs.readFileSync(paths.registryPath, "utf8");
    expect(content.split("\n")[0]).toBe("seat\trig\truntime\tcwd\tauth_profile\tupdated_ts");
    expect(content).not.toContain("resume_token");
    expectPrivateFile(paths.registryPath);
    authSeatSet(paths, { seat: "dev1@rig", rig: "rig", runtime: "codex", authProfile: "team" }, NOW);
    expectPrivateFile(paths.registryPath);
    const rows = authSeatsList(paths).filter((r) => r.seat === "dev1@rig");
    expect(rows.length).toBe(1);
    expect(rows[0].authProfile).toBe("team");
  });

  it("rejects invalid runtime + control-char seat fail-closed", () => {
    expect(authSeatSet(paths, { seat: "s@r", rig: "r", runtime: "claude-code" }, NOW)).toEqual({ ok: false, reason: "invalid_runtime" });
    expect(authSeatSet(paths, { seat: "bad\tseat", rig: "r", runtime: "codex" }, NOW)).toEqual({ ok: false, reason: "invalid_seat" });
  });

  it("defaults cwd + auth_profile to unknown; report counts known vs unknown", () => {
    authSeatSet(paths, { seat: "a@r", rig: "r", runtime: "codex", authProfile: "work" }, NOW);
    authSeatSet(paths, { seat: "b@r", rig: "r", runtime: "codex" }, NOW);
    expect(authSeatsReport(paths)).toMatchObject({ registryPresent: true, total: 2, known: 1, unknown: 1, malformed: 0 });
  });

  it("show returns the row or missing_seat", () => {
    authSeatSet(paths, { seat: "a@r", rig: "r", runtime: "codex", authProfile: "work" }, NOW);
    expect(authSeatShow(paths, "a@r")).toMatchObject({ ok: true, row: { seat: "a@r", authProfile: "work" } });
    expect(authSeatShow(paths, "ghost")).toEqual({ ok: false, reason: "missing_seat" });
  });

  it("drops malformed rows on report (never fabricates metadata)", () => {
    authSeatSet(paths, { seat: "a@r", rig: "r", runtime: "codex" }, NOW);
    fs.appendFileSync(paths.registryPath, "malformed-single-field\n");
    const rep = authSeatsReport(paths);
    expect(rep.total).toBe(1);
    expect(rep.malformed).toBe(1);
  });

  it("exposes a not-proof-of-live-account disclaimer for command output", () => {
    expect(SEAT_REGISTRY_DISCLAIMER).toMatch(/not.*(proof|prove)|metadata/i);
  });
});
