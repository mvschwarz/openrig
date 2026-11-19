#!/usr/bin/env node
// Opt-in native wrapper. No cmd parsing, elevation, login, or implicit input.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { locateNpmCli } from "./npm-command.mjs";

const usage = "Usage: node install-windows.mjs [--dry-run] [--package <specifier-or-tarball>]";
function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function run(step, args, capture = false) {
  console.log(`\n[${step}] node ${args.map(arg => JSON.stringify(arg)).join(" ")}`);
  const result = spawnSync(process.execPath, args, { stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw Object.assign(Error(result.error?.message ?? `Command exited with ${result.signal ?? result.status}`), { status: result.status ?? (result.error?.code === "ENOENT" ? 127 : 1) });
  return capture ? result.stdout.trim() : "";
}

export function installWindows(args) {
  let dryRun = false, specifier = "@openrig/cli", packageSeen = false;
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(usage); return 0; }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run" && !dryRun) dryRun = true;
    else if (args[index] === "--package" && !packageSeen && args[index + 1] && !args[index + 1].startsWith("-")) {
      specifier = args[++index]; packageSeen = true;
    } else { console.error(usage); return 2; }
  }
  console.log([
    "Experimental native Windows install plan:",
    "  [1/4] Check this Node executable and the standard npm CLI; print versions.",
    `  [2/4] npm install -g -- ${JSON.stringify(specifier)}`,
    "        Locate this installation using npm prefix/root -g and run its SQLite ABI checker if present.",
    "  [3/4] Run the installed rig setup --dry-run.",
    "  [4/4] Run the installed rig setup; its dependency checks may install tools or write defaults.",
    "Use a native-capable build; published packages may not include this experiment. --package accepts a built tarball.",
    "Node advice: Node.js 22 or 24 with npm. The installed ABI checker owns compatibility decisions.",
    "Setup is optional for the manual selected-provider route. This wrapper does not log in, elevate, choose a permission policy or launch a team.",
  ].join("\n"));
  if (dryRun) { console.log("\nDry run: no commands executed or changes made."); return 0; }
  if (process.platform !== "win32") { console.error("Use scripts/install.sh on macOS/Linux; this entry is for native Windows."); return 2; }
  let step = "1/4", entry, abi = "SKIPPED (not checked; see above)";
  try {
    const npm = locateNpmCli();
    run(step, ["--version"]); run(step, [npm, "--version"]);
    step = "2/4";
    run(step, [npm, "install", "-g", "--", specifier]);
    const prefix = run(step, [npm, "prefix", "-g"], true), modules = run(step, [npm, "root", "-g"], true);
    if (!path.isAbsolute(prefix) || !path.isAbsolute(modules)) throw Error(`npm did not return absolute installation paths: ${JSON.stringify({ prefix, modules })}`);
    const physicalPrefix = fs.realpathSync.native(prefix), physicalModules = fs.realpathSync.native(modules);
    if (!within(physicalPrefix, physicalModules)) throw Error("npm global root is outside the selected installation prefix");
    const pkg = fs.realpathSync.native(path.join(physicalModules, "@openrig/cli"));
    if (!within(physicalModules, pkg)) throw Error("Installed package resolves outside npm global root");
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.rig;
    if (manifest.name !== "@openrig/cli" || typeof bin !== "string") throw Error("Installed package has no rig entry");
    entry = fs.realpathSync.native(path.resolve(pkg, bin));
    if (!within(pkg, entry) || !fs.statSync(entry).isFile() || !fs.statSync(path.join(physicalPrefix, "rig.cmd")).isFile()) throw Error("Installed rig entry or npm shim is unavailable");
    process.env.PATH = physicalPrefix + path.delimiter + (process.env.PATH ?? "");
    const checker = path.join(pkg, "scripts/check-abi.mjs");
    if (fs.existsSync(checker)) { run(step, [checker]); abi = "passed"; console.log("Node/SQLite compatibility check passed."); }
    else console.error(`Node/SQLite compatibility check SKIPPED: installed checker not found at ${checker}`);
    step = "3/4"; run(step, [entry, "setup", "--dry-run"]);
    step = "4/4"; run(step, [entry, "setup"]);
    console.log("\nFollow the next steps printed by rig setup. No daemon or team was launched by this wrapper.");
    return 0;
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status !== 0 ? error.status : 1;
    if (step === "4/4") console.error(`\nINSTALLED, SETUP NOT COMPLETE (exit ${status}).\nThe OpenRig CLI is installed: ${entry}\nNode/SQLite compatibility check: ${abi}.\nFix the reported setup issue, then run rig setup again; reinstalling is not required.`);
    else console.error(`\nFAILED [${step}] (exit ${status}): ${error.message}`);
    return status;
  }
}

let direct = false;
try { direct = Boolean(process.argv[1]) && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { /* Inert import. */ }
if (direct) process.exitCode = installWindows(process.argv.slice(2));
