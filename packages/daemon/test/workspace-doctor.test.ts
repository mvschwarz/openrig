// Slice-21 FR-5 — workspace doctor check unit tests.
//
// Per banked feedback_handoff_body_claims_need_discriminator_verification,
// each check ships with a discriminator-flip negative test: if the
// production code were wrong, the assertion would catch it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkWorkspaceRootReachable,
  checkMissionsFolder,
  checkFileAllowlist,
  checkDaemonWorkspace,
  checkDaemonReload,
  checkOptionalSliceDocs,
  checkMissionNotesPresence,
  runWorkspaceDoctor,
  type DoctorCheck,
} from "../src/domain/workspace/workspace-doctor.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-doctor-"));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("FR-5 check #1 — workspace root reachable", () => {
  it("returns ok when workspace root is an existing directory", () => {
    const result: DoctorCheck = checkWorkspaceRootReachable({ workspaceRoot: dir, source: "default" });
    expect(result.check).toBe("workspace_root_reachable");
    expect(result.status).toBe("ok");
    expect(result.message).toContain(dir);
    expect(result.fixHint).toBeUndefined();
    expect(result.evidence).toEqual({ workspaceRoot: dir, source: "default" });
  });

  // Discriminator-flip: ENOENT path MUST be a fail, not silently pass.
  it("returns fail with ENOENT evidence when workspace root does not exist", () => {
    const missing = path.join(dir, "definitely-not-here");
    const result = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "env" });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("does not exist");
    expect(result.message).toContain("env");
    expect(result.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });

  // Discriminator-flip: a file (not directory) at the root MUST fail, not pass.
  // Without isDirectory() check, statSync would succeed and the check
  // would return ok — this test catches that regression.
  it("returns fail when workspace root is a regular file, not a directory", () => {
    const filePath = path.join(dir, "not-a-dir");
    fs.writeFileSync(filePath, "");
    const result = checkWorkspaceRootReachable({ workspaceRoot: filePath, source: "file" });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a directory");
    expect(result.fixHint).toContain("config.json");
    expect(result.evidence?.kind).toBe("not_a_directory");
  });

  // Source-aware fix-hint discriminator. If fix-hint resolution were
  // hard-coded to one source, this would catch it.
  it("emits source-aware fix-hints (env vs file vs default)", () => {
    const missing = path.join(dir, "missing");
    const envResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "env" });
    const fileResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "file" });
    const defaultResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "default" });
    expect(envResult.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    expect(envResult.fixHint).not.toContain("workspace.root in config.json");
    expect(fileResult.fixHint).toContain("workspace.root in config.json");
    expect(fileResult.fixHint).not.toContain("OPENRIG_WORKSPACE_ROOT");
    expect(defaultResult.fixHint).toContain("rig config init-workspace");
  });

  // Discriminator-flip: non-ENOENT IO error must still fail with a
  // useful message + evidence.errorCode (e.g., EACCES on permission
  // denied). Simulate by chmod 000 on a created subdir.
  it("returns fail with errorCode evidence on non-ENOENT stat error", () => {
    // Skip on platforms where chmod doesn't restrict stat (e.g. Windows,
    // root user). The check is the discriminator-flip we want, but it
    // must be robust under varied test environments.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const lockedParent = path.join(dir, "locked-parent");
    fs.mkdirSync(lockedParent);
    const inside = path.join(lockedParent, "inside");
    fs.mkdirSync(inside);
    try {
      fs.chmodSync(lockedParent, 0o000);
      const result = checkWorkspaceRootReachable({ workspaceRoot: inside, source: "env" });
      expect(result.status).toBe("fail");
      expect(result.evidence?.errorCode).toBeDefined();
      expect(result.evidence?.errorCode).not.toBe("unknown");
    } finally {
      fs.chmodSync(lockedParent, 0o700);
    }
  });
});

