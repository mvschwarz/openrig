#!/usr/bin/env node

// Postinstall ABI sanity check for @openrig/cli.
// Fails loudly if better-sqlite3 native binary does not match the active
// Node runtime. Layered on top of the engines.node constraint in
// package.json — engines warns at npm level; this hard-blocks at install
// time with a copy-paste fix.

/**
 * @param {{ nodeVersion: string, loadNativeAddon: () => void }} deps
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkAbi({ nodeVersion, loadNativeAddon }) {
  // Phase 1: version-range check (fast path).
  // Even-numbered Node majors (20, 22, 24) are LTS lines with native addon
  // prebuilds. Odd-numbered majors (21, 23, 25) generally lack them.
  const match = nodeVersion.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;

  if (major < 20) {
    return {
      ok: false,
      message: [
        "",
        "  ╔══════════════════════════════════════════════════════════════╗",
        `  ║  @openrig/cli requires Node.js 20, 22, or 24 (LTS).       ║`,
        `  ║  Current: ${nodeVersion.padEnd(49)}║`,
        "  ║                                                            ║",
        "  ║  Fix:  nvm install 22 && npm install -g @openrig/cli       ║",
        "  ╚══════════════════════════════════════════════════════════════╝",
        "",
      ].join("\n"),
    };
  }

  if (major % 2 !== 0) {
    return {
      ok: false,
      message: [
        "",
        "  ╔══════════════════════════════════════════════════════════════╗",
        `  ║  @openrig/cli does not support odd-numbered Node releases.  ║`,
        `  ║  Current: ${nodeVersion.padEnd(49)}║`,
        "  ║                                                            ║",
        "  ║  Odd Node versions (21, 23, 25, …) lack native addon       ║",
        "  ║  prebuilds for better-sqlite3. The daemon will fail.       ║",
        "  ║                                                            ║",
        "  ║  Fix:  nvm install 22 && npm install -g @openrig/cli       ║",
        "  ╚══════════════════════════════════════════════════════════════╝",
        "",
      ].join("\n"),
    };
  }

  // Phase 2: ABI load check (catches edge cases like local Node builds
  // or prebuild packaging gaps on supported versions).
  try {
    loadNativeAddon();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: [
        "",
        "  ╔══════════════════════════════════════════════════════════════╗",
        "  ║  better-sqlite3 native binary does not match this Node.    ║",
        `  ║  Current: ${nodeVersion.padEnd(49)}║`,
        "  ║                                                            ║",
        "  ║  Fix:  npm rebuild better-sqlite3                          ║",
        "  ║   or:  nvm install 22 && npm install -g @openrig/cli       ║",
        "  ╚══════════════════════════════════════════════════════════════╝",
        "",
        `  Detail: ${detail}`,
        "",
      ].join("\n"),
    };
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
  const require = createRequire(import.meta.url);

  const result = checkAbi({
    nodeVersion: process.version,
    loadNativeAddon: () => require("better-sqlite3"),
  });

  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
  }
}
