// OPR.0.7.0.13 / slice 20 seam: the person's saved answer on the seat-skills bootstrap (one line plus OpenRig's markers), read from
// `skills.router_line.enabled` and the settings store's own provenance. No ledger: `default` is unasked, `file` is the
// person's saved yes or no (an explicit false is persisted), `env` is the environment's, never the person's answer.
// Limits: a malformed hand-edited value resolves to the default, so it reads as unasked; a full config reset returns to
// unasked. Whoever lands this file first owns it (slice 13 or slice 20); the other imports it.
import { lstatSync, readFileSync } from "node:fs";
import type { SettingsStore } from "./user-settings/settings-store.js";

export type FootprintAnswer = { state: "unasked" } | { state: "yes" | "no"; by: "saved" | "environment" };

export function readFootprintAnswer(settings: Pick<SettingsStore, "resolveOne">): FootprintAnswer {
  const { value, source } = settings.resolveOne("skills.router_line.enabled");
  if (source === "default") return { state: "unasked" };
  return { state: value === true ? "yes" : "no", by: source === "env" ? "environment" : "saved" };
}

/** Slice 20 seam: what happened to the bootstrap line at one start, per guidance file, from the actual delivery. */
export type RouterLineFileOutcome =
  // The delivery succeeded; it can't tell a changed file from one already holding the line, so it isn't "written".
  | { path: string; outcome: "delivered" }
  | { path: string; outcome: "skipped"; reason: "answer_no" | "answer_unasked" | "answer_environment_no" | "answer_unreadable" }
  // The guidance file is a symbolic link; the line isn't written through it.
  | { path: string; outcome: "linked" }
  // The file holds the seat-skills block with someone's edit; the start leaves it as it is.
  | { path: string; outcome: "edited" }
  | { path: string; outcome: "unwritable"; error: string };
export interface RouterLineWriteResult { answer: FootprintAnswer | null; files: RouterLineFileOutcome[] }

/** Why the line isn't written for an answer that isn't a yes (null: the setting couldn't be read). */
export function routerLineSkipReason(answer: FootprintAnswer | null): Extract<RouterLineFileOutcome, { outcome: "skipped" }>["reason"] | null {
  if (!answer) return "answer_unreadable";
  if (answer.state === "unasked") return "answer_unasked";
  if (answer.state === "no") return answer.by === "environment" ? "answer_environment_no" : "answer_no";
  return null;
}

/** Whether the guidance file itself is a symbolic link; the line is never written through one. A missing or unreadable
 *  path isn't a link. */
export function guidanceFileIsLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** A guidance file's text, read from disk, or "" when it's missing or unreadable. */
export function readGuidanceFile(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
