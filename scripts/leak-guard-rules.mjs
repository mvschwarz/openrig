import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The leak guard's term lists come from an optional local JSON file named by this variable. Without one, every list is
 *  empty: the term checks find nothing, and every other check runs as before. */
export const LEAK_GUARD_RULES_ENV = "OPENRIG_LEAK_GUARD_RULES";

/** The term lists such a file holds. A file that holds any must hold them all, each a nonempty string array, except the
 *  optional allowed_context_lines. */
export const TERM_LISTS = [
  "path_prefixes",
  "seat_and_rig_patterns",
  "host_patterns",
  "charged_terms",
  "internal_path_globs",
  "allowed_context_substrings",
  "allowed_context_lines",
];

/** How a skill is published: the frontmatter keys it drops and the fence around the sections it strips. */
export const PUBLISHING_RULES = {
  frontmatter_drop_keys: [
    "source_evidence",
    "curation_note",
    "content_curator",
    "transfer_test",
    "transfer_test_notes",
    "naming_note",
    "last_verified",
    "structure",
  ],
  section_fence: { begin: "<!-- internal:begin -->", end: "<!-- internal:end -->" },
};

/** The rules file the environment names, or null. */
export function leakGuardRulesPath(env = process.env) {
  const path = env[LEAK_GUARD_RULES_ENV]?.trim();
  return path ? resolve(path) : null;
}

/** The term lists from `path`, or empty lists when no file is named. A named file that is missing or invalid throws: it
 *  is never read as empty. */
export function readTermRules(path = leakGuardRulesPath()) {
  const terms = Object.fromEntries(TERM_LISTS.map((key) => [key, []]));
  if (!path) return terms;
  if (!existsSync(path)) throw new Error(`Rules file not found: ${path}`);
  let rules;
  try {
    rules = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid rules file ${path}: ${error.message}`);
  }
  validateTermRules(rules, path);
  for (const key of TERM_LISTS) if (Object.hasOwn(rules, key)) terms[key] = rules[key];
  return terms;
}

/** What the skill mirror applies: the publishing rules and the term lists. */
export function readMirrorRules(path = leakGuardRulesPath()) {
  return { ...PUBLISHING_RULES, ...readTermRules(path) };
}

export function validateTermRules(rules, path) {
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error(`Invalid rules file ${path}: rules must be an object`);
  }
  for (const field of TERM_LISTS.filter((key) => key !== "allowed_context_lines")) {
    if (
      !Array.isArray(rules[field]) ||
      rules[field].length === 0 ||
      rules[field].some((value) => typeof value !== "string" || value === "")
    ) {
      throw new Error(`Invalid rules file ${path}: ${field} must be a nonempty string array`);
    }
  }
  if (Object.hasOwn(rules, "allowed_context_lines") && (
    !Array.isArray(rules.allowed_context_lines) ||
    rules.allowed_context_lines.some((value) =>
      typeof value !== "string" || value === "" || /[\r\n]/.test(value))
  )) {
    throw new Error(
      `Invalid rules file ${path}: allowed_context_lines must be an array of nonempty single-line strings`,
    );
  }
}