describe("FR-5 check #2 — missions folder present", () => {
  it("returns ok when default missions folder exists", () => {
    const missionsDir = path.join(dir, "missions");
    fs.mkdirSync(missionsDir);
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: missionsDir });
    expect(result.check).toBe("missions_folder_present");
    expect(result.status).toBe("ok");
    expect(result.evidence?.slicesRoot).toBe(missionsDir);
  });

  // Discriminator-flip: missing folder must fail with default-fix-hint
  // since slicesRoot equals workspaceRoot/missions.
  it("returns fail with default fix-hint when missions folder is absent (default path)", () => {
    const missing = path.join(dir, "missions");
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: missing });
    expect(result.status).toBe("fail");
    expect(result.fixHint).toContain("rig config init-workspace");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });

  // Discriminator-flip: when operator overrode slicesRoot, fix-hint
  // should NOT recommend running init-workspace (that creates the
  // default missions/ in the workspace root, not the custom path).
  it("returns fail with custom-path fix-hint when overridden slicesRoot is absent", () => {
    const custom = path.join(dir, "custom-elsewhere");
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: custom });
    expect(result.status).toBe("fail");
    expect(result.fixHint).toContain("unset workspace.slices_root");
    expect(result.fixHint).not.toContain("rig config init-workspace");
  });

  // Discriminator-flip: file-at-missions-path. Without isDirectory()
  // gate the check would falsely return ok.
  it("returns fail when missions path is a regular file", () => {
    const filePath = path.join(dir, "missions");
    fs.writeFileSync(filePath, "");
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: filePath });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a directory");
    expect(result.evidence?.kind).toBe("not_a_directory");
  });
});

describe("FR-5 check #3 — file allowlist sane", () => {
  it("returns ok when allowlist has at least one entry covering workspace root", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: `workspace:${dir}`,
      allowlistSource: "default",
    });
    expect(result.check).toBe("file_allowlist_sane");
    expect(result.status).toBe("ok");
    expect(result.evidence?.entryCount).toBe(1);
  });

  // Discriminator-flip: empty value must fail; without the entries.
  // length === 0 check it would pass through to coverage logic.
  it("returns fail with explicit fix-hint when allowlist is empty", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "",
      allowlistSource: "default",
    });
    expect(result.status).toBe("fail");
    expect(result.fixHint).toContain("OPENRIG_FILES_ALLOWLIST");
    expect(result.fixHint).toContain("rig config set");
    expect(result.evidence?.entryCount).toBe(0);
  });

  // Discriminator-flip: unparseable value (no colon) must fail. Without
  // the parseAllowlistPairs colon-required check, garbage would pass.
  it("returns fail when allowlist is malformed (no colon)", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "garbage-no-colon-here",
      allowlistSource: "env",
    });
    expect(result.status).toBe("fail");
    expect(result.evidence?.entryCount).toBe(0);
  });

  // Discriminator-flip: allowlist with valid entries but NONE covering
  // workspace must warn (not ok, not fail). Without the covers check
  // it would falsely return ok.
  it("returns warn when allowlist entries are valid but none cover the workspace root", () => {
    const elsewhere = path.join(dir, "elsewhere-1");
    fs.mkdirSync(elsewhere);
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: `other:${elsewhere}`,
      allowlistSource: "file",
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("none cover workspace root");
    expect(result.fixHint).toContain("workspace:");
    expect(result.evidence?.entryCount).toBe(1);
  });

  // Sub-directory coverage discriminator: an allowlist entry that is
  // an ANCESTOR of the workspace root SHOULD cover it.
  it("returns ok when an allowlist entry is an ancestor of the workspace root", () => {
    const sub = path.join(dir, "deep-sub");
    fs.mkdirSync(sub);
    const result = checkFileAllowlist({
      workspaceRoot: sub,
      allowlistValue: `parent:${dir}`,
      allowlistSource: "env",
    });
    expect(result.status).toBe("ok");
  });

  // Pre-decoded entries path: pre-parsed entries should bypass the
  // canonical decoder and be honored verbatim. Discriminator: pass an
  // entry shape that the decoder couldn't have produced.
  it("uses pre-decoded entries when provided", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "raw-value-different-from-entries",
      allowlistSource: "default",
      parsedEntries: [{ name: "ws", path: fs.realpathSync(dir) }],
    });
    expect(result.status).toBe("ok");
    expect(result.evidence?.entryCount).toBe(1);
  });

  // GUARD BLOCKER-1 discriminator (qitem-20260602041334-55985aa9):
  // a relative path like `workspace:.` must NOT silently resolve into
  // process.cwd() and return ok. The shipped file API's decodeAllowlist
  // silently drops non-absolute paths at path-safety.ts:71; the doctor
  // must mirror that or it lies about the workspace being read-ready.
  it("returns fail when allowlist contains only relative paths (mirrors shipped file API drop)", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "workspace:.",
      allowlistSource: "file",
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("no usable entries");
    expect(result.fixHint).toContain("absolute paths only");
    expect(result.evidence?.entryCount).toBe(0);
  });

  it("returns fail when allowlist mixes a relative-only entry without absolute fallback", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "workspace:relative/path/here",
      allowlistSource: "env",
    });
    expect(result.status).toBe("fail");
    expect(result.evidence?.entryCount).toBe(0);
  });

  // Positive-guard discriminator: a malformed relative entry should
  // be dropped but a valid absolute companion should still produce ok.
  // This protects against an over-eager fix where relative-presence
  // causes the whole check to fail.
  it("returns ok when allowlist mixes relative (dropped) with absolute (kept) entries covering root", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: `bad:./relative,workspace:${dir}`,
      allowlistSource: "env",
    });
    expect(result.status).toBe("ok");
    expect(result.evidence?.entryCount).toBe(1);
  });
});

