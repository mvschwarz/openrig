// qitem-markdown-bare-marker-loop — ISOLATED child renderer.
//
// Renders the REAL MarkdownViewer against a bare list-marker line (a marker
// followed by whitespace but NO text). On the pre-fix parser this line is
// recognized by the outer list guard but rejected by the inner item capture,
// which `break`s WITHOUT advancing the cursor — an infinite loop that pins a
// CPU and exhausts the heap.
//
// This runs in its own process, under a low --max-old-space-size and a hard
// parent-side timeout, so the hang can be observed as a nonzero exit / kill
// WITHOUT taking the Vitest worker down with it.
//
// Contract on exit 0: the parser terminated AND the bare marker degraded
// VISIBLY (the marker text survives in the output — never silently dropped).

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownViewer } from "../../src/components/markdown/MarkdownViewer.js";

// The fixture: a valid item, a BARE marker line, then more real content, so
// termination and degradation are both observable.
const CONTENT = "1. real item\n- \n2. after the bare marker";

const html = renderToStaticMarkup(
  React.createElement(MarkdownViewer, { content: CONTENT, hideFrontmatter: true, hideRawToggle: true }),
);

// Degradation must be VISIBLE, not silent. Two obligations:
//  (a) the surrounding authored content survives the bare-marker line, and
//  (b) the bare marker ITSELF is still visible to the operator — it may be
//      demoted (paragraph / raw marker text) but must never be swallowed.
// (b) is checked on rendered TEXT with tags stripped, so an `<li>`/`<ul>`
// element alone cannot satisfy it: a standalone "-" token must appear.
const text = html
  .replace(/<[^>]*>/g, "\n")   // tags -> boundaries, so markup can't fake a token
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const missing: string[] = [];
if (!text.includes("real item")) missing.push("real item");
if (!text.includes("after the bare marker")) missing.push("after the bare marker");
// A standalone hyphen token: the bare marker rendered as visible text.
if (!/(^|\s)-(\s|$)/m.test(text)) missing.push("visible bare '-' marker token");

if (missing.length > 0) {
  process.stderr.write(`SILENT_DROP: missing ${missing.join(", ")}\n`);
  process.exit(2);
}

process.stdout.write("TERMINATED_OK\n");
process.exit(0);
