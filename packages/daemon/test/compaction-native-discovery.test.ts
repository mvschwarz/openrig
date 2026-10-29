import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.platform === "win32")("discovers synthetic transcripts/docs and uses native temp without find on PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "compaction-native-用户 &-"));
  const script = resolve(import.meta.dirname, "../assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs");
  const hook = resolve(import.meta.dirname, "../assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/precompact-hook.mjs");
  const project = join(root, ".claude/projects/synthetic"); mkdirSync(project, { recursive: true });
  const transcript = join(project, "session.jsonl");
  writeFileSync(transcript, JSON.stringify({ sessionId: "synthetic", cwd: root, message: { role: "user", content: "Continue synthetic work." } }) + "\n");
  mkdirSync(join(root, "docs/as-built"), { recursive: true });
  const doc = join(root, "docs/as-built/architecture.md"); writeFileSync(doc, "# Synthetic architecture\n");
  const env = { ...process.env, PATH: "", HOME: root, USERPROFILE: root, TMP: root, TEMP: root, OPENRIG_HOME: join(root, "instance"), OPENRIG_SESSION_NAME: "synthetic@fixture", OPENRIG_COMPACTION_OUT_ROOT: "" };
  try {
    const result = spawnSync(process.execPath, [script, "--cwd", root, "--json"], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.jsonlPath).toBe(transcript);
    expect(dirname(packet.outputDir)).toBe(join(root, "claude-compaction-restore"));
    expect(readFileSync(join(packet.outputDir, "restore-instructions.md"), "utf8")).toContain(doc);
    const prepared = spawnSync(process.execPath, [hook], { env, encoding: "utf8", input: JSON.stringify({ cwd: root, transcript_path: transcript }) });
    expect(prepared.status, prepared.stderr).toBe(0);
    const marker = JSON.parse(readFileSync(join(root, "instance/compaction/restore-pending/synthetic@fixture.json"), "utf8"));
    expect(marker.outputDir.startsWith(join(root, "claude-compaction-restore"))).toBe(true);
    expect(JSON.parse(prepared.stdout).systemMessage).not.toContain("--out /tmp/");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