describe("FR-5 check #4 — daemon points at this workspace", () => {
  it("returns ok when daemon and caller agree on workspace root", () => {
    const result = checkDaemonWorkspace({ daemonResolvedRoot: dir, expectedRoot: dir });
    expect(result.check).toBe("daemon_points_at_this_workspace");
    expect(result.status).toBe("ok");
  });

  // Discriminator-flip: differing paths must fail. Without the
  // string comparison the check would falsely return ok.
  it("returns fail when daemon resolved a different workspace root", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-other-"));
    try {
      const result = checkDaemonWorkspace({
        daemonResolvedRoot: otherDir,
        expectedRoot: dir,
      });
      expect(result.status).toBe("fail");
      expect(result.message).toContain(otherDir);
      expect(result.message).toContain(dir);
      expect(result.fixHint).toContain("rig daemon restart");
      expect(result.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  // Discriminator-flip: path.resolve normalization. A daemon path
  // with redundant `./` segments equal to expected should still
  // compare equal post-normalization.
  it("normalizes paths before comparing", () => {
    const result = checkDaemonWorkspace({
      daemonResolvedRoot: path.join(dir, ".", "sub", ".."),
      expectedRoot: dir,
    });
    expect(result.status).toBe("ok");
  });
});

describe("FR-5 check #5 — daemon reload needed", () => {
  it("returns ok when config file is older than daemon start", () => {
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, "{}");
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(cfg, oldMtime, oldMtime);
    const start = new Date(Date.now() - 5_000);
    const result = checkDaemonReload({ configFilePath: cfg, daemonStartTime: start });
    expect(result.check).toBe("daemon_reload_needed");
    expect(result.status).toBe("ok");
  });

  // Discriminator-flip: config newer than daemon start MUST warn.
  // Without the mtimeMs > startMs comparison, freshness would never trip.
  it("returns warn when config file mtime is newer than daemon start", () => {
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, "{}");
    const newMtime = new Date(Date.now());
    fs.utimesSync(cfg, newMtime, newMtime);
    const start = new Date(Date.now() - 60_000);
    const result = checkDaemonReload({ configFilePath: cfg, daemonStartTime: start });
    expect(result.status).toBe("warn");
    expect(result.fixHint).toContain("rig daemon restart");
    expect(result.evidence?.staleMs).toBeGreaterThan(0);
  });

  // Discriminator-flip: ENOENT must NOT fail or warn. A daemon
  // running on pure defaults (no config file) is healthy state.
  it("returns ok when config file does not exist (defaults-only daemon)", () => {
    const missing = path.join(dir, "no-such-config.json");
    const result = checkDaemonReload({
      configFilePath: missing,
      daemonStartTime: new Date(),
    });
    expect(result.status).toBe("ok");
    expect(result.evidence?.configFileExists).toBe(false);
  });
});

describe("FR-5 check #6 — optional slice docs", () => {
  it("returns ok when every slice has README, IMPLEMENTATION-PRD, or IMPL-PRD", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "s1"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m1", "slices", "s2"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "s1", "README.md"), "");
    fs.writeFileSync(path.join(missions, "m1", "slices", "s2", "IMPL-PRD.md"), "");
    const result = checkOptionalSliceDocs({ missionsRoot: missions });
    expect(result.check).toBe("optional_slice_docs");
    expect(result.status).toBe("ok");
    expect(result.evidence?.bareSlices).toEqual([]);
  });

  // Discriminator-flip: a slice with NEITHER doc shape must warn.
  // Without the SLICE_DOC_FILES.some() check, bare slices would
  // silently pass.
  it("returns warn naming bare slices that have no doc shape", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "bare-slice"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m1", "slices", "ok-slice"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "ok-slice", "README.md"), "");
    const result = checkOptionalSliceDocs({ missionsRoot: missions });
    expect(result.status).toBe("warn");
    const bare = result.evidence?.bareSlices as Array<{ mission: string; slice: string }>;
    expect(bare).toHaveLength(1);
    expect(bare[0]?.slice).toBe("bare-slice");
  });

  // Discriminator-flip: any of the 3 doc-file names should pass.
  it("treats IMPLEMENTATION-PRD.md as equivalent to README.md and IMPL-PRD.md", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "s1", "IMPLEMENTATION-PRD.md"), "");
    const result = checkOptionalSliceDocs({ missionsRoot: missions });
    expect(result.status).toBe("ok");
  });

  // Discriminator-flip: missing missions root must warn (not fail).
  // The check is warn-only per IMPL-PRD §57-59.
  it("returns warn (not fail) when missions root is absent", () => {
    const result = checkOptionalSliceDocs({ missionsRoot: path.join(dir, "no-missions") });
    expect(result.status).toBe("warn");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });
});

