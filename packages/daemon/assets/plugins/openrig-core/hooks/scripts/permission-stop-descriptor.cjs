"use strict";

// Constant-only permission-stop descriptor builder for untrusted provider tool payloads.
// Never interpolates raw input fragments, paths, URLs, arguments, environment assignments,
// provider reason strings, or hashes of input; every return value is a pre-defined constant
// ASCII string of at most 80 characters.

const MAX_DESCRIPTOR_LENGTH = 80;
const MAX_COMMAND_INPUT_LENGTH = 512;

const BASH_DETAILS_WITHHELD = "Bash: details withheld";
const TOOL_DETAILS_WITHHELD = "Tool: details withheld";

const BASH_EXECUTABLE_DESCRIPTORS = Object.freeze(
  Object.assign(Object.create(null), {
    git: "Bash: git [arguments hidden]",
    npm: "Bash: npm [arguments hidden]",
    node: "Bash: node [arguments hidden]",
    python3: "Bash: python3 [arguments hidden]",
    ls: "Bash: ls [arguments hidden]",
    pwd: "Bash: pwd [arguments hidden]",
    cat: "Bash: cat [arguments hidden]",
    sed: "Bash: sed [arguments hidden]",
    find: "Bash: find [arguments hidden]",
    echo: "Bash: echo [arguments hidden]",
    printf: "Bash: printf [arguments hidden]",
  }),
);

const KNOWN_TOOL_DESCRIPTORS = Object.freeze(
  Object.assign(Object.create(null), {
    Read: "Tool: Read",
    Write: "Tool: Write",
    Edit: "Tool: Edit",
    MultiEdit: "Tool: MultiEdit",
    NotebookEdit: "Tool: NotebookEdit",
    Glob: "Tool: Glob",
    Grep: "Tool: Grep",
    LS: "Tool: LS",
    WebFetch: "Tool: WebFetch",
    WebSearch: "Tool: WebSearch",
    Skill: "Tool: Skill",
    Task: "Tool: Task",
    TodoWrite: "Tool: TodoWrite",
  }),
);

// Rejects any character outside horizontal tab (0x09) and printable ASCII (0x20-0x7E),
// including newlines (\r, \n), NUL, ESC/ANSI sequences, DEL, and non-ASCII characters.
const DISALLOWED_CONTROL_OR_NON_ASCII = /[^\t\x20-\x7e]/;

