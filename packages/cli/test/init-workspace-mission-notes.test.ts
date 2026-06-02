// Slice-21 FR-5e A1 — `rig config init-workspace` scaffolds
// MISSION_NOTES.md for each seeded mission so a fresh baseline passes
// doctor check #7 (mission_notes_presence) without manual scope
// scaffolding.
//
// QA finding: fresh `rig config init-workspace` followed by `rig
// workspace doctor` produced summary {ok:6, warn:1, fail:0} because
// the FR-3 auto-scaffold only fired from `rig scope mission create`,
// not the init-workspace path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runInitWorkspace,
  workspaceScaffoldFiles,
} from "../src/commands/config-init-workspace.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5e-init-"));
  configPath = path.join(dir, "test-config.json");
  // Seed config with workspace.root pointing into our temp dir so
  // ConfigStore's resolveWithSource returns a known root.
  fs.writeFileSync(
    configPath,
    JSON.stringify({ workspace: { root: path.join(dir, "workspace") } }) + "\n",
    "utf-8",
  );
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("FR-5e A1 — init-workspace scaffolds MISSION_NOTES.md", () => {
  it("writes missions/getting-started/MISSION_NOTES.md alongside README + PROGRESS", () => {
    const result = runInitWorkspace({ configPath });
    const notesFile = result.files.find((f) =>
      f.relPath === "missions/getting-started/MISSION_NOTES.md");
    expect(notesFile).toBeDefined();
    expect(notesFile?.created).toBe(true);
    expect(fs.existsSync(notesFile!.absPath)).toBe(true);
    const content = fs.readFileSync(notesFile!.absPath, "utf-8");
    // Discriminator: the rendered template must have placeholder
    // substitutions applied. Without applyMissionNotesPlaceholders
    // the file would still contain `{{mission_id}}` etc.
    expect(content).not.toContain("{{mission_id}}");
    expect(content).not.toContain("{{mission_name}}");
    expect(content).not.toContain("{{created_date}}");
    // Discriminator: at minimum the rendered file should mention the
    // mission's display name from DEFAULT_MISSIONS.
    expect(content).toContain("Getting Started");
  });

  // Discriminator-flip: workspaceScaffoldFiles is the canonical
  // file-list used by both CLI init and daemon's
  // /api/config/init-workspace. Both surfaces need MISSION_NOTES so
  // the daemon-side init (UI Settings → init workspace) lands the
  // same scaffold.
  it("workspaceScaffoldFiles() emits a MISSION_NOTES.md entry per default mission", () => {
    const files = workspaceScaffoldFiles();
    const notesFiles = files.filter((f) => f.relPath.endsWith("/MISSION_NOTES.md"));
    // DEFAULT_MISSIONS has one mission (getting-started). When the
    // seed list grows, this discriminator catches the count drift.
    expect(notesFiles.length).toBeGreaterThanOrEqual(1);
    for (const f of notesFiles) {
      expect(f.content).not.toContain("{{mission_id}}");
      expect(f.content).not.toContain("{{mission_name}}");
      expect(f.content).not.toContain("{{created_date}}");
    }
  });

  // Discriminator-flip: dry-run should NOT write the MISSION_NOTES
  // file to disk but should report it as "would create".
  it("dry-run reports MISSION_NOTES.md without writing", () => {
    const result = runInitWorkspace({ configPath, dryRun: true });
    const notesFile = result.files.find((f) =>
      f.relPath === "missions/getting-started/MISSION_NOTES.md");
    expect(notesFile).toBeDefined();
    expect(notesFile?.created).toBe(true);
    expect(fs.existsSync(notesFile!.absPath)).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  // Discriminator-flip: idempotent re-run without --force does NOT
  // overwrite the existing MISSION_NOTES. Operators who hand-edit the
  // notes shouldn't lose work on a second init.
  it("re-run without --force skips existing MISSION_NOTES.md", () => {
    runInitWorkspace({ configPath });
    const notesPath = path.join(dir, "workspace", "missions", "getting-started", "MISSION_NOTES.md");
    fs.writeFileSync(notesPath, "operator hand-edited content", "utf-8");
    const result = runInitWorkspace({ configPath });
    const notesFile = result.files.find((f) =>
      f.relPath === "missions/getting-started/MISSION_NOTES.md");
    expect(notesFile?.created).toBe(false);
    expect(notesFile?.skipped).toBe("exists");
    expect(fs.readFileSync(notesPath, "utf-8")).toBe("operator hand-edited content");
  });

  // GUARD/FR-5e BLOCKER-1 discriminator
  // (qitem-20260602045638-1a6e964c): invalid
  // OPENRIG_MISSION_NOTES_TEMPLATE_PATH must fail BEFORE any
  // filesystem mutation. The previous (pre-fix) flow created
  // workspace root + subdirs first, then threw on render, leaving a
  // half-initialized workspace. With the verify-first-then-write
  // reorder, the throw fires before any mkdir.
  it("invalid OPENRIG_MISSION_NOTES_TEMPLATE_PATH fails BEFORE any filesystem mutation", () => {
    const wsRoot = path.join(dir, "leak-target-workspace");
    expect(fs.existsSync(wsRoot)).toBe(false);
    const original = process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
    process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = path.join(dir, "definitely-not-a-real-template.md");
    try {
      expect(() => runInitWorkspace({ root: wsRoot, configPath })).toThrow(
        /OPENRIG_MISSION_NOTES_TEMPLATE_PATH/,
      );
      // Mutation-target: if scaffoldFiles were called AFTER mkdir,
      // the workspace root would exist on disk. The fix asserts it
      // does NOT exist.
      expect(fs.existsSync(wsRoot)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
      else process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = original;
    }
  });
});
