import { lstat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// find -path treats '*' as matching separators as well as filename bytes.
export function selectionPattern(pattern) {
  if (process.platform === "win32") pattern = pattern.replaceAll("\\", "/");
  pattern = pattern.replace(/^\.\//, "");
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") expression += ".*";
    else if (c === "?") expression += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) throw Error("Unclosed selection character class");
      const content = pattern.slice(i + 1, end);
      if (!content || content.includes("\\")) throw Error("Invalid selection character class");
      expression += "[" + (content.startsWith("!") ? "^" + content.slice(1) : content) + "]";
      i = end;
    } else expression += c.replace(/[\\^$+?.()|{}]/g, "\\$&");
  }
  return new RegExp("^" + expression + "$", "s");
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function findPolluter(args, { cwd = process.cwd(), env = process.env, log = console.log, run } = {}) {
  if (args.length !== 2 || !args[0] || !args[1]) { log("Usage: node find-polluter.mjs <file_or_dir_to_check> <test_pattern>"); return 2; }
  try {
    const pollution = resolve(cwd, args[0]), pattern = selectionPattern(args[1]), files = [];
    async function walk(relative = "") {
      for (const entry of await readdir(join(cwd, relative), { withFileTypes: true })) {
        const name = relative ? relative + "/" + entry.name : entry.name;
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile() && pattern.test(name)) files.push("./" + name);
      }
    }
    await walk(); files.sort();
    if (!files.length) { log("No test files matched; no tests ran."); return 2; }
    if (await exists(pollution)) { log("Pollution already exists before testing; no tests ran."); return 2; }
    const execute = run ?? (file => new Promise(resolveRun => {
      const cli = env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
      const child = process.platform === "win32"
        ? spawn(process.execPath, [cli, "test", file], { cwd, env, stdio: "ignore", windowsHide: true })
        : spawn("npm", ["test", file], { cwd, env, stdio: "ignore" });
      child.once("error", () => resolveRun(false));
      child.once("close", code => resolveRun(code === 0));
    }));
    let failed = 0;
    for (const [index, file] of files.entries()) {
      log(`[${index + 1}/${files.length}] Testing: ${file}`);
      if (!await execute(file)) { failed++; log(`Test run failed: ${file}`); }
      if (await exists(pollution)) { log(`FOUND POLLUTER: ${file}\nCreated: ${pollution}`); return 1; }
    }
    if (failed) { log(`Incomplete: ${failed} test runs failed; no polluter observed.`); return 2; }
    log(`No polluter found - ${files.length} test runs succeeded without pollution.`); return 0;
  } catch (error) { log(`No result: ${error.message}`); return 2; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await findPolluter(process.argv.slice(2));
}
