#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TEXT_LIMIT = 4000;
const DEFAULT_OUT = "/tmp/claude-compaction-restore";

function parseArgs(argv) {
  const args = {
    jsonl: null,
    out: DEFAULT_OUT,
    cwd: process.cwd(),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--jsonl") args.jsonl = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--cwd") args.cwd = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (!arg.startsWith("-") && !args.jsonl) args.jsonl = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function readJsonLines(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse-error", line: index + 1, error: String(error), raw: line };
      }
    });
}

function findLatestJsonl(cwd) {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return null;

  const encoded = cwd ? cwd.replaceAll("/", "-") : null;
  const candidates = [];
  const roots = [];

  if (encoded) {
    const exact = path.join(projectsRoot, encoded);
    if (fs.existsSync(exact)) roots.push(exact);
  }
  roots.push(projectsRoot);

  for (const root of roots) {
    const result = spawnSync("find", [root, "-name", "*.jsonl", "-maxdepth", root === projectsRoot ? "4" : "2"], {
      encoding: "utf8",
    });
    if (result.status !== 0 && !result.stdout) continue;
    for (const file of result.stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        const stat = fs.statSync(file);
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore raced/deleted transcript files.
      }
    }
    if (candidates.length) break;
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file ?? null;
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "tool_use") return `[tool_use:${block.name}] ${JSON.stringify(block.input ?? {})}`;
        if (block?.type === "tool_result") return `[tool_result] ${truncate(stringifyContent(block.content), TEXT_LIMIT)}`;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[...truncated ${s.length - max} chars...]`;
}

function walkStrings(value, acc = []) {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) value.forEach((item) => walkStrings(item, acc));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => walkStrings(item, acc));
  return acc;
}

function normalizeFile(candidate, cwd) {
  let file = candidate.trim().replace(/[),.;:'"`\]\}>]+$/g, "").replace(/^[('"`<\[]+/g, "");
  if (!file || file.includes("\n")) return null;
  if (/\.(?:md|mdx|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|sh|rs|go|sql|css|scss|html|xml|svg|csv|log|lock)\//i.test(file)) return null;
  if (file.startsWith("~")) file = path.join(os.homedir(), file.slice(1));
  let normalized = null;
  if (file.startsWith("/")) normalized = path.normalize(file);
  else if (file.startsWith("./") || file.startsWith("../")) normalized = path.normalize(path.resolve(cwd, file));
  else if (/^[A-Za-z0-9_@.+-][A-Za-z0-9_@.+/\-:]*\.[A-Za-z0-9]+$/.test(file)) {
    normalized = path.normalize(path.resolve(cwd, file));
  } else if (/^(CLAUDE|AGENTS|README|DESIGN|CULTURE|MEMORY)\.md$/.test(file)) {
    normalized = path.normalize(path.resolve(cwd, file));
  }

  if (!normalized) return null;
  try {
    if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) return null;
  } catch {
    // Keep the candidate if stat races; the restore agent can decide.
  }
  return normalized;
}

function extractPaths(text, cwd) {
  const paths = new Set();
  const s = String(text ?? "");
  const absolute = /(?:^|[\s"'(<\[])(\/(?:Users|private|tmp|var|opt|Volumes)\/[^\s"'()\]<>]+)/g;
  const relative = /(?:^|[\s"'(<\[])((?:\.{1,2}\/)?[A-Za-z0-9_@.+-][A-Za-z0-9_@.+/\-:]*\.(?:md|mdx|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|sh|rs|go|sql|css|scss|html|xml|svg|csv|log|lock))(?:$|[\s"')>\],.;:])/g;
  const namedMarkdown = /(?:^|[\s"'(<\[])((?:CLAUDE|AGENTS|README|DESIGN|CULTURE|MEMORY)\.md)(?:$|[\s"')>\],.;:])/g;

  for (const regex of [absolute, relative, namedMarkdown]) {
    let match;
    while ((match = regex.exec(s)) !== null) {
      const normalized = normalizeFile(match[1], cwd);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths];
}

function createRegistry() {
  const files = new Map();
  let sequence = 0;

  return {
    add(file, kind, source) {
      if (!file) return;
      const existing = files.get(file) ?? {
        path: file,
        kinds: {},
        sources: new Set(),
        firstSeen: sequence,
        lastSeen: sequence,
      };
      existing.kinds[kind] = (existing.kinds[kind] ?? 0) + 1;
      existing.sources.add(source);
      existing.lastSeen = sequence;
      files.set(file, existing);
    },
    tick() {
      sequence += 1;
    },
    values() {
      return [...files.values()].map((entry) => ({
        ...entry,
        sources: [...entry.sources].slice(0, 8),
      }));
    },
  };
}

function toolKind(name, input) {
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return "written";
  if (name === "Read") return "read";
  if (["Grep", "Glob", "LS"].includes(name)) return "discovered";
  if (name === "Bash") {
    const command = input?.command ?? "";
    if (/\b(apply_patch|tee|touch|mkdir|mv|cp|rm)\b|(^|[^>])>{1,2}[^>]/.test(command)) return "shell-write";
    return "shell-mentioned";
  }
  return "mentioned";
}

function scoreFile(entry) {
  const ext = path.extname(entry.path).toLowerCase();
  let score = 0;
  if (entry.kinds.written) score += 40;
  if (entry.kinds["shell-write"]) score += 30;
  if (entry.kinds["file-history"]) score += 35;
  if (ext === ".md" || ext === ".mdx") score += 20;
  if (entry.kinds.read) score += 10;
  if (entry.kinds.discovered) score += 4;
  if (/\/docs\/as-built\//.test(entry.path)) score += 25;
  if (/(codemap|architecture|CLAUDE|AGENTS|README|DESIGN|CULTURE|session\.log|queue\.md)/i.test(entry.path)) score += 15;
  score += Math.min(10, Object.values(entry.kinds).reduce((a, b) => a + b, 0));
  return score;
}

function discoverDocs(cwd) {
  const candidates = [
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "docs/as-built",
    "docs",
  ];
  const docs = new Set();

  for (const candidate of candidates) {
    const full = path.resolve(cwd, candidate);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isFile()) docs.add(full);
    if (stat.isDirectory()) {
      const result = spawnSync("find", [full, "-maxdepth", candidate === "docs" ? "2" : "1", "-type", "f", "-name", "*.md"], {
        encoding: "utf8",
      });
      for (const file of result.stdout.split(/\r?\n/).filter(Boolean)) {
        if (/as-built|codemap|architecture|README|overview/i.test(file)) docs.add(path.normalize(file));
      }
    }
  }

  return [...docs].sort();
}

function analyze(jsonlPath, cwd) {
  const records = readJsonLines(jsonlPath);
  const registry = createRegistry();
  const transcript = [];
  const cwdCounts = new Map();
  let sessionId = null;

  for (const record of records) {
    registry.tick();
    if (record.sessionId || record.session_id) sessionId = record.sessionId ?? record.session_id;
    if (record.cwd) {
      cwdCounts.set(record.cwd, (cwdCounts.get(record.cwd) ?? 0) + 1);
      cwd = record.cwd;
    }

    if (record.type === "file-history-snapshot") {
      const backups = record.snapshot?.trackedFileBackups ?? {};
      for (const file of Object.keys(backups)) registry.add(path.normalize(file), "file-history", "file-history-snapshot");
    }

    const message = record.message;
    if (!message) continue;
    const role = message.role ?? record.type ?? "unknown";
    const content = message.content;

    if (typeof content === "string") {
      transcript.push(`\n## ${role}\n\n${content}`);
      for (const file of extractPaths(content, cwd)) registry.add(file, "mentioned", `${role}:text`);
      continue;
    }

    if (!Array.isArray(content)) continue;
    const parts = [];
    for (const block of content) {
      if (block?.type === "text") {
        parts.push(block.text ?? "");
        for (const file of extractPaths(block.text ?? "", cwd)) registry.add(file, "mentioned", `${role}:text`);
      } else if (block?.type === "tool_use") {
        const name = block.name ?? "unknown";
        const input = block.input ?? {};
        parts.push(`\n[tool_use:${name}]\n${JSON.stringify(input, null, 2)}`);
        const kind = toolKind(name, input);
        if (input.file_path) registry.add(normalizeFile(input.file_path, cwd), kind, `tool:${name}:file_path`);
        if (input.path) registry.add(normalizeFile(input.path, cwd), kind, `tool:${name}:path`);
        if (input.notebook_path) registry.add(normalizeFile(input.notebook_path, cwd), kind, `tool:${name}:notebook_path`);
        for (const text of walkStrings(input)) {
          for (const file of extractPaths(text, cwd)) registry.add(file, kind, `tool:${name}:input`);
        }
      } else if (block?.type === "tool_result") {
        const resultText = stringifyContent(block.content);
        parts.push(`\n[tool_result]\n${truncate(resultText, TEXT_LIMIT)}`);
        for (const file of extractPaths(resultText, cwd)) registry.add(file, "mentioned", "tool_result");
      }
    }
    if (parts.length) transcript.push(`\n## ${role}\n\n${parts.join("\n")}`);
  }

  const rankedFiles = registry
    .values()
    .map((entry) => ({ ...entry, score: scoreFile(entry), markdown: [".md", ".mdx"].includes(path.extname(entry.path).toLowerCase()) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const cwdRanked = [...cwdCounts.entries()].sort((a, b) => b[1] - a[1]);
  const effectiveCwd = cwdRanked[0]?.[0] ?? cwd;

  return {
    sessionId,
    jsonlPath,
    cwd: effectiveCwd,
    records: records.length,
    transcript: transcript.join("\n"),
    files: rankedFiles,
    docs: discoverDocs(effectiveCwd),
  };
}

function markdownFileList(files) {
  const lines = [];
  lines.push("# Touched Files");
  lines.push("");
  lines.push("Files are ranked for restore relevance. Markdown and written files are the first candidates to read in full.");
  lines.push("");

  const sections = [
    ["Highest-priority Markdown/state files", (f) => f.markdown && (f.kinds.written || f.kinds["shell-write"] || f.kinds["file-history"])],
    ["Other written/tracked files", (f) => !f.markdown && (f.kinds.written || f.kinds["shell-write"] || f.kinds["file-history"])],
    ["Read/discovered/mentioned files", (f) => !(f.kinds.written || f.kinds["shell-write"] || f.kinds["file-history"])],
  ];

  for (const [title, predicate] of sections) {
    const group = files.filter(predicate);
    if (!group.length) continue;
    lines.push(`## ${title}`);
    lines.push("");
    for (const file of group) {
      const kinds = Object.entries(file.kinds).map(([kind, count]) => `${kind}:${count}`).join(", ");
      lines.push(`- score ${file.score} — \`${file.path}\` — ${kinds}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function restoreInstructions(summary, outputPaths) {
  const lines = [];
  lines.push("# Claude Compaction Restore Instructions");
  lines.push("");
  lines.push("You have just been compacted or are restoring a compacted Claude Code seat. Your mental model is compressed and unreliable.");
  lines.push("");
  lines.push(`- JSONL transcript: \`${summary.jsonlPath}\``);
  lines.push(`- Reconstructed transcript: \`${outputPaths.transcript}\``);
  lines.push(`- Touched-file triage: \`${outputPaths.touchedFiles}\``);
  lines.push(`- Working directory inferred: \`${summary.cwd}\``);
  lines.push("");
  lines.push("## Required Sequence");
  lines.push("");
  lines.push("1. Read this file and `touched-files.md`.");
  lines.push("2. Ask yourself: which files do I recognize as important to the work and project state?");
  lines.push("3. Mark those files mentally or in a short note.");
  lines.push("4. Read every important Markdown/state/planning file in full.");
  lines.push("5. Read project root docs in full when present: `CLAUDE.md`, `AGENTS.md`, `README.md`.");
  lines.push("6. Read as-built docs and codemaps in full before product work, code review, or architecture decisions.");
  lines.push("7. State exactly: `restored from packet at <path>; resumed at step <X>`.");
  lines.push("");
  lines.push("## Documentation Candidates");
  lines.push("");
  if (summary.docs.length) {
    for (const doc of summary.docs) lines.push(`- \`${doc}\``);
  } else {
    lines.push("- No root/as-built/codemap candidates were found automatically. Search manually before resuming code/review work.");
  }
  lines.push("");
  lines.push("## Top File Candidates");
  lines.push("");
  for (const file of summary.files.slice(0, 30)) {
    lines.push(`- \`${file.path}\` — score ${file.score}`);
  }
  lines.push("");
  lines.push("Do not continue from fuzzy memory alone.");
  return lines.join("\n");
}

function writeOutputs(summary, outRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(outRoot, `${summary.sessionId ?? "unknown-session"}-${stamp}`);
  fs.mkdirSync(base, { recursive: true });

  const outputPaths = {
    dir: base,
    transcript: path.join(base, "transcript.txt"),
    touchedFiles: path.join(base, "touched-files.md"),
    instructions: path.join(base, "restore-instructions.md"),
    summary: path.join(base, "restore-summary.json"),
  };

  fs.writeFileSync(outputPaths.transcript, summary.transcript || "(no message transcript reconstructed)\n");
  fs.writeFileSync(outputPaths.touchedFiles, markdownFileList(summary.files));
  fs.writeFileSync(outputPaths.instructions, restoreInstructions(summary, outputPaths));
  fs.writeFileSync(outputPaths.summary, JSON.stringify({ ...summary, transcript: undefined, outputPaths }, null, 2));

  return outputPaths;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd);
  const jsonlPath = args.jsonl ? path.resolve(args.jsonl) : findLatestJsonl(cwd);
  if (!jsonlPath) throw new Error("could not find a Claude JSONL transcript; pass one explicitly");
  if (!fs.existsSync(jsonlPath)) throw new Error(`JSONL transcript not found: ${jsonlPath}`);

  const summary = analyze(jsonlPath, cwd);
  const outputPaths = writeOutputs(summary, path.resolve(args.out));
  const result = {
    ok: true,
    jsonlPath,
    outputDir: outputPaths.dir,
    transcript: outputPaths.transcript,
    touchedFiles: outputPaths.touchedFiles,
    instructions: outputPaths.instructions,
    fileCount: summary.files.length,
    topFiles: summary.files.slice(0, 12).map((file) => file.path),
  };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Restore packet: ${result.outputDir}`);
    console.log(`Instructions: ${result.instructions}`);
    console.log(`Touched files: ${result.touchedFiles}`);
    console.log(`Transcript: ${result.transcript}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`claude-compaction-restore failed: ${error.message}`);
  process.exit(1);
}
