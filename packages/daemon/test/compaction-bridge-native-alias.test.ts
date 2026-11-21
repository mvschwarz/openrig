import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it.runIf(process.platform === "win32")("delivers an owned restore marker for the same transcript alias but preserves a different transcript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-alias-"));
  const alias = path.join(root, "alias");
  try {
    const transcripts = path.join(root, "transcripts"); fs.mkdirSync(transcripts);
    const transcript = path.join(transcripts, "owned.jsonl"), other = path.join(transcripts, "other.jsonl");
    fs.writeFileSync(transcript, "synthetic only\n"); fs.writeFileSync(other, "distinct\n");
    fs.symlinkSync(transcripts, alias, "junction");
    const home = path.join(root, "home"), markers = path.join(home, "compaction", "restore-pending");
    fs.mkdirSync(markers, { recursive: true });
    const marker = path.join(markers, "owned@fixture.json");
    const entry = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/compaction-restore-bridge.cjs");
    for (const [selected, delivered] of [[path.join(alias, "OWNED.jsonl"), true], [other, false]] as const) {
      fs.writeFileSync(marker, JSON.stringify({ sessionName: "owned@fixture", sessionId: "owned-session", transcriptPath: transcript, outputDir: root, deliveryCount: 0 }));
      const result = spawnSync(process.execPath, [entry], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5000,
        env: { SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: "owned@fixture" },
        input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "owned-session", transcript_path: selected }) });
      expect(result.status, result.stderr).toBe(0);
      expect(result.error).toBeUndefined();
      if (delivered) expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(root);
      else expect(result.stdout).toBe("");
      expect(JSON.parse(fs.readFileSync(marker, "utf8")).deliveryCount).toBe(delivered ? 1 : 0);
    }
  } finally { if (fs.existsSync(alias)) fs.unlinkSync(alias); fs.rmSync(root, { recursive: true, force: true }); }
});
