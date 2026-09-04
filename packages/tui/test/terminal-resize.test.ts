import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("terminal resize", () => {
  it("wires the native stdout resize event directly to draw and removes it on shutdown", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    const shutdown = main.slice(main.indexOf("async function shutdown"), main.indexOf('process.on("SIGINT"'));

    expect(main).toContain('process.stdout.on("resize", draw);');
    expect(shutdown).toContain('process.stdout.off("resize", draw);');
  });
});
