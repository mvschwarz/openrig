#!/usr/bin/env node
// Check concrete references, not prose quality. Run with node --import tsx.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RIGS = "packages/daemon/specs/rigs";
const SHARED_SKILLS = "packages/daemon/specs/agents/shared/skills";
const PLUGIN_SKILLS = "packages/daemon/assets/plugins/openrig-core/skills";
// The daemon installs these into the global skill roots; skills/ at the repository
// root carries the same skills for skills.sh.
const GLOBAL_SKILLS = "packages/daemon/assets/skills";
const SKILL_ROOTS = [SHARED_SKILLS, PLUGIN_SKILLS, GLOBAL_SKILLS];

// These are shipped via agent startup.files, rig/member startup.files,
// builtin-startup-files.ts and rigspec-instantiator.ts; setup prints the function
// below, and build-package.sh ships docs/reference. Add new first-run surfaces here.
export const SCOPE = [
  { file: `${RIGS}/launch/kernel/agents/operator/agent/guidance/role.md`, team: "kernel" },
  { file: `${RIGS}/launch/kernel/agents/operator/agent/startup/context.md`, team: "kernel" },
  { file: `${RIGS}/launch/starter/guidance/lead-first-move.md`, team: "starter" },
  { file: `${RIGS}/launch/factory/guidance/lead-first-move.md`, team: "factory" },
  { file: `${RIGS}/launch/factory/guidance/advisor-role.md`, team: "factory" },
  { file: "docs/reference/getting-started.md" },
  { file: "packages/cli/src/commands/setup.ts", function: "goldenPathNextSteps" },
  { file: "packages/daemon/assets/onboarding/01-world-and-purpose.md" },
  { file: "packages/daemon/assets/onboarding/02-self-and-competent-action.md" },
];

// Not a builtin alias or an existence assertion. External bundles need their own
// pinned-repository check; every occurrence is reported as unchecked below.
const EXTERNAL_TEAMS = new Map([
  ["workshop", "https://github.com/mvschwarz/openrig-world (external bundle)"],
]);
const placeholder = (s) => /[<>$…]|\.\.\./.test(s);
const literalName = (s) => /^[a-z][a-z0-9-]*$/.test(s);
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(root, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });
}

