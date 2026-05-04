import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = join(here, "..", "index.html");

describe("index.html", () => {
  it("declares an empty favicon so headed dogfood stays console-clean", () => {
    const html = readFileSync(indexHtml, "utf8");

    expect(html).toContain('rel="icon"');
    expect(html).toContain('href="data:,"');
  });
});
