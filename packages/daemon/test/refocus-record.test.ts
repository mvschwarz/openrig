import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRefocusRecord } from "../src/domain/refocus-record.js";

const hook = join(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
const session = "editorial-lead@web-studio";
const conversation = "0f9c3b1e-5a7d-4c2e-9b8a-1d2e3f4a5b6c";

function withHome(run: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "refocus-record-"));
  try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** One prompt through the real hook script, as Claude's UserPromptSubmit would deliver it. */
function prompt(home: string, conversationId: string) {
  const transcript = join(home, `${conversationId}.jsonl`);
  writeFileSync(transcript, "{}\n");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: session };
  const result = spawnSync(process.execPath, [hook, "--runtime", "claude"], { env, encoding: "utf8", timeout: 20_000,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: conversationId, transcript_path: transcript, prompt: "hello" }) });
  expect(result.status).toBe(0);
}

describe("seat status reads what OpenRig's own refocus hook recorded", () => {
  it("finds the record the real hook writes, for the current conversation and not for another", () => {
    withHome((home) => {
      prompt(home, conversation);
      expect(readRefocusRecord(home, session, conversation)).toMatchObject({ currentConversation: true, detail: expect.stringContaining("current conversation") });
      const later = readRefocusRecord(home, session, "a-later-conversation");
      expect(later.currentConversation).toBe(false);
      expect(later.lastRecordedAt).toEqual(expect.any(String));
      expect(later.detail).toContain("not in its current conversation yet");
      // A conversation id the hook has to shorten and hash names the same file here (the copied keyFor).
      const long = `conversation-${"x".repeat(70)}`;
      prompt(home, long);
      expect(readRefocusRecord(home, session, long).currentConversation).toBe(true);
      // Another seat's record is never this seat's.
      expect(readRefocusRecord(home, "editorial-lead@web-studio2", conversation)).toMatchObject({ lastRecordedAt: null, currentConversation: false });
    });
  });

  it("with no record, says where the hook runs instead of reading as ready", () => {
    withHome((home) => {
      const record = readRefocusRecord(home, session, conversation);
      expect(record).toMatchObject({ lastRecordedAt: null, currentConversation: false });
      expect(record.detail).toContain("has no record for this seat");
      expect(record.detail).toContain("OPENRIG_SEAT_PROJECT_DIR");
    });
  });

  it("without a resume token it can't tell the conversation, and says so", () => {
    withHome((home) => {
      prompt(home, conversation);
      const record = readRefocusRecord(home, session, null);
      expect(record.currentConversation).toBe("unknown");
      expect(record.detail).toContain("no resume token");
    });
  });

  it("a hook running without a conversation identity is named, not counted as refocusing", () => {
    withHome((home) => {
      mkdirSync(join(home, "refocus"), { recursive: true });
      writeFileSync(join(home, "refocus", `${session}#no-identity-sentinel.json`), JSON.stringify({ activeEpisode: true, recordedAt: "2026-11-10T00:00:00Z" }));
      expect(readRefocusRecord(home, session, conversation)).toMatchObject({ noIdentity: true, detail: expect.stringContaining("no conversation identity") });
    });
  });
});
