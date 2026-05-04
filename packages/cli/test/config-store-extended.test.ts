// User Settings v0 — extended ConfigStore + init-workspace tests.
//
// Pins the load-bearing behaviors of the v0 extension:
//   - new keys parse + validate; legacy 5 keys' behavior preserved
//   - per-subdir override resolution (workspace.root / per-subdir overrides / default)
//   - env > file > default precedence for new keys
//   - UEP env-var graduation: OPENRIG_FILES_ALLOWLIST + OPENRIG_PROGRESS_SCAN_ROOTS still work
//   - reset(key) clears one key; bare reset deletes the file
//   - parseNamedPairs decodes the named-pair format
//   - init-workspace creates 5 subdirs + READMEs + STEERING placeholder; idempotent

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigStore,
  VALID_KEYS,
  parseNamedPairs,
  deriveWorkspaceDefault,
} from "../src/config-store.js";
import { runInitWorkspace } from "../src/commands/config-init-workspace.js";

function clearEnv(): () => void {
  const keysToClear = [
    "OPENRIG_PORT", "OPENRIG_HOST", "OPENRIG_DB",
    "OPENRIG_TRANSCRIPTS_ENABLED", "OPENRIG_TRANSCRIPTS_PATH",
    "OPENRIG_WORKSPACE_ROOT", "OPENRIG_WORKSPACE_SLICES_ROOT",
    "OPENRIG_WORKSPACE_STEERING_PATH", "OPENRIG_WORKSPACE_FIELD_NOTES_ROOT",
    "OPENRIG_WORKSPACE_SPECS_ROOT",
    "OPENRIG_FILES_ALLOWLIST", "OPENRIG_PROGRESS_SCAN_ROOTS",
    "RIGGED_PORT", "RIGGED_HOST", "RIGGED_DB",
    "RIGGED_TRANSCRIPTS_ENABLED", "RIGGED_TRANSCRIPTS_PATH",
    "RIGGED_WORKSPACE_ROOT", "RIGGED_WORKSPACE_SLICES_ROOT",
    "RIGGED_FILES_ALLOWLIST", "RIGGED_PROGRESS_SCAN_ROOTS",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keysToClear) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keysToClear) {
      if (saved[k] !== undefined) process.env[k] = saved[k]!;
      else delete process.env[k];
    }
  };
}

