#!/usr/bin/env node
// The delivery suite's one entry point.
//
//   node run.mjs install --into <dir> [--claude 2.1.322,2.1.311] [--codex 0.167.2,0.167.1] [--openrig 0.7.12]
//     Pinned installs, one at a time, each into its own prefix under <dir>. Run this outside any cell: it needs the
//     package registry, and a cell has no network.
//
//   node run.mjs run --installs <dir> --openrig <version | path to rig's bin-wrapper.js> --out <dir>
//                    [--claude 2.1.322,2.1.311] [--codex 0.167.2,0.167.1] [--cases D01,D02,...]
//     Every case on every listed program version, one cell at a time, each cell in its own loopback-only namespace
//     with a fresh home, a stand-in model and a private daemon. Writes <out>/RESULT.json and RESULT.md, and a raw
//     bank per cell. A cell that can't run is NOT RUN with its reason, never skipped silently.
//
// Evidence level of every cell here: native-standin (the real program on a local stand-in model).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containedArgv, probeContainment } from "./harness/contain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", openrig: "@openrig/cli" };
const LEVEL = "native-standin";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { const key = argv[i].slice(2); const next = argv[i + 1]; if (next === undefined || next.startsWith("--")) out[key] = true; else { out[key] = next; i++; } }
    else out._.push(argv[i]);
  }
  return out;
}
const list = (value) => (typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : []);
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Where a pinned install keeps its entry point. */
function installEntry(installs, kind, version) {
  const prefix = join(installs, `${kind}-${version}`);
  if (kind === "openrig") return join(prefix, "node_modules", "@openrig", "cli", "dist", "bin-wrapper.js");
  return join(prefix, "node_modules", ".bin", kind);
}

function install(opts) {
  const into = resolve(opts.into ?? "");
  if (!opts.into) throw new Error("install needs --into <dir>");
  mkdirSync(into, { recursive: true });
  for (const kind of ["claude", "codex", "openrig"]) {
    for (const version of list(opts[kind])) {
      const prefix = join(into, `${kind}-${version}`);
      if (existsSync(installEntry(into, kind, version))) { console.log(`have ${kind} ${version}`); continue; }
      console.log(`installing ${PACKAGES[kind]}@${version} into ${prefix}`);
      const r = spawnSync("npm", ["install", "--prefix", prefix, "--cache", join(into, "npm-cache"), "--logs-dir", join(into, "npm-logs"),
        "--no-audit", "--no-fund", "--no-save", `${PACKAGES[kind]}@${version}`], { stdio: "inherit" });
      if (r.status !== 0) throw new Error(`npm install ${PACKAGES[kind]}@${version} failed`);
    }
  }
}

/** The exact program a cell runs: its version as it reports it, and the bytes of what runs. */
function pin(kind, entry) {
  const real = realpathSync(entry);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: "/nonexistent-delivery-suite", CODEX_HOME: "/nonexistent-delivery-suite/codex" };
  const version = spawnSync(kind === "openrig" ? process.execPath : real, kind === "openrig" ? [real, "--version"] : ["--version"], { encoding: "utf8", env, timeout: 30_000 });
  return { entry, real, sha256: sha256File(real), version: (version.stdout || version.stderr || "").trim().split("\n").at(-1) };
}

function hostPins() {
  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  const osRelease = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1] : null;
  const tmuxPath = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  return { node: process.version, tmux: tmux.stdout.trim(), tmuxPath, os: osRelease, kernel: spawnSync("uname", ["-r"], { encoding: "utf8" }).stdout.trim() };
}

