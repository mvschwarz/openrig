#!/usr/bin/env node
// The delivery suite's one entry point.
//
//   node run.mjs install --into <dir> [--claude 2.1.322,2.1.311] [--codex 0.167.2,0.167.1] [--openrig 0.7.12]
//     Pinned installs, one at a time, each into its own prefix under <dir>. Run this outside any cell: it needs the
//     package registry, and a cell has no network.
//
//   node run.mjs run --installs <dir> --openrig <version | path to rig's bin-wrapper.js> --out <dir>
//                    [--claude 2.1.322,2.1.311] [--codex 0.167.2,0.167.1] [--cases D01,D02,...] [--cell-timeout <seconds>]
//     Every case on every listed program version, one cell at a time, each cell in its own loopback-only namespace
//     with a fresh home, a stand-in model and a private daemon. Writes <out>/RESULT.json and RESULT.md, and a raw
//     bank per cell. A cell that can't run is NOT RUN with its reason, never skipped silently.
//
// Evidence level of every cell here: native-standin (the real program on a local stand-in model).

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** Every regular file under `dir`, as one digest of its sorted "path NUL sha256" lines. */
function treeDigest(dir) {
  const lines = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => join(d.parentPath ?? d.path, d.name)).sort()
    .map((path) => `${path.slice(dir.length + 1)}\0${sha256File(path)}\n`);
  return { files: lines.length, sha256: createHash("sha256").update(lines.join("")).digest("hex") };
}

/** The exact program a cell runs, read when the run starts, before any cell:
 *  - its version as it reports itself;
 *  - entryPointSha256: the file on PATH (a launcher for Codex and OpenRig, so this alone doesn't pin what runs);
 *  - payloads: every native executable in the install (Codex's vendored binary, Claude Code's native binary);
 *  - packageTree: a digest of the whole installed package;
 *  - lockfileIntegrity: npm's integrity for the package, written when it was installed. */
function pin(kind, entry) {
  const real = realpathSync(entry);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: "/nonexistent-delivery-suite", CODEX_HOME: "/nonexistent-delivery-suite/codex" };
  const version = spawnSync(kind === "openrig" ? process.execPath : real, kind === "openrig" ? [real, "--version"] : ["--version"], { encoding: "utf8", env, timeout: 30_000 });
  const out = { entry, real, entryPointSha256: sha256File(real), version: (version.stdout || version.stderr || "").trim().split("\n").at(-1), readAt: new Date().toISOString() };
  const prefix = real.includes("/node_modules/") ? real.split("/node_modules/")[0] : null;
  if (prefix) {
    const modules = join(prefix, "node_modules");
    const pkgName = PACKAGES[kind];
    const lock = existsSync(join(prefix, "package-lock.json")) ? JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")).packages ?? {} : {};
    out.lockfileIntegrity = Object.fromEntries(Object.entries(lock).filter(([k]) => k.startsWith(`node_modules/${pkgName}`)).map(([k, v]) => [k.slice("node_modules/".length), { version: v.version, integrity: v.integrity }]));
    out.packageTree = treeDigest(join(modules, pkgName));
    const scope = pkgName.split("/")[0];
    out.payloads = existsSync(join(modules, scope)) ? readdirSync(join(modules, scope), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile()).map((d) => join(d.parentPath ?? d.path, d.name))
      .filter((path) => { try { return readFileSync(path).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); } catch { return false; } })
      .map((path) => ({ path: path.slice(modules.length + 1), sha256: sha256File(path) })) : [];
  }
  return out;
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
  // One --out per run: a cell that dies before its verdict must never be credited with an earlier run's.
  if (existsSync(join(out, "RESULT.json")) || existsSync(join(out, "cells"))) throw new Error(`${out} already holds a run; give each run a new --out`);
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

  // Every program is pinned before the first cell runs.
  const programs = ["claude", "codex"].flatMap((kind) => list(opts[kind]).map((version) => {
    const entry = installs && installEntry(installs, kind, version);
    const programPin = entry && existsSync(entry) ? pin(kind, entry) : null;
    pins.programs[`${kind}-${version}`] = programPin ?? { missing: entry };
    return { kind, version, entry, programPin };
  }));

  // A stop (SIGTERM, SIGINT) is passed to the running cell, which closes itself; no further cell starts, and the
  // result written says the run was stopped.
  let stopped = null;
  const stop = (signal) => { stopped = signal; current?.kill("SIGTERM"); };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const cells = [];
  for (const { kind, version, entry, programPin } of programs) {
    for (const c of cases) {
      const cellId = `${c.id}-${kind}-${version}`;
      const base = { case: c.id, title: c.title, program: kind, version, level: LEVEL };
      if (stopped) { cells.push({ ...base, result: "NOT RUN", reason: `the run was stopped (${stopped})` }); continue; }
      if (!c.programs.includes(kind)) { cells.push({ ...base, result: "NOT RUN", reason: `${c.id} isn't defined for ${kind}` }); continue; }
      if (!programPin) { cells.push({ ...base, result: "NOT RUN", reason: `${kind} ${version} isn't installed (run.mjs install)` }); continue; }
      if (!containment.ok) { cells.push({ ...base, result: "NOT RUN", reason: `no loopback-only namespace: ${containment.reason}` }); continue; }
      console.log(`cell ${cellId} ...`);
      cells.push({ ...base, ...(await runCell({ cellId, out, caseId: c.id, kind, version, programEntry: entry, openrigEntry, realTmux: pins.host.tmuxPath,
        ...(opts["cell-timeout"] ? { timeoutMs: Number(opts["cell-timeout"]) * 1000 } : {}) })) });
      console.log(`cell ${cellId}: ${cells.at(-1).result}${cells.at(-1).reason ? ` (${cells.at(-1).reason})` : ""}`);
    }
  }
  const result = { generatedAt: new Date().toISOString(), ...(stopped ? { stopped } : {}), pins, cells };
  writeFileSync(join(out, "RESULT.json"), JSON.stringify(result, null, 1));
  writeFileSync(join(out, "RESULT.md"), resultMarkdown(result));
  console.log(`wrote ${join(out, "RESULT.json")} and RESULT.md`);
}

