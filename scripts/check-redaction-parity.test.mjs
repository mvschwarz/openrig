// Two files carry the same credential-pattern list, and nothing checked that they stayed the same:
//
//   packages/cli/src/restore-packet/redaction.ts        SECRET_PATTERNS
//   packages/daemon/src/domain/transcript-redaction.ts  TRANSCRIPT_SECRET_PATTERNS
//
// The daemon copy says it outright — "keep this list byte-equivalent to the CLI list … drift between
// these two arrays is a defect — reviewers should diff them on any change" — and a future slice is
// meant to fold them into one package. Until then the invariant has no guard, so a change to one
// side redacts one surface (restore packets) and silently leaves the other (transcript reads)
// exposed.
//
// The two files cannot import each other: the daemon is not a dependency of the CLI, and the daemon
// file notes that importing it "would invert the package graph". So the lists are read as source,
// but as *lists*: the initialiser is located after the `=`, its closing bracket is found by
// scanning, and the entries are the depth-zero comma-separated elements with comments removed.
//
// Both scans carry the last significant character with them rather than looking back at the raw
// text, because `/* note *` + `/ /a,b/g` would otherwise read the comment's closing slash as the
// character before the pattern and treat the pattern as structure. Inside an entry, whitespace
// between tokens is collapsed but the contents of a literal are kept byte for byte: `/a  b/g` and
// `/a b/g` match different text and must not compare equal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

const LISTS = {
  cli: {
    file: path.join(ROOT, "packages", "cli", "src", "restore-packet", "redaction.ts"),
    constName: "SECRET_PATTERNS",
  },
  daemon: {
    file: path.join(ROOT, "packages", "daemon", "src", "domain", "transcript-redaction.ts"),
    constName: "TRANSCRIPT_SECRET_PATTERNS",
  },
};

/** The shipped v0 policy has five patterns; a shorter list means the extractor lost entries. */
const MIN_PATTERNS = 5;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** The tokens after which a `/` starts a regex literal rather than dividing or starting a comment. */
const REGEX_PRECEDERS = new Set(["[", "(", "{", ",", "=", ":", "!", "?", "|", "&", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** True when a `/` following the last significant character `prev` opens a regex literal. */
function startsRegexAfter(prev) {
  return prev === undefined || REGEX_PRECEDERS.has(prev);
}

/** The last non-whitespace character before `at`, or undefined at the start of the text. */
function significantBefore(text, at) {
  for (let i = at - 1; i >= 0; i--) {
    if (!WHITESPACE.has(text[i])) return text[i];
  }
  return undefined;
}

/** Whether a comment starts at `at`: `//` to end of line, or `/* … *` + `/`. */
function isCommentStart(text, at) {
  return text[at] === "/" && (text[at + 1] === "/" || text[at + 1] === "*");
}

/** Index of the last character of the comment that starts at `at`. */
function commentEnd(text, at) {
  if (text[at + 1] === "/") {
    const newline = text.indexOf("\n", at);
    return newline === -1 ? text.length - 1 : newline - 1;
  }
  const close = text.indexOf("*/", at + 2);
  return close === -1 ? text.length - 1 : close + 1;
}

/** Index of the last character of the regex literal that starts at `at`. */
function regexEnd(text, at) {
  let inClass = false;
  for (let i = at + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "]") { inClass = false; continue; }
    if (ch === "/" && !inClass) {
      let j = i + 1;
      while (j < text.length && text[j] >= "a" && text[j] <= "z") j++;
      return j - 1;
    }
    if (ch === "\n") break;
  }
  throw new Error("unterminated regex literal");
}

/** Index of the closing quote of the string that starts at `at`. */
function stringEnd(text, at) {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === quote) return i;
  }
  throw new Error(`unterminated string starting at ${at}`);
}