async function runSuite(opts) {
  const { CASES } = await import("./cases/index.mjs");
  if (!opts.out) throw new Error("run needs --out <dir>");
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const installs = opts.installs ? resolve(opts.installs) : null;
  const openrigEntry = existsSync(String(opts.openrig)) ? resolve(opts.openrig) : installs && installEntry(installs, "openrig", opts.openrig);
  if (!openrigEntry || !existsSync(openrigEntry)) throw new Error(`no OpenRig to test: pass --openrig <version installed under --installs> or a path to rig's bin-wrapper.js`);
  const wanted = list(opts.cases);
  const cases = wanted.length ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  for (const id of wanted) if (!CASES.some((c) => c.id === id)) throw new Error(`no case ${id} in this suite yet`);

  const expectedPath = join(HERE, "cases", "expected.yaml");
  const pins = { level: LEVEL, host: hostPins(), openrig: pin("openrig", openrigEntry), expected: { path: "cases/expected.yaml", sha256: sha256File(expectedPath) }, programs: {} };
  const containment = opts["no-contain"] ? { ok: false, reason: "--no-contain given" } : probeContainment();
  pins.containment = containment;

  const cells = [];
  for (const kind of ["claude", "codex"]) {
    for (const version of list(opts[kind])) {
      const entry = installs && installEntry(installs, kind, version);
      const programPin = entry && existsSync(entry) ? pin(kind, entry) : null;
      pins.programs[`${kind}-${version}`] = programPin ?? { missing: entry };
      for (const c of cases) {
        const cellId = `${c.id}-${kind}-${version}`;
        const base = { case: c.id, title: c.title, program: kind, version, level: LEVEL };
        if (!c.programs.includes(kind)) { cells.push({ ...base, result: "NOT RUN", reason: `${c.id} isn't defined for ${kind}` }); continue; }
        if (!programPin) { cells.push({ ...base, result: "NOT RUN", reason: `${kind} ${version} isn't installed (run.mjs install)` }); continue; }
        if (!containment.ok) { cells.push({ ...base, result: "NOT RUN", reason: `no loopback-only namespace: ${containment.reason}` }); continue; }
        console.log(`cell ${cellId} ...`);
        cells.push({ ...base, ...(await runCell({ cellId, out, caseId: c.id, kind, programEntry: entry, openrigEntry, realTmux: pins.host.tmuxPath })) });
        console.log(`cell ${cellId}: ${cells.at(-1).result}${cells.at(-1).reason ? ` (${cells.at(-1).reason})` : ""}`);
      }
    }
  }
  const result = { generatedAt: new Date().toISOString(), pins, cells };
  writeFileSync(join(out, "RESULT.json"), JSON.stringify(result, null, 1));
  writeFileSync(join(out, "RESULT.md"), resultMarkdown(result));
  console.log(`wrote ${join(out, "RESULT.json")} and RESULT.md`);
}

/** One cell in its own contained process, so a crash, a hang or a leak ends with it. */
function runCell({ cellId, out, caseId, kind, programEntry, openrigEntry, realTmux }) {
  const dir = join(out, "cells", cellId);
  mkdirSync(dir, { recursive: true });
  const spec = { dir, caseId, kind, programEntry, openrigEntry, realTmux, arm: cellId };
  writeFileSync(join(dir, "cell-spec.json"), JSON.stringify(spec, null, 1));
  // node:sqlite reads the daemon's records; its experimental-feature notice isn't evidence.
  const argv = containedArgv([process.execPath, "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "cell", join(dir, "cell-spec.json")]);
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit"], env: { PATH: "/usr/bin:/bin", USER: process.env.USER ?? "delivery" } });
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const verdictPath = join(dir, "verdict.json");
      if (existsSync(verdictPath)) return done(JSON.parse(readFileSync(verdictPath, "utf8")));
      done({ result: "NOT RUN", reason: `the cell process ended (${signal ?? `exit ${code}`}) before a verdict` });
    });
  });
}

