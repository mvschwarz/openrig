// Stub `codex` and `claude` binaries for the test PATH.
//
// Daemon startup probes `codex --version` (and bootstrap probes `claude --version`). A test that
// reaches the host's real binary under a fixture HOME can hang there: the ~/.local/bin/codex wrapper
// runs `mise use -g codex`, which never returns without the real home. On 2026-10-15 that left 102
// orphaned `codex --version` probes behind a test run.
//
// The stubs answer at once instead of leaving the lookup to fail: a missing binary would change what
// the runtime verifier records ("not found" instead of "verified"), and so what startup and bootstrap
// do. The Codex version is >= 0.130 so startup skips the `codex_hooks` feature-flag write.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const STUBS = {
  codex: {
    version: "codex-cli 0.139.0",
    // What a 0.139 host prints. probeCodexDaemonSupport needs the usage line and classifies the
    // --no-daemon option as "supported", so a Codex seat launch or resume behaves under the stub as on a real host.
    help: ["Usage: codex [OPTIONS] [PROMPT]", "", "Options:", "      --no-daemon", "  -h, --help"],
  },
  claude: {
    version: "2.1.0 (Claude Code)",
    help: ["Usage: claude [options] [prompt]", "", "Options:", "  -h, --help"],
  },
} as const;

const STUB_NAME = ".openrig-test-runtime-stubs";

function writeWindowsRuntimeStubs(dir: string): void {
  const source = `using System;
using System.IO;
public static class OpenRigTestRuntime {
  public static int Main(string[] args) {
    bool codex=Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).Equals("codex",StringComparison.OrdinalIgnoreCase);
    if(args.Length>0 && args[0]=="--version")Console.WriteLine(codex?${JSON.stringify(STUBS.codex.version)}:${JSON.stringify(STUBS.claude.version)});
    else if(args.Length>0 && args[0]=="--help")Console.Write(codex?${JSON.stringify(STUBS.codex.help.join("\n") + "\n")}:${JSON.stringify(STUBS.claude.help.join("\n") + "\n")});
    return 0;
  }
}`;
  const hash = createHash("sha256").update(source).digest("hex");
  const stamp = path.join(dir, ".native-source-sha256");
  const files = ["codex", "claude"].map(name => path.join(dir, `${name}.exe`));
  if (files.every(file => fs.existsSync(file)) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === hash) return;
  const temporary = path.join(dir, `.native-${randomUUID()}.exe`);
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'\nAdd-Type -TypeDefinition @'\n${source}\n'@ -OutputAssembly $env:OPENRIG_TEST_STUB_ASSEMBLY -OutputType ConsoleApplication`;
  try {
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, OPENRIG_TEST_STUB_ASSEMBLY: temporary }, windowsHide: true, timeout: 15_000, stdio: "pipe" });
    for (const file of files) fs.copyFileSync(temporary, file);
    fs.writeFileSync(stamp, hash);
  } finally { fs.rmSync(temporary, { force: true }); }
}

const REAL_CODEX_TESTS = [
  "seat-handover-model-fidelity-e2e.test.ts",
  "seat-lifecycle-set-model-resume-e2e.test.ts",
].map(name => fileURLToPath(new URL(`../packages/daemon/test/${name}`, import.meta.url)));

/** The opt-in permits native runtimes only in the two tests that exercise real Codex. */
export function realRuntimesRequested(
  env: Record<string, string | undefined> = process.env,
  testPath?: string,
): boolean {
  return env["OPENRIG_E2E_REAL_CODEX"] === "1" && testPath !== undefined
    && REAL_CODEX_TESTS.includes(path.resolve(testPath));
}

/**
 * Write `codex` and `claude` stubs into `<parent>/<stub dir>` and return that directory. A stub prints
 * a fixed version for `--version`, a usage text for `--help`, and exits 0 at once for any other arguments.
 * Idempotent.
 */
export function writeRuntimeStubs(parent: string): string {
  const dir = path.join(parent, STUB_NAME);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, { version, help }] of Object.entries(STUBS)) {
    fs.writeFileSync(
      path.join(dir, name),
      [
        "#!/bin/sh",
        `case "$1" in`,
        `  --version) echo '${version}' ;;`,
        `  --help) cat <<'HELP'`,
        ...help,
        "HELP",
        "  ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  // Native Windows lookup ignores extensionless Unix scripts. Missing or
  // failed preparation must abort setup, never fall through to a host provider.
  if (process.platform === "win32") writeWindowsRuntimeStubs(dir);
  return dir;
}
