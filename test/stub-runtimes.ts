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

/** True when a test run opted into the host's real runtimes (the existing E2E opt-in). */
export function realRuntimesRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env["OPENRIG_E2E_REAL_CODEX"] === "1";
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
  return dir;
}
