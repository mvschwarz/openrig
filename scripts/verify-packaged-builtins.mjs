#!/usr/bin/env node
// OPR.0.4.8.3 — D5b compiled-package boundary probe (guard-sealed plan v2
// eea3c778). Repeatable by guard/QA. Proves, against an ASSEMBLED package:
//   1. package identity: assembled daemon AND cli build-info name the exact
//      candidate SHA with dirty === false (pass the SHA as argv[2]);
//   2. assembled policy bytes: daemon/policies/builtin/* equal the four
//      authority hashes;
//   3. the COMPILED assembled startup boundary: invoking the assembled
//      dist's exported createDaemon() (no listen) under a fresh temporary
//      OPENRIG_HOME + isolated state materializes EXACTLY the four stable
//      files at reference/policies/builtin/ — byte-equal, mode 0444.
// The probe NEVER touches the live daemon, its port, or the operator home.
//
// Usage: node scripts/verify-packaged-builtins.mjs <assembled-cli-dir> <expected-full-sha>
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AUTHORITY_SHA256 = {
  "locked.policy.md": "dcb38c372def7fe58ddfc9f1f3e97b9ba391ae79a99ef486e44f017cb39e57fe",
  "standard.policy.md": "737d3f56e6d8275fe548a3a06e9b02ede8f328207ec2e6223cea6a83f40f5148",
  "open.policy.md": "bb5fbb18e1f3706bd0676a9e709e29b5754bb6b41b6f304453dd6d73e7a4d62b",
  "yolo.policy.md": "ff1f21ef05a560d338b25fc035b548d12461429345230e2afe4855c0bb0f1217",
};

const [cliDir, expectedSha] = process.argv.slice(2);
if (!cliDir || !expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha)) {
  console.error("usage: verify-packaged-builtins.mjs <assembled-cli-dir> <expected-full-40-hex-sha>");
  process.exit(2);
}
const cli = resolve(cliDir);
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`ok: ${msg}`);

// ---- 1. package identity (guard finding 2) ----
for (const which of ["daemon/dist/build-info.js", "dist/build-info.js"]) {
  const info = await import(pathToFileURL(join(cli, which)).href);
  const record = info.BUILD_INFO ?? info.buildInfo ?? info.default ?? info;
  const commit = record.commit ?? record.sha ?? record.gitCommit;
  const dirty = record.dirty ?? record.isDirty;
  if (commit !== expectedSha) fail(`${which}: commit ${commit} !== candidate ${expectedSha}`);
  if (dirty !== false) fail(`${which}: dirty === ${JSON.stringify(dirty)} (expected false — built from a clean candidate)`);
  ok(`${which}: commit ${expectedSha.slice(0, 12)}… dirty=false`);
}

// ---- 2. assembled policy bytes ----
const assembledDir = join(cli, "daemon", "policies", "builtin");
const assembledFiles = readdirSync(assembledDir).sort();
const expectedFiles = Object.keys(AUTHORITY_SHA256).sort();
if (JSON.stringify(assembledFiles) !== JSON.stringify(expectedFiles))
  fail(`assembled inventory ${assembledFiles.join(",")} !== known four`);
for (const [file, hash] of Object.entries(AUTHORITY_SHA256))
  if (sha256(join(assembledDir, file)) !== hash) fail(`assembled ${file} diverged from authority`);
ok("assembled daemon/policies/builtin: exactly the known four, all authority hashes match");

// ---- 3. compiled assembled startup boundary (guard finding 1) ----
const home = mkdtempSync(join(tmpdir(), "builtins-probe-home-"));
const state = mkdtempSync(join(tmpdir(), "builtins-probe-state-"));
process.env.OPENRIG_HOME = home;
// QA finding (qitem 03a6194b): createDaemon() fires the background kernel
// bootstrap by default, which can create/replace tmux sessions on the SHARED
// server — the probe must deterministically opt out BEFORE importing the
// compiled startup, and PIN the skip so a regression fails loudly.
process.env.OPENRIG_NO_KERNEL = "1";
delete process.env.OPENRIG_URL;
delete process.env.OPENRIG_PORT;
try {
  const startup = await import(pathToFileURL(join(cli, "daemon", "dist", "startup.js")).href);
  if (typeof startup.createDaemon !== "function") fail("assembled dist/startup.js does not export createDaemon");
  // construct WITHOUT listening — isolated DB under the temp state dir; tee
  // stdout/stderr during construction to pin the kernel-boot SKIP
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...rest) => { chunks.push(String(c)); return origOut(c, ...rest); };
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return origErr(c, ...rest); };
  let daemon;
  try {
    daemon = await startup.createDaemon({ dbPath: join(state, "probe.db") });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const bootLog = chunks.join("");
  if (!bootLog.includes("skipping kernel auto-boot"))
    fail("kernel auto-boot skip NOT observed — the probe must never start the background kernel bootstrap");
  if (bootLog.includes("kernel-boot: booting"))
    fail("kernel-boot attempted to BOOT during the probe — shared tmux was at risk");
  ok("kernel auto-boot deterministically SKIPPED (OPENRIG_NO_KERNEL=1 pinned in probe output)");
  const refDir = join(home, "reference", "policies", "builtin");
  const files = readdirSync(refDir).sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
    fail(`materialized inventory [${files.join(",")}] !== known four`);
  for (const [file, hash] of Object.entries(AUTHORITY_SHA256)) {
    const p = join(refDir, file);
    if (sha256(p) !== hash) fail(`materialized ${file} not byte-identical to authority`);
    const mode = statSync(p).mode & 0o777;
    if (mode !== 0o444) fail(`materialized ${file} mode ${mode.toString(8)} !== 444`);
  }
  ok("compiled assembled startup materialized EXACTLY the four stable files — byte-identical, mode 0444");
  // best-effort dispose of constructed daemon resources (no server was bound)
  try { await daemon?.contextMonitor?.stop?.(); } catch { /* best-effort */ }
  try { daemon?.eventLoopMonitor?.stop?.(); } catch { /* best-effort */ }
  try { daemon?.db?.close?.(); } catch { /* best-effort */ }
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
console.log("PASS: packaged built-ins verified (identity + assembled bytes + compiled startup boundary)");
process.exit(0);