export function readSurface(root, scope) {
  const source = fs.readFileSync(path.join(root, scope.file), "utf8");
  if (!scope.function) return [{ text: source, line: 1 }];
  const ast = ts.createSourceFile(scope.file, source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === scope.function);
  if (!fn?.body) throw new Error(`missing printed-text function ${scope.function}`);
  const chunks = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      chunks.push({ text: node.text, line: lineAt(source, node.getStart(ast)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(fn.body);
  if (!chunks.length) throw new Error(`empty printed-text function ${scope.function}`);
  return chunks;
}

// Supported syntax: code spans, fenced shell commands, printed setup strings,
// Markdown links, code-formatted team table/bullet entries, and named skills.
// Arbitrary natural-language names, flags, shell expansion, user-created paths,
// native runtime config and external repository contents are not validated.
export function references(text, { printed = false, team } = {}) {
  const refs = [];
  const add = (kind, value, offset, extra = {}) => refs.push({ kind, value, line: lineAt(text, offset), ...extra });
  const spans = [...text.matchAll(/(?<!`)`([^`]+)`(?!`)/g)].map((m) => ({ value: m[1], offset: m.index + 1 }));
  for (const block of text.matchAll(/^```(?:sh|bash|zsh|shell|console)\s*\n([\s\S]*?)^```/gm)) {
    const start = block.index + block[0].indexOf("\n") + 1;
    for (const m of block[1].matchAll(/^[ \t]*(rig\s+[^\n#]+)/gm)) spans.push({ value: m[1], offset: start + m.index + m[0].indexOf(m[1]) });
  }
  if (printed) spans.push({ value: text, offset: 0 });
  for (const { value, offset } of spans) {
    for (const m of value.matchAll(/\brig\s+(?=[a-z-])([^;`]+)/g)) {
      add("command", m[0].trim(), offset + m.index, { printed });
    }
    for (const m of value.matchAll(/\b([a-z][a-z0-9-]*@[a-z][a-z0-9-]*)\b/g)) add("seat", m[1], offset + m.index);
    if (team && team !== "kernel" && /^(?:dev|orch|review|pm)-[a-z][a-z0-9-]*$/.test(value)) {
      // Unqualified seat names are only meaningful inside their own team's guidance.
      if (!/skill|old name/.test(text.slice(offset + value.length, offset + value.length + 30))) add("local-seat", value, offset, { team });
    }
    for (const m of value.matchAll(/(?:^|\s)((?:packages|docs|scripts|reference|specs\/rigs|daemon\/docs|daemon\/assets|@openrig\/cli\/daemon\/assets|skills)\/[\w./-]+)(?:#[\w/-]+)?/g)) {
      add("path", m[1], offset + m.index + m[0].indexOf(m[1]));
    }
    const before = text.slice(Math.max(0, offset - 85), offset - 1);
    const after = text.slice(offset + value.length + 1, offset + value.length + 85);
    if (literalName(value) && (
      /^\s+(?:team|rig)\b/.test(after) || /(?:shipped|built-in team|team named)\s+$/.test(before) ||
      /(?:^|\n)\s*-\s*$/.test(before) && /^:/.test(after)
    )) add("team", value, offset);
    if (literalName(value) && (/^\s*skill\b/.test(after) || /\b(?:skill|use|follow)\s+$/.test(before))) add("skill", value, offset);
  }
  // Team names in tables follow the column heading, not a fixed column number.
  let teamColumn = -1, offset = 0;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) teamColumn = -1;
    else {
      const cells = line.split("|");
      const heading = cells.findIndex((c) => /^(?:Team|Starter name|Spec name)$/.test(c.trim()));
      if (heading >= 0) teamColumn = heading;
      else if (teamColumn >= 0) {
        const name = cells[teamColumn]?.match(/`([a-z][a-z0-9-]*)`/);
        if (name) add("team", name[1], offset + line.indexOf(name[0]) + 1);
      }
    }
    offset += line.length + 1;
  }
  for (const m of text.matchAll(/\bteams?\s+((?:`[a-z][a-z0-9-]*`\s*(?:,\s*|and\s*)?)+)/g)) {
    for (const name of m[1].matchAll(/`([^`]+)`/g)) add("team", name[1], m.index + m[0].indexOf(name[0]) + 1);
  }
  if (printed) {
    const list = text.match(/\b(?:Teams:|Choose)\s+(.+)/);
    if (list) for (const name of list[1].replace(/\([^)]*\)/g, "").split(/,\s*(?:or\s+)?|\s+or\s+/).map((s) => s.trim())) {
      if (literalName(name)) add("team", name, text.indexOf(name, list.index));
    }
  }
  // A skill list can span lines; require the explicit noun, not every hyphenated token.
  for (const m of text.matchAll(/\bskills?\s*\(([^)]+)\)/g)) {
    for (const name of m[1].matchAll(/`([a-z][a-z0-9-]*)`/g)) add("skill", name[1], m.index + m[0].indexOf(name[0]) + 1);
  }
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!/^(?:[a-z]+:|#)/i.test(m[1])) add("link", m[1].split("#")[0], m.index + 2);
  }
  return [...new Map(refs.map((r) => [`${r.kind}:${r.line}:${r.value}`, r])).values()].sort((a, b) => a.line - b.line);
}

function tokens(command) {
  return (command.match(/"[^"]*"|'[^']*'|<[^>]*>|[^\s]+/g) ?? []).map((s) => s.replace(/^['"]|['"]$/g, ""));
}

export function commandReference(value, program, { prose = false } = {}) {
  const words = tokens(value).slice(1);
  let cmd = program;
  let i = 0;
  const verbs = ["rig"];
  for (; i < words.length; i++) {
    const word = words[i];
    if (!cmd.commands.length) break;
    if (word.startsWith("-")) {
      let owner = cmd, option;
      while (owner && !option) {
        option = owner.options.find((o) => o.short === word.split("=")[0] || o.long === word.split("=")[0]);
        owner = owner.parent;
      }
      if (!option) break; // Flags themselves are outside this check's contract.
      if (option.required && !word.includes("=")) i++;
      continue;
    }
    if (placeholder(word) || !/^[a-z][a-z0-9-]*$/.test(word)) break;
    const child = cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));
    // Setup's unquoted closing strings append English to commands. Commander
    // permits a default action beside subcommands (e.g. tui + tui commands).
    // Only that printed surface may stop at the default action; code examples
    // remain strict so a misspelled nested verb is still diagnosed.
    if (!child && prose && cmd._actionHandler) break;
    if (!child) return { error: `unknown verb ${[...verbs, word].join(" ")}` };
    cmd = child;
    verbs.push(cmd.name());
  }
  return { verbs: verbs.join(" "), args: words.slice(i) };
}

export async function loadAuthorities(root) {
  const from = (p) => import(pathToFileURL(path.join(root, p)).href);
  const [{ createProgram }, { resolveLibrarySpec }, { SpecLibraryService }, { SpecReviewService }] = await Promise.all([
    from("packages/cli/src/index.ts"), from("packages/cli/src/commands/specs.ts"),
    from("packages/daemon/src/domain/spec-library-service.ts"), from("packages/daemon/src/domain/spec-review-service.ts"),
  ]);
  const library = new SpecLibraryService({ roots: [{ path: path.join(root, "packages/daemon/specs"), sourceType: "builtin" }], specReviewService: new SpecReviewService() });
  library.scan();
  const entries = library.list({ kind: "rig" });
  if (!entries.length) throw new Error(`empty builtin rig library: ${RIGS}`);
  const skills = new Map();
  for (const dir of SKILL_ROOTS) {
    for (const file of walk(path.join(root, dir)).filter((p) => p.endsWith("/SKILL.md"))) {
      skills.set(path.basename(path.dirname(file)), path.relative(root, file));
    }
  }
  if (!skills.size) throw new Error("empty shipped skill catalog");
  const resolved = new Map();
  return {
    program: createProgram(), skills,
    async team(name) {
      if (!resolved.has(name)) {
        resolved.set(name, resolveLibrarySpec({ get: async () => ({ data: entries }) }, name, { kind: "rig" }).then((entry) => {
          const spec = parseYaml(fs.readFileSync(entry.sourcePath, "utf8"));
          const seats = (spec.pods ?? []).flatMap((pod) => (pod.members ?? []).map((m) => `${pod.id}-${m.id}`));
          return { seats, source: path.relative(root, entry.sourcePath) };
        }).catch(() => null));
      }
      return resolved.get(name);
    },
  };
}

function repositoryPath(value) {
  return value.replace(/^@openrig\/cli\/daemon\/assets\//, "packages/daemon/assets/")
    .replace(/^daemon\/assets\//, "packages/daemon/assets/").replace(/^daemon\/docs\//, "docs/")
    .replace(/^reference\//, "docs/reference/")
    .replace(/^specs\//, "packages/daemon/specs/");
}

export async function checkReferences(root, scope, authority) {
  if (!scope.length) throw new Error("first-run reference scope is empty (zero files)");
  const failures = [], unchecked = [], checked = [];
  async function check(ref) {
    const fail = (against, reason) => failures.push({ ...ref, against, reason });
    if (ref.kind === "command") {
      const result = commandReference(ref.value, authority.program, { prose: ref.printed });
      const against = "packages/cli/src/index.ts:createProgram() command tree";
      if (result.error) return fail(against, result.error);
      const first = result.args?.[0];
      if (["rig up", "rig specs preview", "rig specs show"].includes(result.verbs) && literalName(first ?? "")) {
        await check({ ...ref, kind: "team", value: first });
      }
      const words = tokens(ref.value), rigOption = words.indexOf("--rig");
      if (rigOption >= 0 && literalName(words[rigOption + 1] ?? "")) await check({ ...ref, kind: "team", value: words[rigOption + 1] });
      checked.push({ ...ref, against });
    } else if (["team", "seat", "local-seat"].includes(ref.kind)) {
      const [seat, name] = ref.kind === "team" ? [null, ref.value] : ref.kind === "local-seat" ? [ref.value, ref.team] : ref.value.split("@");
      if (EXTERNAL_TEAMS.has(name)) {
        unchecked.push({ ...ref, against: EXTERNAL_TEAMS.get(name), reason: "outside this repository; existence not checked" });
        return;
      }
      const found = await authority.team(name);
      if (!found) return fail(`${RIGS} via resolveLibrarySpec(kind=rig)`, `missing or ambiguous team ${name}`);
      if (seat && !found.seats.includes(seat)) return fail(`${found.source} pods[].members[]`, `missing seat ${seat}`);
      checked.push({ ...ref, against: found.source });
    } else if (ref.kind === "skill") {
      const found = authority.skills.get(ref.value);
      if (!found) return fail(SKILL_ROOTS.join(", "), "missing shipped skill");
      checked.push({ ...ref, against: found });
    } else {
      let target = repositoryPath(ref.value);
      if (ref.kind === "link") target = path.join(path.dirname(ref.file), ref.value);
      if (target.startsWith("skills/")) {
        const tail = target.slice("skills/".length);
        const candidates = [target, ...SKILL_ROOTS.map((dir) => `${dir}/${tail}`)];
        target = candidates.find((p) => fs.existsSync(path.join(root, p)));
        if (!target) return fail(candidates.join(" or "), "missing repository path");
      }
      if (!fs.existsSync(path.join(root, target))) return fail(target, "missing repository path");
      checked.push({ ...ref, against: target });
    }
  }
  for (const entry of scope) {
    let chunks;
    try { chunks = readSurface(root, entry); }
    catch (error) { failures.push({ file: entry.file, line: 1, value: entry.file, against: "explicit SCOPE", reason: error.message }); continue; }
    if (!chunks.some((c) => c.text.trim())) {
      failures.push({ file: entry.file, line: 1, value: entry.file, against: "explicit SCOPE", reason: "empty first-run surface" });
    }
    for (const chunk of chunks) {
      for (const ref of references(chunk.text, { printed: !!entry.function, team: entry.team })) {
        await check({ ...ref, file: entry.file, line: ref.line + chunk.line - 1 });
      }
    }
  }
  return { files: scope.length, checked, failures, unchecked };
}

export function formatReference(ref) {
  return `${ref.file}:${ref.line}: ${JSON.stringify(ref.value)} — ${ref.reason ?? "exists"}; checked against ${ref.against}`;
}

export async function main(root = ROOT) {
  const report = await checkReferences(root, SCOPE, await loadAuthorities(root));
  for (const ref of report.failures) console.error(formatReference(ref));
  for (const ref of report.unchecked) console.log(`UNCHECKED ${ref.file}:${ref.line}: ${JSON.stringify(ref.value)} — ${ref.reason}; external authority ${ref.against}`);
  console.log(`First-run references: ${report.files} files, ${report.checked.length} checked, ${report.failures.length} failures, ${report.unchecked.length} external references unchecked.`);
  if (report.failures.length) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`First-run references: ${error.message}`); process.exitCode = 1; });
}
