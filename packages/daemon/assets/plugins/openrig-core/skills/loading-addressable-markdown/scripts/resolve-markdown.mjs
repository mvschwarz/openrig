#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIN_LEVEL = 2;
const MAX_LEVEL = 3;

export class AddressResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AddressResolutionError";
  }
}

export function slugifyHeader(title) {
  return title
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseAddress(address) {
  const hashCount = (address.match(/#/g) ?? []).length;
  if (hashCount > 1) {
    throw new AddressResolutionError(`address '${address}' must contain at most one '#' separator`);
  }

  const [ref, headerPart] = hashCount === 1 ? address.split("#") : [address, undefined];
  if (!ref) throw new AddressResolutionError(`address '${address}' has no file before '#'`);
  if (headerPart === undefined) return { ref, headerPath: [] };

  const headerPath = headerPart.split("/");
  if (headerPath.some((segment) => segment.length === 0)) {
    throw new AddressResolutionError(`address '${address}' has an empty header segment`);
  }
  if (headerPath.length > MAX_LEVEL - MIN_LEVEL + 1) {
    throw new AddressResolutionError(`address '${address}' is too deep; addresses target H2 and H3 only`);
  }
  return { ref, headerPath };
}

function scanHeaders(lines) {
  const hits = [];
  let fence = null;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (heading) hits.push({ level: heading[1].length, title: heading[2], line: lineNumber });
  }
  return hits;
}

export function parseMarkdownSections(text) {
  const lines = text.split("\n");
  const headers = scanHeaders(lines);
  const sections = [];
  let currentH2 = null;

  for (let index = 0; index < headers.length; index++) {
    const heading = headers[index];
    if (heading.level < MIN_LEVEL || heading.level > MAX_LEVEL) {
      if (heading.level < MIN_LEVEL) currentH2 = null;
      continue;
    }

    const slug = slugifyHeader(heading.title);
    if (heading.level === 2) currentH2 = slug;
    const headerPath = heading.level === 2
      ? [slug]
      : currentH2 !== null
        ? [currentH2, slug]
        : [slug];
    const fullEnd = headers.slice(index + 1).find((next) => next.level <= heading.level)?.line ?? lines.length;
    const ownEnd = headers[index + 1]?.line ?? lines.length;

    sections.push({
      level: heading.level,
      title: heading.title,
      headerPath,
      headerLine: heading.line,
      text: lines.slice(heading.line, fullEnd).join("\n"),
      ownText: lines.slice(heading.line, ownEnd).join("\n"),
    });
  }
  return sections;
}

export function resolveAddress(text, headerPath) {
  if (headerPath.length === 0) {
    throw new AddressResolutionError("a bare file resolves without section lookup");
  }

  const sections = parseMarkdownSections(text);
  const wanted = headerPath.join("/");
  const hits = sections.filter((section) => section.headerPath.join("/") === wanted);
  if (hits.length > 1) {
    throw new AddressResolutionError(
      `address '#${wanted}' is AMBIGUOUS: ${hits.length} sections match at lines ${hits.map((hit) => hit.headerLine + 1).join(", ")}`,
    );
  }
  if (hits.length === 1) return hits[0];

  const parentPath = headerPath.slice(0, -1).join("/");
  const candidates = sections
    .filter((section) => section.headerPath.slice(0, -1).join("/") === parentPath)
    .map((section) => section.headerPath.join("/"));
  throw new AddressResolutionError(
    `address '#${wanted}' matches no header. ` +
      (candidates.length > 0
        ? `Addressable sections under '${parentPath || "(top)"}': ${candidates.join(", ")}.`
        : `Addressable sections: ${sections.map((section) => section.headerPath.join("/")).join(", ") || "(none)"}.`),
  );
}

function usage() {
  return "Usage: resolve-markdown.mjs [--root DIR] FILE[#h2-slug[/h3-slug]]\n";
}

async function main(argv) {
  let root = process.cwd();
  const args = [...argv];

  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (args[0] === "--root") {
    if (!args[1]) throw new AddressResolutionError("--root needs a directory");
    root = path.resolve(args[1]);
    args.splice(0, 2);
  }
  if (args.length !== 1) throw new AddressResolutionError(usage().trim());

  const { ref, headerPath } = parseAddress(args[0]);
  const filePath = path.isAbsolute(ref) ? ref : path.resolve(root, ref);
  const text = await readFile(filePath, "utf8");
  process.stdout.write(headerPath.length === 0 ? text : resolveAddress(text, headerPath).text);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.name ?? "Error"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
