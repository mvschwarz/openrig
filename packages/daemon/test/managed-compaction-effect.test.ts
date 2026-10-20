import { it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { ClaudeCompactionEnforcer, MANAGED_COMPACT_PREFIX } from "../src/domain/claude-compaction-enforcer.js";
import { submitStubInput, buildStubTranscript } from "../src/adapters/stub-runner.js";
import { fireCompaction } from "../src/adapters/stub-compaction.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";

// Modelling only Claude Code 2.1.282's recorded success at792 and paste refusal at850/851,
// not measuring a universal/native threshold. The CLI rejects runtime:stub, so this is the
// bounded adapter/helper fallback, not an installed rig compact or native compaction proof.
it.each([false, true])("managed compaction reaches the precompact effect (compact-as-paste=%s)", async planted => {
  const root = mkdtempSync(join(tmpdir(), "managed-effect-"));
  vi.stubEnv("OPENRIG_COMPACTION_OUT_ROOT", join(root, "packets"));
  vi.stubEnv("OPENRIG_SEAT_PROJECT_DIR", root);
  vi.stubEnv("CLAUDE_PROJECT_DIR", root);
  const session = "work-worker@compact-effect";
  const marker = join(root, "compaction/restore-pending", `${session}.json`);
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, buildStubTranscript({ steps: [{ kind: "say", text: "Retain this fixture's work" }] },
    { sessionName: session, sessionId: "fixture-session", cwd: root }));
  const mirrored: string[] = [], submitted: string[] = [];
  const seedHead = `/compact ${MANAGED_COMPACT_PREFIX} `;
  const inlineRegression = seedHead + "Retain the inline restore instructions. ".repeat(40);
  const longCommand = inlineRegression.slice(0, 851);
  expect(longCommand.length).toBe(851);
  const transport = {
    waitUntilIdle: async () => ({ ok: true, activity: { state: "idle" }, waitedMs: 0, attempts: 1 }),
    send: async (_session: string, text: string, opts?: { beforeWrite?: () => void }) => {
      opts?.beforeWrite?.();
      if (text.startsWith("/compact")) {
        const input = planted ? longCommand : text;
        submitted.push(input);
        submitStubInput(input, {
          mirrorLine: line => mirrored.push(line),
          fireCompaction: customInstructions => fireCompaction({
            hookScriptPath: resolve(import.meta.dirname, "../assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/precompact-hook.mjs"),
            sessionName: session, openrigHome: root, cwd: root, transcriptPath: transcript, customInstructions,
          }),
        }, 792);
      }
      return { ok: true };
    },
  } as unknown as SessionTransport;
  const settings = { resolveClaudeCompactionPolicy: () => ({ enabled: true, thresholdPercent: 80,
    preCompactInstruction: "", compactInstruction: "Preserve the scoped work. ".repeat(80), messageInline: "",
    messageFilePath: "", postRestoreAuditInstruction: "" }) } as unknown as SettingsStore;
  try {
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: root,
      resolveOccupantGeneration: () => "fixture-generation", manualPrepWaitMs: 30_000 });
    const result = await enforcer.triggerManualCompact({ sessionName: session, runtime: "claude-code", usedPercentage: 90,
      cwd: root, transcriptPath: transcript, sessionId: "fixture-session" }, { operatorInitiated: true, skipMap: true });
    // A submitted transport receipt alone is intentionally insufficient in BOTH legs.
    expect(result.triggered).toBe(true);
    expect(submitted).toHaveLength(1);
    const assertEffect = () => {
      expect(existsSync(marker), "precompact effect missing: submitted command did not run").toBe(true);
      const record = JSON.parse(readFileSync(marker, "utf8"));
      expect(record.managedRefocusPending).toBe(true);
      expect(record.sessionName).toBe(session);
    };
    if (planted) {
      expect(() => assertEffect()).toThrow("precompact effect missing");
      expect(mirrored).toEqual(["[Pasted text #1 +1 lines]"]);
      expect(existsSync(marker)).toBe(false);
    } else {
      expect(submitted[0]!.length).toBeLessThanOrEqual(600);
      assertEffect();
    }
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
