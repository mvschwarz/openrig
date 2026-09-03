// Detail-view component vocabulary (founder round-2 directive): ONE visual
// language for every detail page — the approved mockup's agent-spec frame is
// the reference primitive. Plain-layer only (ContentLine[]); stylize paints by
// these conventions:
//   field row     "  label:      value"        → dim label / bright value
//   section rule  "  ── title ──────"          → chrome rule / bright title
//   list item     "  ▪ item"                    → uniform glyph
//   link          trailing "(open ▸)"           → the ONE open affordance
// The glance test is the bar: same fact type, same visual place, every page.
import type { Action } from "./types.js";
import type { Token } from "./theme.js";

export interface ContentLine {
  text: string;
  action?: Action;
  zones?: Array<{ start: number; end: number; action: Action }>;
  /** Explicit semantic paint runs. Their plain text must equal `text`. */
  segs?: Array<{ text: string; token?: Token; bold?: boolean; bg?: Token; inverse?: boolean }>;
}

/** fixed label column — one rhythm across every detail page */
export const LABEL_W = 12;
const OPEN = "(open ▸)";

export interface Field {
  label: string;
  value: string;
  /** clicking the row dispatches this (rendered with the standard affordance) */
  link?: Action;
}

export interface Section {
  title?: string;
  fields?: Field[];
  /** pre-built lines (lists, tables) that already follow the vocabulary */
  lines?: ContentLine[];
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function fieldLine(field: Field): ContentLine {
  const label = pad(`${field.label}:`, LABEL_W);
  const base = `  ${label} ${field.value}`;
  if (!field.link) return { text: base };
  return { text: `${base}  ${OPEN}`, action: field.link };
}

export function sectionRule(title: string, width = 96): ContentLine {
  const head = `  ── ${title} `;
  return { text: head + "─".repeat(Math.max(width - head.length, 4)) };
}

export function listItem(text: string, link?: Action, indent = 2): ContentLine {
  const base = `${" ".repeat(indent)}▪ ${text}`;
  if (!link) return { text: base };
  return { text: `${base}  ${OPEN}`, action: link };
}

/** Assemble a detail page: one spacing rhythm — a blank line before every
 * section rule except the first content block. */
export function detailPage(heading: ContentLine, sections: Section[]): ContentLine[] {
  const lines: ContentLine[] = [heading];
  for (const section of sections) {
    const body: ContentLine[] = [];
    for (const field of section.fields ?? []) body.push(fieldLine(field));
    body.push(...(section.lines ?? []));
    if (body.length === 0) continue;
    lines.push({ text: "" });
    if (section.title) lines.push(sectionRule(section.title));
    lines.push(...body);
  }
  return lines;
}

/** Aligned columns for list-style pages (needs-you, hosts-down): the glance
 * win is fixed columns, not dash-run-ons. */
export function alignedRow(cols: Array<[string, number]>, tail = ""): string {
  return cols.map(([text, width]) => pad(text, width)).join(" ") + tail;
}