describe("ConfigStore — extended namespaces (User Settings v0)", () => {
  let tmpDir: string;
  let configPath: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-store-ext-"));
    configPath = join(tmpDir, "config.json");
    restoreEnv = clearEnv();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("VALID_KEYS includes the 5 legacy + 7 user-settings + 3 PL-018 ui.preview.* keys", () => {
    const expected = [
      "daemon.port", "daemon.host", "db.path",
      "transcripts.enabled", "transcripts.path",
      "workspace.root", "workspace.slices_root", "workspace.steering_path",
      "workspace.field_notes_root", "workspace.specs_root",
      "files.allowlist", "progress.scan_roots",
      "ui.preview.refresh_interval_seconds", "ui.preview.max_pins", "ui.preview.default_lines",
    ];
    expect([...VALID_KEYS]).toEqual(expected);
  });

  it("legacy 5-key behavior preserved: get/set/reset still work", () => {
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "9999");
    expect(store.get("daemon.port")).toBe(9999);
    store.set("transcripts.enabled", "false");
    expect(store.get("transcripts.enabled")).toBe(false);
    store.reset("daemon.port");
    expect(store.get("daemon.port")).toBe(7433);
  });

  it("workspace.root default is ~/.openrig/workspace; per-subdir defaults derive from it", () => {
    const store = new ConfigStore(configPath);
    const cfg = store.resolve();
    expect(cfg.workspace.root).toMatch(/\.openrig[\/\\]workspace$/);
    expect(cfg.workspace.slicesRoot).toBe(join(cfg.workspace.root, "slices"));
    expect(cfg.workspace.steeringPath).toBe(join(cfg.workspace.root, "steering", "STEERING.md"));
    expect(cfg.workspace.fieldNotesRoot).toBe(join(cfg.workspace.root, "field-notes"));
    expect(cfg.workspace.specsRoot).toBe(join(cfg.workspace.root, "specs"));
  });

  it("setting workspace.root cascades into per-subdir defaults", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/custom/ws");
    const cfg = store.resolve();
    expect(cfg.workspace.root).toBe("/custom/ws");
    expect(cfg.workspace.slicesRoot).toBe("/custom/ws/slices");
    expect(cfg.workspace.steeringPath).toBe("/custom/ws/steering/STEERING.md");
  });

  it("per-subdir override beats workspace.root cascade", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/ws");
    store.set("workspace.slices_root", "/founder/slices");
    const cfg = store.resolve();
    // workspace.root cascade applies to OTHER subdirs:
    expect(cfg.workspace.fieldNotesRoot).toBe("/ws/field-notes");
    // per-subdir override wins:
    expect(cfg.workspace.slicesRoot).toBe("/founder/slices");
  });

  it("env > file > default for new keys", () => {
    const store = new ConfigStore(configPath);
    // No file → default
    expect(store.resolveWithSource("workspace.slices_root").source).toBe("default");

    // File set → file source
    store.set("workspace.slices_root", "/from/file");
    expect(store.resolveWithSource("workspace.slices_root").value).toBe("/from/file");
    expect(store.resolveWithSource("workspace.slices_root").source).toBe("file");

    // Env set → env source
    process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = "/from/env";
    try {
      const r = store.resolveWithSource("workspace.slices_root");
      expect(r.value).toBe("/from/env");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    }
  });

  it("UEP env-var graduation: OPENRIG_FILES_ALLOWLIST is the env override for files.allowlist", () => {
    const store = new ConfigStore(configPath);
    process.env["OPENRIG_FILES_ALLOWLIST"] = "ws:/Users/me,docs:/var/docs";
    try {
      const r = store.resolveWithSource("files.allowlist");
      expect(r.value).toBe("ws:/Users/me,docs:/var/docs");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_FILES_ALLOWLIST"];
    }
  });

  it("UEP env-var graduation: OPENRIG_PROGRESS_SCAN_ROOTS is the env override for progress.scan_roots", () => {
    const store = new ConfigStore(configPath);
    process.env["OPENRIG_PROGRESS_SCAN_ROOTS"] = "main:/code/main";
    try {
      const r = store.resolveWithSource("progress.scan_roots");
      expect(r.value).toBe("main:/code/main");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_PROGRESS_SCAN_ROOTS"];
    }
  });

  it("legacy RIGGED_FILES_ALLOWLIST falls back when OPENRIG_* is unset", () => {
    const store = new ConfigStore(configPath);
    process.env["RIGGED_FILES_ALLOWLIST"] = "legacy:/old/path";
    try {
      expect(store.get("files.allowlist")).toBe("legacy:/old/path");
    } finally {
      delete process.env["RIGGED_FILES_ALLOWLIST"];
    }
  });

  it("set rejects unknown keys with hint listing valid keys", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("workspace.bogus", "x")).toThrow(/Unknown config key/);
    expect(() => store.set("workspace.bogus", "x")).toThrow(/workspace\.root/);
  });

  it("get rejects unknown keys", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.get("nope.doesnt.exist")).toThrow(/Unknown config key/);
  });

  it("reset(key) clears just one key; reset() deletes whole file", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/ws");
    store.set("workspace.slices_root", "/ws/slices-custom");
    store.reset("workspace.slices_root");
    expect(store.resolveWithSource("workspace.slices_root").source).toBe("default");
    expect(store.resolveWithSource("workspace.root").source).toBe("file");

    store.reset();
    expect(existsSync(configPath)).toBe(false);
  });

  it("resolveAllWithSource returns every valid key with source + default", () => {
    const store = new ConfigStore(configPath);
    const all = store.resolveAllWithSource();
    for (const key of VALID_KEYS) {
      expect(all[key]).toBeDefined();
      expect(all[key].source).toBeDefined();
    }
  });

  it("malformed config.json throws with reset hint (preserves legacy behavior)", () => {
    writeFileSync(configPath, "{not-json");
    const store = new ConfigStore(configPath);
    expect(() => store.resolve()).toThrow(/malformed/i);
    expect(() => store.resolve()).toThrow(/reset/i);
  });

  // --- Preview Terminal v0 (PL-018) keys ---
  it("ui.preview.refresh_interval_seconds defaults to 3", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("ui.preview.refresh_interval_seconds")).toBe(3);
  });

  it("ui.preview.max_pins defaults to 4", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("ui.preview.max_pins")).toBe(4);
  });

  it("ui.preview.default_lines defaults to 50", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("ui.preview.default_lines")).toBe(50);
  });

  it("ui.preview.* keys coerce numeric values from set", () => {
    const store = new ConfigStore(configPath);
    store.set("ui.preview.refresh_interval_seconds", "5");
    store.set("ui.preview.max_pins", "2");
    store.set("ui.preview.default_lines", "100");
    expect(store.get("ui.preview.refresh_interval_seconds")).toBe(5);
    expect(store.get("ui.preview.max_pins")).toBe(2);
    expect(store.get("ui.preview.default_lines")).toBe(100);
  });

  it("ui.preview.* keys reject non-numeric values", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("ui.preview.refresh_interval_seconds", "soon")).toThrow(/expected a number/);
  });

  it("OPENRIG_UI_PREVIEW_* env vars override file values", () => {
    const store = new ConfigStore(configPath);
    store.set("ui.preview.refresh_interval_seconds", "5");
    process.env["OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS"] = "10";
    try {
      const r = store.resolveWithSource("ui.preview.refresh_interval_seconds");
      expect(r.value).toBe(10);
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS"];
    }
  });

  it("RiggedConfig.ui.preview shape exposed", () => {
    const store = new ConfigStore(configPath);
    const cfg = store.resolve();
    expect(cfg.ui.preview.refreshIntervalSeconds).toBe(3);
    expect(cfg.ui.preview.maxPins).toBe(4);
    expect(cfg.ui.preview.defaultLines).toBe(50);
  });
});

