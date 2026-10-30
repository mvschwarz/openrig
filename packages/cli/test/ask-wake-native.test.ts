import { expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWakeRunner, runWake } from "../src/ask-wake.js";

it.runIf(process.platform === "win32")("wakes owned npm provider fixtures through Node with literal resume arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "wake-native-用户 &-"));
  try {
    copyFileSync(process.execPath, join(root, "node.exe"));
    for (const runtime of ["codex", "claude"] as const) {
      const name = runtime === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
      const directory = join(root, "node_modules", ...name.split("/"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name, bin: { [runtime]: "entry.js" } }));
      writeFileSync(join(directory, "entry.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exitCode=0;");
      writeFileSync(join(root, runtime + ".cmd"), `@\"%_prog%\" \"%dp0%\\node_modules\\${name.replaceAll("/", "\\")}\\entry.js\" %*\r\n`);
    }
    vi.stubEnv("PATH", root); vi.stubEnv("PATHEXT", ".CMD");
    vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root);
    const token = "owned & %PATH% !token!", question = '用户 "literal" & %PATH%\r\nsecond';
    for (const runtime of ["codex", "claude"] as const) {
      const result = await runWake({ runner: defaultWakeRunner }, { runtime, token, question, timeoutMs: 5000 });
      expect(result).toMatchObject({ ran: true });
      expect(result.failed).toBeUndefined();
      expect(JSON.parse(result.answer!)).toEqual(runtime === "codex"
        ? ["exec", "resume", token, "Answer directly and concisely, with no preamble. Question: " + question]
        : ["-p", "--resume", token, "Answer directly and concisely, with no preamble. Question: " + question]);
    }
    writeFileSync(join(root, "codex.cmd"), "@echo unrelated launcher");
    const refused = await runWake({ runner: defaultWakeRunner }, { runtime: "codex", token, question });
    expect(refused).toMatchObject({ ran: true, failed: true });
    expect(refused.message).toContain("Unrecognized Windows codex shim");
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