/** The cell process running now, so a stop can reach it. */
let current = null;

/** One cell in its own contained process (and its own process group, so a kill aimed at the runner doesn't cut a cell
 *  off mid-close), so a crash, a hang or a leak ends with it. The parent decides the outcome:
 *  - a timed-out cell is NOT RUN, whatever it wrote;
 *  - otherwise only a verdict this spawn wrote, and that parses, counts; anything else is NOT RUN;
 *  - whatever the cell left running is always reaped from here afterwards, and a cleanup that can't be done or
 *    confirmed marks the cell cleanupUncertain. */
function runCell({ cellId, out, caseId, kind, version, programEntry, openrigEntry, realTmux, timeoutMs = 15 * 60_000 }) {
  const dir = join(out, "cells", cellId);
  mkdirSync(dir, { recursive: true });
  const spawnId = randomBytes(8).toString("hex");
  const verdictPath = join(dir, "verdict.json");
  rmSync(verdictPath, { force: true });
  const spec = { dir, caseId, kind, version, programEntry, openrigEntry, realTmux, arm: cellId, spawnId };
  writeFileSync(join(dir, "cell-spec.json"), JSON.stringify(spec, null, 1));
  // node:sqlite reads the daemon's records; its experimental-feature notice isn't evidence.
  const argv = containedArgv([process.execPath, "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "cell", join(dir, "cell-spec.json")]);
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit"], detached: true, env: { PATH: "/usr/bin:/bin", USER: process.env.USER ?? "delivery" } });
    current = child;
    let timedOut = false;
    // On the timeout the cell gets SIGTERM and time to close itself normally; SIGKILL only if it doesn't.
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 120_000).unref(); }, timeoutMs);
    child.on("exit", async (code, signal) => {
      clearTimeout(timer);
      current = null;
      let outcome;
      try {
        if (timedOut) outcome = { result: "NOT RUN", reason: `the cell timed out after ${Math.round(timeoutMs / 1000)} s` };
        else {
          let written = null;
          try { written = existsSync(verdictPath) ? JSON.parse(readFileSync(verdictPath, "utf8")) : null; } catch { written = null; }
          outcome = written?.spawnId === spawnId ? written
            : { result: "NOT RUN", reason: `the cell process ended (${signal ?? `exit ${code}`}) without a readable verdict of its own` };
        }
      } finally {
        outcome ??= { result: "NOT RUN", reason: "the cell's outcome couldn't be read" };
        try {
          const identityPath = join(dir, "world", "identity.json");
          if (existsSync(identityPath)) {
            const { reapByIdentity } = await import("./harness/world.mjs");
            const reaped = await reapByIdentity(JSON.parse(readFileSync(identityPath, "utf8")));
            if (reaped.steps.length) outcome.parentReaped = reaped.steps;
            if (reaped.unresolved.length) {
              outcome = { ...outcome, resultBeforeDowngrade: outcome.result, result: "NOT RUN", cleanupUncertain: true, unresolved: reaped.unresolved,
                reason: `${outcome.reason ? `${outcome.reason}; ` : ""}the cell's processes couldn't all be stopped` };
            }
          }
        } catch (error) {
          outcome = { ...outcome, resultBeforeDowngrade: outcome.result, result: "NOT RUN", cleanupUncertain: true,
            reason: `${outcome.reason ? `${outcome.reason}; ` : ""}the cell's leftovers couldn't be reaped: ${String(error.message ?? error)}` };
        }
        done(outcome);
      }
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
  // Written whole or not at all: a reader never sees half a verdict.
  const write = (outcome) => {
    const temp = `${verdictPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...outcome, spawnId: spec.spawnId }, null, 1));
    renameSync(temp, verdictPath);
  };
  let stopping = false;
  let cell = null;
  let ctx = null;
  let outcome;
  // A timeout's SIGTERM: no verdict is credited, and the cell still stops what it started, within a bound.
  process.once("SIGTERM", async () => {
    // From here the normal path writes nothing: this NOT RUN is the cell's last word.
    stopping = true;
    write({ result: "NOT RUN", reason: "the cell was stopped (timeout or run stop)", partial: ctx?.verdict.toJSON() ?? null });
    if (cell) await Promise.race([closeCell(cell).catch(() => {}), new Promise((r) => setTimeout(r, 90_000))]);
    process.exit(0);
  });
  try {
    cell = await openCell({ dir: join(spec.dir, "world"), arm: spec.arm, program: { kind: spec.kind, bin: spec.programEntry }, openrig: spec.openrigEntry,
      realTmux: spec.realTmux, script: c.script(spec.kind), claudeSettings: c.claudeSettings ?? null });
  } catch (error) {
    outcome = { result: "NOT RUN", reason: `the seat didn't open: ${String(error.message ?? error).split("\n")[0]}`, detail: String(error.stack ?? error).slice(0, 4000) };
  }
  if (cell) {
    try {
      ctx = caseContext(cell, { caseId: c.id, kind: spec.kind, version: spec.version });
      await c.run(ctx);
      outcome = ctx.verdict.toJSON();
    } catch (error) {
      outcome = error?.notRun
        ? { ...(ctx?.verdict.toJSON() ?? {}), result: "NOT RUN", reason: error.message }
        : { ...(ctx?.verdict.toJSON() ?? {}), result: "FAIL", reason: `the case stopped on an error: ${String(error.message ?? error)}`, detail: String(error.stack ?? error).slice(0, 4000) };
    }
    if (ctx) {
      await ctx.screen.stop();
      if (ctx.screen.failures()) outcome.screenCaptureFailures = ctx.screen.failures();
    }
    // No credit without evidence the verdict can stand on.
    const notRun = (reason) => { outcome = { ...outcome, resultBeforeDowngrade: outcome.result, result: "NOT RUN", reason }; };
    const { conversation } = await import("./harness/oracle.mjs");
    const standInErrors = cell.standIn.errors();
    if (standInErrors.length) notRun(`the stand-in failed: ${standInErrors[0].message}`);
    else if (outcome.result !== "NOT RUN") {
      const seen = conversation(cell.standIn.requests());
      if (!seen.identified) notRun(`the seat's conversation couldn't be identified in the stand-in's log (threads carrying OpenRig's identity prompt: ${seen.anchored.length ? seen.anchored.join(", ") : "none"})`);
    }
    try {
      const manifest = bankCell(cell, join(spec.dir, "bank"), { "verdict.json": outcome });
      outcome.bank = { path: "bank", credentialScan: manifest.credentialScan, files: manifest.files.length };
      if (!manifest.credentialScan.clean) notRun("credential-shaped text found in the bank; read MANIFEST.json before sharing it");
    } catch (error) { outcome.bankError = String(error.message ?? error); notRun("the cell's evidence wasn't banked"); }
    try { await closeCell(cell); } catch (error) { outcome.closeError = String(error.message ?? error); }
    if (cell.unresolved?.length) outcome = { ...outcome, closeUnresolved: cell.unresolved };
  }
  if (!stopping) write(outcome);
}

function resultMarkdown({ generatedAt, pins, cells }) {
  const rows = cells.map((c) => `| ${c.case} | ${c.title} | ${c.program} ${c.version} | ${c.result} | ${c.level} | ${(c.reason ?? (c.failed?.length ? `failed: ${c.failed.join("; ")}` : "")).replaceAll("|", "\\|")} |`);
  const programs = Object.entries(pins.programs).map(([k, p]) => `- ${k}: ${p.version ?? "not installed"}${p.payloads?.length ? ` (native ${p.payloads.map((x) => x.sha256.slice(0, 16)).join(", ")}…)` : p.entryPointSha256 ? ` (entry point ${p.entryPointSha256.slice(0, 16)}…)` : ""}${p.packageTree ? `, package tree ${p.packageTree.sha256.slice(0, 16)}…` : ""}`);
  return [
    "# Delivery conformance: result",
    "",
    `Generated ${generatedAt}. Evidence level: ${LEVEL} (the real program on a local stand-in model).`,
    "",
    `- OpenRig: ${pins.openrig.version} (package tree ${pins.openrig.packageTree?.sha256.slice(0, 16) ?? "not read"}…, entry point ${pins.openrig.entryPointSha256.slice(0, 16)}…)`,
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
