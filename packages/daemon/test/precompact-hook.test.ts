// Slice 27 — precompact-hook.mjs end-to-end tests.
//
// The hook ships as a static asset under
// `packages/daemon/assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/precompact-hook.mjs`
// and is invoked by Claude Code as a child process. These tests spawn the
// actual hook file with controlled stdin + an isolated OPENRIG_HOME so
// the on-disk behavior matches what Claude will observe at PreCompact
// time.
//
// Hard-gate coverage:
//   HG-6  inline message appended to systemMessage
//   HG-7  file-path message read + appended when inline is empty
//   HG-8  neither set → existing restore-instructions only (no custom append)
//   Inline wins when both set

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(
  HERE,
  "..",
  "assets",
  "plugins",
  "openrig-core",
  "skills",
  "claude-compaction-restore",
  "scripts",
  "precompact-hook.mjs",
);
const BRIDGE_SCRIPT = resolve(
  HERE,
  "..",
  "assets",
  "plugins",
  "openrig-core",
  "hooks",
  "scripts",
  "compaction-restore-bridge.cjs",
);
const APPEND_MARKER = "Operator-configured post-compaction restore instruction";

function runHook(openrigHome: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify({}),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRIG_HOME: openrigHome,
      OPENRIG_SESSION_NAME: "test-seat@kernel",
      // Ensure RIGGED_HOME doesn't pre-empt OPENRIG_HOME selection.
      RIGGED_HOME: undefined,
    } as NodeJS.ProcessEnv,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function runBridge(openrigHome: string, input: Record<string, unknown> = {
  hook_event_name: "UserPromptSubmit",
}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRIG_HOME: openrigHome,
      OPENRIG_SESSION_NAME: "test-seat@kernel",
      RIGGED_HOME: undefined,
    } as NodeJS.ProcessEnv,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function writePolicyConfig(home: string, policy: {
  enabled?: boolean;
  thresholdPercent?: number;
  compactInstruction?: string;
  messageInline?: string;
  messageFilePath?: string;
}): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      policies: {
        claudeCompaction: {
          enabled: policy.enabled ?? false,
          thresholdPercent: policy.thresholdPercent ?? 80,
          compactInstruction: policy.compactInstruction ?? "",
          messageInline: policy.messageInline ?? "",
          messageFilePath: policy.messageFilePath ?? "",
        },
      },
    }),
  );
}

function writePartialPolicyConfig(home: string, policy: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      policies: {
        claudeCompaction: policy,
      },
    }),
  );
}

describe("precompact-hook.mjs (slice 27 custom message append)", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "precompact-hook-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("HG-6: inline message is appended to systemMessage", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "Operator says hi — remember the migration step.",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Operator says hi — remember the migration step.");
  });

  it("writes a pending restore marker and bridge injects restore context once", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "Read the queue before resuming.",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.systemMessage).toContain("pending restore marker");

    const markerDir = join(openrigHome, "compaction", "restore-pending");
    const markerPath = join(markerDir, "test-seat@kernel.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker.outputDir).toMatch(/^\/tmp\/claude-compaction-restore\//);
    expect(marker.postCompactInstruction).toBe("Read the queue before resuming.");
    expect(marker.deliveryCount).toBe(0);

    const bridge = runBridge(openrigHome);
    expect(bridge.status).toBe(0);
    const bridgePayload = JSON.parse(bridge.stdout.trim());
    expect(bridgePayload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("OpenRig compaction restore is pending");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain(marker.outputDir);
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("Read the queue before resuming.");

    const delivered = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(delivered.deliveryCount).toBe(1);
    expect(delivered.deliveredAt).toBeTruthy();

    const secondBridge = runBridge(openrigHome);
    expect(secondBridge.status).toBe(0);
    expect(secondBridge.stdout).toBe("");
  });

  it("HG-7: file-path message is read + appended when inline is empty", () => {
    const messageFile = join(tmpDir, "msg.txt");
    writeFileSync(messageFile, "Read from disk on every compaction.");
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: messageFile,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Read from disk on every compaction.");
  });

  it("HG-7: file-path supports ${OPENRIG_HOME} expansion", () => {
    const messageDir = join(openrigHome, "instructions");
    mkdirSync(messageDir, { recursive: true });
    writeFileSync(join(messageDir, "restore.md"), "Read from OPENRIG_HOME-relative path.");
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: "${OPENRIG_HOME}/instructions/restore.md",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Read from OPENRIG_HOME-relative path.");
  });

  it("HG-8: neither inline nor file-path set → no custom append (existing restore-instructions preserved)", () => {
    writePolicyConfig(openrigHome, { messageInline: "", messageFilePath: "" });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Pre-compaction restore seed packet prepared");
  });

  it("uses the default restore instruction when compaction policy is enabled but restore text is not configured", () => {
    writePartialPolicyConfig(openrigHome, {
      enabled: true,
      thresholdPercent: 80,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("After compaction, restore continuity");
  });

  it("uses the shipped compaction instruction file when policy is enabled and no restore text is configured", () => {
    const defaultInstructionDir = join(
      openrigHome,
      "plugins",
      "openrig-core",
      "skills",
      "openrig-compaction-instructions",
    );
    mkdirSync(defaultInstructionDir, { recursive: true });
    writeFileSync(
      join(defaultInstructionDir, "COMPACTION.md"),
      "Read the default OpenRig compaction instruction file.",
    );
    writePartialPolicyConfig(openrigHome, {
      enabled: true,
      thresholdPercent: 80,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Read the default OpenRig compaction instruction file.");
  });

  it("inline wins when both are set", () => {
    const messageFile = join(tmpDir, "msg.txt");
    writeFileSync(messageFile, "FILE WINS NOT");
    writePolicyConfig(openrigHome, {
      messageInline: "INLINE WINS",
      messageFilePath: messageFile,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.systemMessage).toContain("INLINE WINS");
    expect(payload.systemMessage).not.toContain("FILE WINS NOT");
  });

  it("file-path with missing file degrades gracefully (no append, no error)", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: join(tmpDir, "no-such-file.txt"),
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Pre-compaction restore seed packet prepared");
  });

  it("missing config.json: hook still emits restore-instructions (graceful degrade)", () => {
    // No config written — OPENRIG_HOME directory may not even exist.
    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Pre-compaction restore seed packet prepared");
  });
});