describe("parseNamedPairs", () => {
  it("returns empty array for empty/whitespace input", () => {
    expect(parseNamedPairs("")).toEqual([]);
    expect(parseNamedPairs("   ")).toEqual([]);
  });

  it("splits comma-separated name:path pairs", () => {
    const out = parseNamedPairs("ws:/abs/path,docs:/var/docs");
    expect(out).toEqual([
      { name: "ws", path: "/abs/path" },
      { name: "docs", path: "/var/docs" },
    ]);
  });

  it("skips entries without a colon", () => {
    expect(parseNamedPairs("just-name,ws:/path")).toEqual([{ name: "ws", path: "/path" }]);
  });

  it("trims whitespace around each pair + name + path", () => {
    expect(parseNamedPairs(" ws : /abs/path , docs:/var/docs ")).toEqual([
      { name: "ws", path: "/abs/path" },
      { name: "docs", path: "/var/docs" },
    ]);
  });

  it("dedupes by name (last wins)", () => {
    expect(parseNamedPairs("ws:/old,ws:/new")).toEqual([{ name: "ws", path: "/new" }]);
  });
});

describe("deriveWorkspaceDefault", () => {
  it("returns canonical subpaths under workspace root", () => {
    expect(deriveWorkspaceDefault("workspace.slices_root", "/ws")).toBe("/ws/slices");
    expect(deriveWorkspaceDefault("workspace.steering_path", "/ws")).toBe("/ws/steering/STEERING.md");
    expect(deriveWorkspaceDefault("workspace.field_notes_root", "/ws")).toBe("/ws/field-notes");
    expect(deriveWorkspaceDefault("workspace.specs_root", "/ws")).toBe("/ws/specs");
  });
});

describe("init-workspace runner", () => {
  let tmpDir: string;
  let configPath: string;
  let workspaceRoot: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "init-workspace-"));
    configPath = join(tmpDir, "config.json");
    workspaceRoot = join(tmpDir, "workspace");
    restoreEnv = clearEnv();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("--dry-run reports what would be created without writing anything", () => {
    const result = runInitWorkspace({ dryRun: true, root: workspaceRoot, configPath });
    expect(result.dryRun).toBe(true);
    expect(result.subdirs.map((s) => s.name)).toEqual([
      "slices", "steering", "progress", "field-notes", "specs",
    ]);
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("creates 5 subdirs + READMEs + STEERING placeholder", () => {
    const result = runInitWorkspace({ root: workspaceRoot, configPath });
    expect(result.dryRun).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(true);
    for (const sub of ["slices", "steering", "progress", "field-notes", "specs"]) {
      expect(existsSync(join(workspaceRoot, sub))).toBe(true);
      expect(existsSync(join(workspaceRoot, sub, "README.md"))).toBe(true);
    }
    const steeringMd = readFileSync(join(workspaceRoot, "steering", "STEERING.md"), "utf-8");
    expect(steeringMd).toContain("OpenRig Priority Stack");
  });

  it("is idempotent: running twice without --force is a no-op for existing files", () => {
    runInitWorkspace({ root: workspaceRoot, configPath });
    const sliceReadme = join(workspaceRoot, "slices", "README.md");
    writeFileSync(sliceReadme, "operator-edited content", "utf-8");

    const second = runInitWorkspace({ root: workspaceRoot, configPath });
    const sliceFile = second.files.find((f) => f.relPath === "slices/README.md");
    expect(sliceFile?.skipped).toBe("exists");
    expect(readFileSync(sliceReadme, "utf-8")).toBe("operator-edited content");
  });

  it("--force overwrites existing files but never deletes operator content under directories", () => {
    runInitWorkspace({ root: workspaceRoot, configPath });
    const operatorFile = join(workspaceRoot, "slices", "my-slice.md");
    writeFileSync(operatorFile, "my work", "utf-8");
    const operatorReadme = join(workspaceRoot, "slices", "README.md");
    writeFileSync(operatorReadme, "edited", "utf-8");

    runInitWorkspace({ root: workspaceRoot, force: true, configPath });
    // Operator file under the subdir survives
    expect(existsSync(operatorFile)).toBe(true);
    expect(readFileSync(operatorFile, "utf-8")).toBe("my work");
    // README is overwritten
    expect(readFileSync(operatorReadme, "utf-8")).toContain("# slices");
  });

  it("--root override beats configured workspace.root", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/should/not/be/used");
    const result = runInitWorkspace({ root: workspaceRoot, configPath });
    expect(result.root).toBe(workspaceRoot);
    expect(existsSync(workspaceRoot)).toBe(true);
  });

  it("reads workspace.root from settings when --root is not given", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", workspaceRoot);
    const result = runInitWorkspace({ configPath });
    expect(result.root).toBe(workspaceRoot);
    expect(existsSync(workspaceRoot)).toBe(true);
  });
});
