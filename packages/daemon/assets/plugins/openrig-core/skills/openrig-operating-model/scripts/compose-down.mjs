#!/usr/bin/env node
import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const templates = fileURLToPath(new URL("../templates/", import.meta.url));
export const defaultNames = ["CULTURE.md", "SOP.md", "LEARNED.md", "SPEC.md", "PLAYBOOK.md", "INTENT.md"];

function glob(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + (pattern[i + 1] === "!" ? 2 : 1));
      if (end < 0) source += "\\[";
      else { const body = pattern.slice(i + 1, end); source += "[" + (body.startsWith("!") ? "^" + body.slice(1) : body.replace(/^\^/, "\\^")) + "]"; i = end; }
    } else source += c.replace(/[\\^$+?.(){}|]/g, "\\$&");
  }
  return new RegExp("^" + source + "$", process.platform === "win32" ? "i" : "");
}

export function parseOptions(args) {
  const names = [], excludes = [];
  for (let i = 0; i < args.length; i += 2) {
    if (!["--name", "--exclude"].includes(args[i]) || !args[i + 1]) throw Error("Expected --name FILE or --exclude GLOB");
    if (args[i] === "--name") {
      const name = args[i + 1];
      if (name === "." || name === ".." || /[/\\\0]/.test(name)) throw Error("Chain names must be file basenames");
      names.push(name);
    } else excludes.push(args[i + 1]);
  }
  return { names: names.length ? names : defaultNames, excludes };
}

/** Same subtree content/audit as compose.py down with generated headers removed.
 * Links and junctions are not a second source tree and are never traversed. */
export async function composeDown(directory, names = defaultNames, excludes = []) {
  const root = resolve(directory), info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Subtree root must be a real directory");
  const patterns = excludes.map(glob), hits = [];
  const walk = async folder => {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const file = join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && !patterns.some(p => p.test(file))) await walk(file);
    }
    for (const name of names) if (entries.some(entry => entry.name === name && entry.isFile() && !entry.isSymbolicLink())) hits.push(join(folder, name));
  };
  await walk(root); hits.sort();
  const output = [`<!-- root: ${root} · files: ${hits.length} · chains: ${names.join(", ")} -->`, "<!-- Subtree render (trunk render at a tree root). Never edit. -->"];
  const unseeded = [];
  for (const file of hits) {
    const bytes = await readFile(file), body = bytes.toString("utf8"), rel = relative(root, file);
    const head = body.split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/).slice(0, 15).join("\n");
    let template;
    try { template = await readFile(join(templates, basename(file))); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (template?.equals(bytes)) {
      const owner = head.match(/^owners?:\s*(.+)$/m)?.[1]?.trim() ?? "owner unknown — untouched scaffold";
      unseeded.push(`${rel} (owner: ${owner})`); continue;
    }
    const marked = /^status:\s*UNSEEDED/m.test(head);
    const title = rel + (marked ? " — ⚠ stale UNSEEDED marker on real content" : "");
    output.push(`\n\n<!-- ═══ ${title} ═══ -->\n\n## ⟦${title}⟧\n`, body.trimEnd());
    if (marked) unseeded.push(`${rel} — MARKER/CONTENT DISAGREE: rendered anyway; clear the stale status line`);
  }
  if (unseeded.length) output.push("\n\n# ⚠ UNSEEDED under this root (scaffold only — collapsed, not rendered)", ...unseeded.map(value => "- " + value));
  if (!hits.length) output.push("\n⚠ no chain files under this root — unfurl first?");
  return (output.join("\n") + "\n").split("\n").filter(line => !line.startsWith("<!-- GENERATED")).join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw Error("usage: compose-down.mjs ROOT [--name FILE ...] [--exclude GLOB ...]");
    const { names, excludes } = parseOptions(process.argv.slice(3));
    process.stdout.write(await composeDown(process.argv[2], names, excludes));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