// Rejects compound operators, pipes, backgrounding, redirections, heredocs, substitutions,
// expansions, subshells, brace groups, and backslash escapes anywhere in the command.
const DISALLOWED_SHELL_METACHARACTER = /[;&|<>(){}$`\\]/;

/**
 * Check whether a value is a plain object (prototype is Object.prototype or null).
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Verify that quotes in the argument tail are balanced and that no unquoted shell comment
 * starts in the argument tail.
 *
 * @param {string} rest
 * @returns {boolean}
 */
function hasSafeArgumentTail(rest) {
  let quote = "";
  let atWordStart = true;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "#" && atWordStart) return false;
    if (ch === "'" || ch === '"') {
      quote = ch;
      atWordStart = false;
      continue;
    }
    atWordStart = ch === " " || ch === "\t";
  }
  return quote === "";
}

/**
 * Build a constant-only descriptor for a Bash command string.
 * Rejects oversized inputs before scanning so prefixes of oversized strings are never accepted.
 *
 * @param {string} command
 * @returns {string}
 */
function describeBashCommand(command) {
  if (command.length === 0 || command.length > MAX_COMMAND_INPUT_LENGTH) {
    return BASH_DETAILS_WITHHELD;
  }
  if (DISALLOWED_CONTROL_OR_NON_ASCII.test(command) || DISALLOWED_SHELL_METACHARACTER.test(command)) {
    return BASH_DETAILS_WITHHELD;
  }
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return BASH_DETAILS_WITHHELD;
  }
  const match = /^([a-z0-9]+)(?:[ \t]+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return BASH_DETAILS_WITHHELD;
  }
  const executable = match[1];
  const descriptor = BASH_EXECUTABLE_DESCRIPTORS[executable];
  if (typeof descriptor !== "string") {
    return BASH_DETAILS_WITHHELD;
  }
  const rest = match[2] || "";
  if (rest.length > 0 && !hasSafeArgumentTail(rest)) {
    return BASH_DETAILS_WITHHELD;
  }
  return descriptor;
}

/**
 * Build a bounded, constant-only permission-stop descriptor from untrusted provider tool data.
 *
 * @param {unknown} input
 * @returns {string}
 */
function buildPermissionStopDescriptor(input) {
  try {
    if (!isPlainObject(input)) return TOOL_DETAILS_WITHHELD;
    const toolName = input.tool_name;
    if (typeof toolName !== "string") return TOOL_DETAILS_WITHHELD;

    if (toolName === "Bash") {
      const toolInput = input.tool_input;
      if (!isPlainObject(toolInput) || typeof toolInput.command !== "string") {
        return TOOL_DETAILS_WITHHELD;
      }
      return describeBashCommand(toolInput.command);
    }

    const knownToolDescriptor = KNOWN_TOOL_DESCRIPTORS[toolName];
    if (typeof knownToolDescriptor === "string") {
      const toolInput = input.tool_input;
      if (toolInput !== undefined && !isPlainObject(toolInput)) {
        return TOOL_DETAILS_WITHHELD;
      }
      return knownToolDescriptor;
    }

    return TOOL_DETAILS_WITHHELD;
  } catch {
    return TOOL_DETAILS_WITHHELD;
  }
}

// Rule text is intentionally sensitive evidence, unlike the constant-only tool descriptor.
// Bounds count UTF-16 code units per string and UTF-8 bytes of the serialized envelope.
function buildPermissionRuleSuggestions(input) {
  const unavailable = { state: "unavailable", entries: [], unsupported: false, size_cut: false };
  try {
    if (!isPlainObject(input)) return unavailable;
    if (!Object.hasOwn(input, "permission_suggestions")) {
      return { state: "missing", entries: [], unsupported: false, size_cut: false };
    }
    const evidence = { state: "present", entries: [], unsupported: false, size_cut: false };
    const entries = input.permission_suggestions;
    if (!Array.isArray(entries)) return { ...evidence, unsupported: true };
    if (entries.length > 8) evidence.size_cut = true;
    for (const entry of entries.slice(0, 8)) {
      if (!isPlainObject(entry) || !["addRules", "replaceRules", "removeRules"].includes(entry.type)
        || !["allow", "deny", "ask"].includes(entry.behavior)
        || !["session", "localSettings", "projectSettings", "userSettings"].includes(entry.destination)
        || !Array.isArray(entry.rules)
        || Object.keys(entry).some(key => !["type", "rules", "behavior", "destination"].includes(key))) {
        evidence.unsupported = true;
        continue;
      }
      if (entry.rules.length > 16) { evidence.size_cut = true; continue; }
      const rules = [];
      let rejected = false;
      for (const rule of entry.rules) {
        if (!isPlainObject(rule) || typeof rule.toolName !== "string" || !rule.toolName.length
          || Object.keys(rule).some(key => !["toolName", "ruleContent"].includes(key))
          || (Object.hasOwn(rule, "ruleContent") && typeof rule.ruleContent !== "string")) {
          evidence.unsupported = true; rejected = true; break;
        }
        if (rule.toolName.length > 128 || (Object.hasOwn(rule, "ruleContent") && rule.ruleContent.length > 2048)) {
          evidence.size_cut = true; rejected = true; break;
        }
        rules.push({ toolName: rule.toolName,
          ...(Object.hasOwn(rule, "ruleContent") ? { ruleContent: rule.ruleContent } : {}) });
      }
      if (rejected) continue;
      const supported = { type: entry.type, rules, behavior: entry.behavior, destination: entry.destination };
      if (Buffer.byteLength(JSON.stringify({ ...evidence, entries: [...evidence.entries, supported] }), "utf8") > 16384) {
        evidence.size_cut = true; continue;
      }
      evidence.entries.push(supported);
    }
    return evidence;
  } catch { return unavailable; }
}

module.exports = {
  MAX_DESCRIPTOR_LENGTH,
  MAX_COMMAND_INPUT_LENGTH,
  BASH_DETAILS_WITHHELD,
  TOOL_DETAILS_WITHHELD,
  BASH_EXECUTABLE_DESCRIPTORS,
  KNOWN_TOOL_DESCRIPTORS,
  buildPermissionStopDescriptor,
  buildPermissionRuleSuggestions,
};