describe("FR-5 check #7 — MISSION_NOTES presence", () => {
  it("returns ok when every mission directory has MISSION_NOTES.md", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m2"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "MISSION_NOTES.md"), "");
    fs.writeFileSync(path.join(missions, "m2", "MISSION_NOTES.md"), "");
    const result = checkMissionNotesPresence({ missionsRoot: missions });
    expect(result.check).toBe("mission_notes_presence");
    expect(result.status).toBe("ok");
    expect(result.evidence?.missing).toEqual([]);
  });

  // Discriminator-flip: missing MISSION_NOTES must warn and name the
  // specific missions; without naming, operator can't act.
  it("returns warn naming missions without MISSION_NOTES.md", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "with-notes"), { recursive: true });
    fs.mkdirSync(path.join(missions, "no-notes-1"), { recursive: true });
    fs.mkdirSync(path.join(missions, "no-notes-2"), { recursive: true });
    fs.writeFileSync(path.join(missions, "with-notes", "MISSION_NOTES.md"), "");
    const result = checkMissionNotesPresence({ missionsRoot: missions });
    expect(result.status).toBe("warn");
    const missing = result.evidence?.missing as Array<{ mission: string }>;
    expect(missing.map((m) => m.mission).sort()).toEqual(["no-notes-1", "no-notes-2"]);
    expect(result.fixHint).toContain("rig scope mission create");
  });

  // Discriminator-flip: missions root absent should warn-only.
  it("returns warn (not fail) when missions root is absent", () => {
    const result = checkMissionNotesPresence({ missionsRoot: path.join(dir, "no-missions") });
    expect(result.status).toBe("warn");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });
});

