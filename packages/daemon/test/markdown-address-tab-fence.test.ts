import assert from "node:assert/strict";
import { test } from "vitest";
import * as daemon from "../src/domain/markdown-address.js";
import * as shipped from "../assets/plugins/openrig-core/skills/loading-addressable-markdown/scripts/resolve-markdown.mjs";
for (const [reader, api] of [["daemon", daemon], ["shipped", shipped]] as const) {
const { parseMarkdownSections, resolveAddress } = api;
for (const marker of ["```", "~~~"]) {
  for (const ending of ["\n", "\r\n"]) {
    test(`${reader}: tab-indented ${marker} opener keeps sibling address (${JSON.stringify(ending)})`, () => {
      const text = ["## Selected", "", `\t${marker}js`, "\tconst example = true;", "", "## Sibling", "reachable"].join(ending);
      assert.deepEqual(parseMarkdownSections(text).map(s => s.headerPath), [["selected"], ["sibling"]]);
      assert.match(resolveAddress(text, ["sibling"]).text, /reachable/);
      if ("validateMarkdownAddressability" in api) assert.deepEqual(api.validateMarkdownAddressability(text), []);
    });
    test(`${reader}: tab-indented ${marker} closer keeps example heading hidden (${JSON.stringify(ending)})`, () => {
      const text = ["## Actual", `${marker}md`, `\t${marker}`, "## Still example", marker, "## Next", "reachable"].join(ending);
      assert.deepEqual(parseMarkdownSections(text).map(s => s.headerPath), [["actual"], ["next"]]);
      assert.throws(() => resolveAddress(text, ["still-example"]));
      assert.match(resolveAddress(text, ["next"]).text, /reachable/);
      if ("validateMarkdownAddressability" in api) assert.deepEqual(api.validateMarkdownAddressability(text), []);
    });
  }
}
}