/** Where an exported const's array initialiser starts and ends, located after its `=`. */
function bounds(source, constName) {
  const declaration = new RegExp(`export const ${constName}\\b`).exec(source);
  assert.ok(declaration, `no \`export const ${constName}\` in the file`);
  const assignment = source.indexOf("=", declaration.index + declaration[0].length);
  assert.notEqual(assignment, -1, `\`${constName}\` has no assignment`);
  const open = source.indexOf("[", assignment);
  assert.notEqual(open, -1, `\`${constName}\` has no array initialiser`);

  let depth = 0;
  let prev = significantBefore(source, open);
  for (let i = open; i < source.length; i++) {
    if (isCommentStart(source, i)) { i = commentEnd(source, i); continue; }
    const ch = source[i];
    if (ch === "/" && startsRegexAfter(prev)) { i = regexEnd(source, i); prev = ")"; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { i = stringEnd(source, i); prev = ")"; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return { open, close: i }; }
    if (!WHITESPACE.has(ch)) prev = ch;
  }
  throw new Error(`unterminated array initialiser for ${constName}`);
}

/** The `[ … ]` initialiser of an exported const, located after its `=`. */
export function arrayLiteral(source, constName) {
  const { open, close } = bounds(source, constName);
  return source.slice(open, close + 1);
}

/**
 * That initialiser's entries: split on commas at nesting depth zero, comments removed so the entry
 * beside a comment survives, whitespace between tokens collapsed, literal contents untouched.
 */
export function arrayEntries(source, constName) {
  const { open, close } = bounds(source, constName);
  const entries = [];
  let current = "";
  let depth = 0;
  let prev = significantBefore(source, open);

  const append = (ch) => {
    if (WHITESPACE.has(ch)) {
      if (current !== "" && !current.endsWith(" ")) current += " ";
      return;
    }
    current += ch;
  };

  for (let i = open + 1; i < close; i++) {
    if (isCommentStart(source, i)) { i = commentEnd(source, i); continue; }
    const ch = source[i];
    if (ch === "/" && startsRegexAfter(prev)) {
      const end = regexEnd(source, i);
      current += source.slice(i, end + 1);
      i = end;
      prev = ")";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = stringEnd(source, i);
      current += source.slice(i, end + 1);
      i = end;
      prev = ")";
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; append(ch); prev = ch; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; append(ch); prev = ch; continue; }
    if (ch === "," && depth === 0) { entries.push(current.trim()); current = ""; prev = ch; continue; }
    append(ch);
    if (!WHITESPACE.has(ch)) prev = ch;
  }
  entries.push(current.trim());
  return entries.filter((entry) => entry !== "");
}

function read(file) {
  return readFileSync(file, "utf8");
}

test("the transcript and restore-packet redaction lists are the same list", () => {
  const cli = arrayEntries(read(LISTS.cli.file), LISTS.cli.constName);
  const daemon = arrayEntries(read(LISTS.daemon.file), LISTS.daemon.constName);

  assert.ok(
    cli.length >= MIN_PATTERNS,
    `refusing to compare a list shorter than the shipped ${MIN_PATTERNS}: ${JSON.stringify(cli)}`,
  );
  assert.deepEqual(
    daemon,
    cli,
    "the two redaction lists have drifted. A pattern added to one side redacts only that surface " +
      "and leaves the other exposed, so change both files in the same commit:\n" +
      `  ${path.relative(ROOT, LISTS.cli.file)} (${LISTS.cli.constName})\n` +
      `  ${path.relative(ROOT, LISTS.daemon.file)} (${LISTS.daemon.constName})`,
  );
});

// The shapes an extractor can get wrong, or that a future edit to either list can look like.

test("an annotation-only change is not drift", () => {
  const entries = ["/\\bsk-[A-Za-z0-9_-]{16,}\\b/g", "/\\bAKIA[0-9A-Z]{16}\\b/g"];
  const shortAnnotation = `export const L: readonly RegExp[] = [\n  ${entries[0]},\n  ${entries[1]},\n];\n`;
  const genericAnnotation = `export const L: ReadonlyArray<RegExp> = [\n  ${entries[0]},\n  ${entries[1]},\n];\n`;

  assert.deepEqual(arrayEntries(shortAnnotation, "L"), entries);
  assert.deepEqual(
    arrayEntries(shortAnnotation, "L"),
    arrayEntries(genericAnnotation, "L"),
    "the same entries under a different annotation must compare equal",
  );
});

test("a ] inside a pattern does not end the array early", () => {
  const tricky = "/token=[A-Za-z0-9];[A-Za-z0-9]{20}/g";
  const withTricky = `export const L: readonly RegExp[] = [\n  ${tricky},\n  /second/g,\n];\n`;
  const withDifferent = `export const L: readonly RegExp[] = [\n  ${tricky},\n  /different/g,\n];\n`;

  assert.deepEqual(arrayEntries(withTricky, "L"), [tricky, "/second/g"]);
  assert.notDeepEqual(
    arrayEntries(withDifferent, "L"),
    arrayEntries(withTricky, "L"),
    "a difference after the pattern containing ] must still be seen",
  );
});

test("the minimum count is patterns, not lines", () => {
  const three = `export const L: readonly RegExp[] = [\n  /a/g,\n  /b/g,\n  /c/g,\n];\n`;

  assert.equal(arrayEntries(three, "L").length, 3);
  // The slice over the same array spans five lines (opener, three entries, closer), so a guard that
  // counted lines would have called this five patterns and passed.
  assert.equal(arrayLiteral(three, "L").split("\n").length, 5);
  assert.ok(
    arrayEntries(three, "L").length < MIN_PATTERNS,
    "a three-entry list must not satisfy a five-pattern minimum",
  );
});

test("a comment beside a pattern does not drop the pattern", () => {
  const withComment = `export const L: readonly RegExp[] = [\n  // the first rule\n  /first/g,\n  /second/g,\n];\n`;
  const withChangedFirst = `export const L: readonly RegExp[] = [\n  // the first rule\n  /CHANGED/g,\n  /second/g,\n];\n`;

  assert.deepEqual(arrayEntries(withComment, "L"), ["/first/g", "/second/g"]);
  assert.notDeepEqual(
    arrayEntries(withChangedFirst, "L"),
    arrayEntries(withComment, "L"),
    "a change to the pattern beside a comment must still be seen",
  );
});

test("a comment containing ] and commas is not structure", () => {
  const source = `export const L: readonly RegExp[] = [\n  /* a ] and, several, commas */\n  /first/g, // trailing ], note,\n  /second/g,\n];\n`;

  assert.deepEqual(arrayEntries(source, "L"), ["/first/g", "/second/g"]);
});

test("a constructor entry counts as one pattern", () => {
  const source = `export const L: readonly RegExp[] = [\n  new RegExp("a", "g"),\n  new RegExp("b", "g"),\n  new RegExp("c", "g"),\n];\n`;
  const entries = arrayEntries(source, "L");

  assert.deepEqual(entries, ['new RegExp("a", "g")', 'new RegExp("b", "g")', 'new RegExp("c", "g")']);
  assert.ok(
    entries.length < MIN_PATTERNS,
    "three constructor patterns must not meet a five-pattern minimum",
  );
});

test("a pattern right after a comment is still a pattern", () => {
  const escapedClass = "/[a\\]]/g";
  const source = `export const L = [\n  /a/, /b/, /c/, /d/, /e/,\n  /* note */ /x,y/g,\n  ${escapedClass},\n  /last/g,\n];\n`;
  const entries = arrayEntries(source, "L");

  assert.equal(entries.length, 8, `expected eight patterns, got ${JSON.stringify(entries)}`);
  assert.equal(entries[5], "/x,y/g", "a comma inside the pattern did not split it");
  assert.equal(entries[6], escapedClass);
  assert.equal(entries[7], "/last/g", "the array did not end inside the escaped class");
});

test("a difference after a commented pattern is still seen", () => {
  const same = `export const L = [\n  /a/, /b/, /c/, /d/, /e/,\n  // next rule\n  /[a\\]]/g,\n  /changed/g,\n];\n`;
  const other = `export const L = [\n  /a/, /b/, /c/, /d/, /e/,\n  // next rule\n  /[a\\]]/g,\n  /CHANGED/g,\n];\n`;

  assert.notDeepEqual(
    arrayEntries(other, "L"),
    arrayEntries(same, "L"),
    "a pattern changed after a commented one must still be seen",
  );
});

test("whitespace inside a pattern is not normalised away", () => {
  const spaced = `export const L = [\n  /a  b/g,\n  /x/g,\n];\n`;
  const single = `export const L = [\n  /a b/g,\n  /x/g,\n];\n`;

  assert.notDeepEqual(
    arrayEntries(spaced, "L"),
    arrayEntries(single, "L"),
    "/a  b/g and /a b/g match different text",
  );
});