describe("FR-5 runWorkspaceDoctor — orchestrator", () => {
  function scaffoldHealthyWorkspace(root: string): { missions: string; configPath: string } {
    const missions = path.join(root, "missions");
    fs.mkdirSync(missions);
    fs.mkdirSync(path.join(missions, "getting-started"));
    fs.writeFileSync(path.join(missions, "getting-started", "MISSION_NOTES.md"), "");
    fs.mkdirSync(path.join(missions, "getting-started", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(missions, "getting-started", "slices", "s1", "README.md"), "");
    const configPath = path.join(root, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(configPath, oldMtime, oldMtime);
    return { missions, configPath };
  }

  it("returns a 7-check report with summary counts on a healthy workspace", () => {
    const { missions, configPath } = scaffoldHealthyWorkspace(dir);
    const report = runWorkspaceDoctor({
      workspaceRoot: dir,
      workspaceRootSource: "env",
      slicesRoot: missions,
      allowlistValue: `workspace:${fs.realpathSync(dir)}`,
      allowlistSource: "default",
      daemonResolvedWorkspaceRoot: dir,
      configFilePath: configPath,
      daemonStartTime: new Date(Date.now() - 5_000),
    });
    expect(report.workspaceRoot).toBe(dir);
    expect(report.checks).toHaveLength(7);
    expect(report.checks.map((c) => c.check)).toEqual([
      "workspace_root_reachable",
      "missions_folder_present",
      "file_allowlist_sane",
      "daemon_points_at_this_workspace",
      "daemon_reload_needed",
      "optional_slice_docs",
      "mission_notes_presence",
    ]);
    expect(report.summary.ok).toBe(7);
    expect(report.summary.warn).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(typeof report.daemonResolvedAt).toBe("string");
    expect(report.daemonResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Discriminator-flip: the orchestrator must aggregate WARN status
  // when at least one check warns. Without the for-loop summary
  // tally, this would stay 0/0/0.
  it("aggregates warn count when a single check warns (mission notes missing)", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1"), { recursive: true });
    // intentionally no MISSION_NOTES.md
    const configPath = path.join(dir, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    fs.utimesSync(configPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const report = runWorkspaceDoctor({
      workspaceRoot: dir,
      workspaceRootSource: "env",
      slicesRoot: missions,
      allowlistValue: `workspace:${fs.realpathSync(dir)}`,
      allowlistSource: "default",
      daemonResolvedWorkspaceRoot: dir,
      configFilePath: configPath,
      daemonStartTime: new Date(Date.now() - 5_000),
    });
    expect(report.summary.warn).toBeGreaterThanOrEqual(1);
    const notes = report.checks.find((c) => c.check === "mission_notes_presence");
    expect(notes?.status).toBe("warn");
  });

  // Discriminator-flip: orchestrator must aggregate FAIL status when
  // at least one check fails. Routes check #1 fails when workspace
  // root is bogus.
  it("aggregates fail count when workspace root is unreachable", () => {
    const bogus = path.join(dir, "does-not-exist");
    const configPath = path.join(dir, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    fs.utimesSync(configPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const report = runWorkspaceDoctor({
      workspaceRoot: bogus,
      workspaceRootSource: "env",
      slicesRoot: path.join(bogus, "missions"),
      allowlistValue: `workspace:${fs.realpathSync(dir)}`,
      allowlistSource: "default",
      daemonResolvedWorkspaceRoot: bogus,
      configFilePath: configPath,
      daemonStartTime: new Date(Date.now() - 5_000),
    });
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
    const reachable = report.checks.find((c) => c.check === "workspace_root_reachable");
    expect(reachable?.status).toBe("fail");
  });

  // Discriminator-flip: check ordering is stable. The CLI human
  // formatter (FR-5d) groups by category in this order; a reordered
  // checks[] would break the formatter's category assumption.
  it("emits checks in the documented fixed order regardless of input timing", () => {
    const { missions, configPath } = scaffoldHealthyWorkspace(dir);
    const reports = Array.from({ length: 3 }, () =>
      runWorkspaceDoctor({
        workspaceRoot: dir,
        workspaceRootSource: "env",
        slicesRoot: missions,
        allowlistValue: `workspace:${fs.realpathSync(dir)}`,
        allowlistSource: "default",
        daemonResolvedWorkspaceRoot: dir,
        configFilePath: configPath,
        daemonStartTime: new Date(Date.now() - 5_000),
      }),
    );
    const fingerprints = reports.map((r) => r.checks.map((c) => c.check).join(","));
    expect(new Set(fingerprints).size).toBe(1);
  });
});
