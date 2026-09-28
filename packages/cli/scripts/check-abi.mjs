#!/usr/bin/env node

// Postinstall native-SQLite check for @openrig/cli.
// OpenRig supports Node.js 22 and 24. better-sqlite3 13 requires Node 22 or
// newer; on Node 20 it installs and loads, then crashes (SIGSEGV) the first
// time a database is opened. This check refuses unsupported majors BEFORE any
// native code runs, then proves the binding can actually open a database.
// The open runs in a child process so a native crash is reported, not silent.

const SUPPORTED_MAJORS = [22, 24];

const box = (lines) =>
  [
    "",
    "  ╔══════════════════════════════════════════════════════════════╗",
    ...lines.map((line) => `  ║  ${line.padEnd(60)}║`),
    "  ╚══════════════════════════════════════════════════════════════╝",
    "",
  ].join("\n");

const FIX_INSTALL = "Fix:  nvm install 22 && npm install -g @openrig/cli";

/**
 * @param {{
 *   nodeVersion: string,
 *   loadNativeAddon: () => void,
 *   openNativeDatabase?: () => { ok: true } | { ok: false, detail: string },
 * }} deps
 * @returns {{ ok: true, warning?: string } | { ok: false, message: string }}
 */
export function checkAbi({ nodeVersion, loadNativeAddon, openNativeDatabase }) {
  // Phase 1: version-range check. Runs before any native code is loaded.
  const match = nodeVersion.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;

  if (major < SUPPORTED_MAJORS[0]) {
    return {
      ok: false,
      message: box([
        "@openrig/cli requires Node.js 22 or 24 (LTS).",
        `Current: ${nodeVersion}`,
        "",
        "Node 20 is no longer supported: the SQLite binding",
        "(better-sqlite3 13) crashes when it opens a database there.",
        "",
        FIX_INSTALL,
      ]),
    };
  }

  if (major % 2 !== 0) {
    return {
      ok: false,
      message: box([
        "@openrig/cli does not support odd-numbered Node releases.",
        `Current: ${nodeVersion}`,
        "",
        "Supported: Node.js 22 and 24 (LTS).",
        "",
        FIX_INSTALL,
      ]),
    };
  }

  // Even majors above the supported range are untested, not refused.
  const warning = SUPPORTED_MAJORS.includes(major)
    ? undefined
    : box([
        `Node ${major} is untested with @openrig/cli.`,
        `Current: ${nodeVersion}`,
        "",
        "Supported: Node.js 22 and 24 (LTS). The SQLite check below",
        "passed, but other behavior on this Node is unverified.",
      ]);

  // Phase 2: load the native addon (ABI / packaging / permission problems).
  try {
    loadNativeAddon();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isAbiMismatch = detail.includes("NODE_MODULE_VERSION");

    return {
      ok: false,
      message:
        box(
          isAbiMismatch
            ? [
                "better-sqlite3 native binary does not match this Node.",
                `Current: ${nodeVersion}`,
                "",
                "Fix:  npm rebuild better-sqlite3",
                " or:  nvm install 22 && npm install -g @openrig/cli",
              ]
            : [
                "better-sqlite3 native addon failed to load.",
                `Current: ${nodeVersion}`,
                "",
                "Fix:  npm rebuild better-sqlite3",
                "If that fails, reinstall with a supported Node version:",
                "      nvm install 22 && npm install -g @openrig/cli",
              ],
        ) + `  Detail: ${detail}\n`,
    };
  }

  // Phase 3: open an in-memory database. Loading alone does not prove the
  // binding works (Node 20 + better-sqlite3 13 loads, then segfaults here).
  if (openNativeDatabase) {
    const opened = openNativeDatabase();
    if (!opened.ok) {
      return {
        ok: false,
        message:
          box([
            "better-sqlite3 loaded but could not open a database.",
            `Current: ${nodeVersion}`,
            "",
            "Fix:  npm rebuild better-sqlite3",
            "If that fails, reinstall with Node 22 or 24:",
            "      nvm install 22 && npm install -g @openrig/cli",
          ]) + `  Detail: ${opened.detail}\n`,
      };
    }
  }

  return warning ? { ok: true, warning } : { ok: true };
}

/**
 * Open an in-memory database in a child process, so a native crash
 * (e.g. SIGSEGV) is observed as a signal instead of killing this script.
 * @param {string} addonPath absolute path resolved from this package
 */
export function openInChildProcess(addonPath, spawnSync) {
  const probe =
    `const Database = require(${JSON.stringify(addonPath)});` +
    `const db = new Database(":memory:");` +
    `db.prepare("select sqlite_version() as v").get();` +
    `db.close();`;
  const result = spawnSync(process.execPath, ["-e", probe], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.signal) return { ok: false, detail: `database open was killed by ${result.signal}` };
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim().split("\n").slice(-3).join(" ");
    return { ok: false, detail: `database open exited ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  return { ok: true };
}

// --- Run when executed as postinstall script ---
const isMain =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith("check-abi.mjs"));

if (isMain) {
  const { createRequire } = await import("node:module");
  const { spawnSync } = await import("node:child_process");
  const require = createRequire(import.meta.url);

  const result = checkAbi({
    nodeVersion: process.version,
    loadNativeAddon: () => require("better-sqlite3"),
    openNativeDatabase: () => openInChildProcess(require.resolve("better-sqlite3"), spawnSync),
  });

  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
  } else if (result.warning) {
    console.error(result.warning);
  }
}