/** Inside the namespace: open the world, run the case, bank everything, stop everything. */
async function cellMain(specPath) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const { CASES } = await import("./cases/index.mjs");
  const { openCell, closeCell } = await import("./harness/world.mjs");
  const { caseContext } = await import("./harness/case-context.mjs");
  const { bankCell } = await import("./harness/evidence.mjs");
  const c = CASES.find((x) => x.id === spec.caseId);
  const verdictPath = join(spec.dir, "verdict.json");
  let cell = null;
  let ctx = null;
  let outcome;
  try {
    cell = await openCell({ dir: join(spec.dir, "world"), arm: spec.arm, program: { kind: spec.kind, bin: spec.programEntry }, openrig: spec.openrigEntry,
      realTmux: spec.realTmux, script: c.script(spec.kind), claudeSettings: c.claudeSettings ?? null });
  } catch (error) {
    outcome = { result: "NOT RUN", reason: `the seat didn't open: ${String(error.message ?? error).split("\n")[0]}`, detail: String(error.stack ?? error).slice(0, 4000) };
  }
  if (cell) {
    try {
      ctx = caseContext(cell, { caseId: c.id, kind: spec.kind });
      await c.run(ctx);
      outcome = ctx.verdict.toJSON();
    } catch (error) {
      outcome = { ...(ctx?.verdict.toJSON() ?? {}), result: "FAIL", reason: `the case stopped on an error: ${String(error.message ?? error)}`, detail: String(error.stack ?? error).slice(0, 4000) };
    }
    if (ctx) await ctx.screen.stop();
    try {
      const manifest = bankCell(cell, join(spec.dir, "bank"), { "verdict.json": outcome });
      outcome.bank = { path: "bank", credentialScan: manifest.credentialScan, files: manifest.files.length };
      if (!manifest.credentialScan.clean) outcome.bankWarning = "credential-shaped text found in the bank; read MANIFEST.json before sharing it";
    } catch (error) { outcome.bankError = String(error.message ?? error); }
    try { await closeCell(cell); } catch (error) { outcome.closeError = String(error.message ?? error); }
  }
  writeFileSync(verdictPath, JSON.stringify(outcome, null, 1));
}

function resultMarkdown({ generatedAt, pins, cells }) {
  const rows = cells.map((c) => `| ${c.case} | ${c.title} | ${c.program} ${c.version} | ${c.result} | ${c.level} | ${(c.reason ?? (c.failed?.length ? `failed: ${c.failed.join("; ")}` : "")).replaceAll("|", "\\|")} |`);
  const programs = Object.entries(pins.programs).map(([k, p]) => `- ${k}: ${p.version ?? "not installed"}${p.sha256 ? ` (sha256 ${p.sha256.slice(0, 16)}…)` : ""}`);
  return [
    "# Delivery conformance: result",
    "",
    `Generated ${generatedAt}. Evidence level: ${LEVEL} (the real program on a local stand-in model).`,
    "",
    `- OpenRig: ${pins.openrig.version} (bin-wrapper sha256 ${pins.openrig.sha256.slice(0, 16)}…)`,
    ...programs,
    `- tmux ${pins.host.tmux}, node ${pins.host.node}, ${pins.host.os} (${pins.host.kernel})`,
    `- Expected results: ${pins.expected.path}, sha256 ${pins.expected.sha256}`,
    `- Containment: ${pins.containment.ok ? "loopback-only network namespace per cell" : `none (${pins.containment.reason})`}`,
    "",
    "| Case | Title | Program | Result | Level | Why |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "Each cell's checks, raw bank and MANIFEST.json (every file's sha256) are under cells/<case>-<program>-<version>/.",
    "",
  ].join("\n");
}

const [command, ...rest] = process.argv.slice(2);
const opts = args(rest);
if (command === "install") install(opts);
else if (command === "run") await runSuite(opts);
else if (command === "cell") await cellMain(opts._[0]);
else {
  console.error("usage: node run.mjs install --into <dir> [--claude v,v] [--codex v,v] [--openrig v]\n       node run.mjs run --installs <dir> --openrig <v|path> --out <dir> [--claude v,v] [--codex v,v] [--cases D01,...]");
  process.exitCode = 2;
}
