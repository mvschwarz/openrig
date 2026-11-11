import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function prompt(home: string, conversationId: string, seat = session) {
  const transcript = join(home, `${conversationId}.jsonl`);
  writeFileSync(transcript, "{}\n");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: seat };
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

  it.each([["empty", ""], ["truncated", "{\"lastBytes\": 12"], ["not a record", "[]"]])("a %s current record reads unknown, never 'recorded', and doesn't date the history", (_kind, bytes) => {
    withHome((home) => {
      mkdirSync(join(home, "refocus"), { recursive: true });
      writeFileSync(join(home, "refocus", `${session}__${conversation}.json`), bytes);
      const record = readRefocusRecord(home, session, conversation);
      expect(record).toMatchObject({ currentConversation: "unknown", lastRecordedAt: "unknown" });
      expect(record.detail).toContain("can't be read");
    });
  });

  it.skipIf(process.getuid?.() === 0)("an earlier record that can't be read makes the history unknown, never 'no record' or an older time (root bypasses mode 000)", () => {
    withHome((home) => {
      // Alone: an unreadable earlier record, and the seat now has another conversation (or no resume token).
      prompt(home, "earlier");
      const earlier = join(home, "refocus", `${session}__earlier.json`);
      chmodSync(earlier, 0o000);
      try {
        for (const token of ["now", null]) {
          const record = readRefocusRecord(home, session, token);
          expect(record.lastRecordedAt).toBe("unknown");
          expect(record.detail).toContain("can't be read (EACCES)");
        }
        // Beside a readable older record: the readable one isn't passed off as the last.
        prompt(home, "oldest");
        expect(readRefocusRecord(home, session, "now").lastRecordedAt).toBe("unknown");
        expect(readRefocusRecord(home, session, "oldest").currentConversation).toBe(true);
      } finally { chmodSync(earlier, 0o644); }
    });
  });

  it.skipIf(process.getuid?.() === 0)("a state folder that can't be read reads unknown, not 'no record' (root bypasses mode 000)", () => {
    withHome((home) => {
      prompt(home, conversation);
      const dir = join(home, "refocus");
      chmodSync(dir, 0o000);
      try {
        const record = readRefocusRecord(home, session, conversation);
        expect(record).toMatchObject({ lastRecordedAt: "unknown", currentConversation: "unknown" });
        expect(record.detail).toContain("couldn't be read (EACCES)");
      } finally { chmodSync(dir, 0o755); }
    });
  });

  it("a seat whose name extends this one's never supplies this seat's history", () => {
    withHome((home) => {
      prompt(home, conversation, "sample@rig__other");
      expect(readRefocusRecord(home, "sample@rig__other", conversation)).toMatchObject({ currentConversation: true });
      const record = readRefocusRecord(home, "sample@rig", "its-own-conversation");
      expect(record).toMatchObject({ lastRecordedAt: "unknown", currentConversation: false });
      expect(record.detail).toContain("may belong to another seat");
      // Once this seat has its own record, its current conversation is still exact.
      prompt(home, "its-own-conversation", "sample@rig");
      expect(readRefocusRecord(home, "sample@rig", "its-own-conversation")).toMatchObject({ currentConversation: true });
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
