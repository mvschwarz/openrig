import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { claudeAuthReaderEnv } from "../src/domain/provider/claude-auth-status-reader.js";
import { codexDaemonSupportProbe } from "../src/domain/codex-daemon-support.js";
import { codexNetworkDefaultReader } from "../src/domain/codex-network-default.js";
import { codexUsageReader } from "../src/domain/provider/codex-usage-reader.js";

it.runIf(process.platform === "win32")("an explicitly empty launch PATH never invokes a daemon-PATH provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-empty-path-"));
  const bin = join(root, "bin"), seat = join(root, "seat"); mkdirSync(seat);
  const pkg = join(bin, "node_modules/@openai/codex"), log = join(root, "starts.jsonl");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "fixture.cjs" } }));
  writeFileSync(join(bin, "codex.cmd"), String.raw`@"%dp0%\node_modules\@openai\codex\fixture.cjs"`);
  writeFileSync(join(pkg, "fixture.cjs"), `require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('Usage: codex [OPTIONS]\\n  --no-daemon');`);
  vi.stubEnv("PATH", bin + delimiter + dirname(process.execPath));
  try {
    const support = await codexDaemonSupportProbe("", 1000)(seat);
    const usage = await codexUsageReader({ launchPath: "", home: seat, deadlineMs: 1000, graceMs: 100 })();
    const network = await codexNetworkDefaultReader({ launchPath: "", home: seat, deadlineMs: 1000, graceMs: 100 })(seat);
    expect(support).toMatchObject({ kind: "unknown" });
    expect(usage).toMatchObject({ ok: false, reason: "binary_not_found" });
    expect(network).toMatchObject({ apply: false });
    expect(claudeAuthReaderEnv({ launchPath: "" }, { PATH: root }).PATH).toBe("");
    expect(existsSync(log)).toBe(false);
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
