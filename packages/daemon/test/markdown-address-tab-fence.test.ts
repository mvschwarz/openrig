import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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


const listFenceIndents = [["\t", "\t"], ["  ", "\t"], ["\t", "  "]] as const;
for (const [reader, api] of [["daemon", daemon], ["shipped", shipped]] as const) {
  for (const marker of ["```", "~~~"]) {
    for (const ending of ["\n", "\r\n"]) {
      for (const [openIndent, closeIndent] of listFenceIndents) {
        for (const example of ["Example", "Next"]) {
          test(`${reader}: list-contained ${marker} fence ${JSON.stringify([openIndent, closeIndent, ending, example])}`, () => {
            const text = ["## Actual", "- item", `${openIndent}${marker}md`,
              `  ## ${example}`, "  ### Child", `${closeIndent}${marker}`, "", "## Next", "reachable"].join(ending);
            assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
            assert.match(api.resolveAddress(text, ["next"]).text, /reachable/);
            assert.throws(() => api.resolveAddress(text, ["example"]));
            if ("validateMarkdownAddressability" in api) assert.deepEqual(api.validateMarkdownAddressability(text), []);
          });
        }
      }
      for (const [openerPrefix, closerPrefix] of [["\r", ""], ["", "\r"]]) {
        test(`${reader}: lone CR fence boundary ${JSON.stringify([marker, openerPrefix, closerPrefix, ending])}`, () => {
          const text = ["## Actual", `${openerPrefix}${marker}md`, "## Example",
            `${closerPrefix}${marker}`, "## Next", "reachable"].join(ending);
          assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
          assert.match(api.resolveAddress(text, ["next"]).text, /reachable/);
        });
      }
      for (const prefix of ["\f", "\v", "\u00a0"]) {
        test(`${reader}: top-level non-indent whitespace ${JSON.stringify([prefix, marker, ending])}`, () => {
          const text = ["## Actual", `${prefix}${marker}md`, "## Next", "reachable"].join(ending);
          assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
        });
      }
    }
  }
}

for (const [reader, api] of [["daemon", daemon], ["shipped", shipped]] as const) {
  test(`${reader}: lazy list continuation retains tab fence context`, () => {
    const text = "## Actual\n- item\nlazy continuation\n\t```md\n  ## Example\n\t```\n\n## Next\nreachable";
    assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
  });
  test(`${reader}: a new paragraph after a blank line ends list context`, () => {
    const text = "## Actual\n- item\n\nNew paragraph\n\t```md\n## Next\nreachable";
    assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
  });
}

const shippedResolver = fileURLToPath(new URL("../assets/plugins/openrig-core/skills/loading-addressable-markdown/scripts/resolve-markdown.mjs", import.meta.url));
for (const marker of ["```", "~~~"]) {
  for (const ending of ["\n", "\r\n"]) {
    for (const [openIndent, closeIndent] of listFenceIndents) {
      test(`executable shipped helper resolves list-contained ${marker} ${JSON.stringify([openIndent, closeIndent, ending])}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-list-fence-"));
        try {
          const file = path.join(root, "owned.md");
          fs.writeFileSync(file, ["## Actual", "- item", `${openIndent}${marker}md`,
            "  ## Next", `${closeIndent}${marker}`, "", "## Next", "reachable"].join(ending));
          const result = execFileSync(shippedResolver, [`${file}#next`], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000 });
          assert.match(result, /reachable/);
          assert.doesNotMatch(result, /- item/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
}
