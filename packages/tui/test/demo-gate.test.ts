import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// STANDING INVARIANT (arch ruling, 2026-08-02): the --demo gate is HARD.
// A demo fixture leaking into a live STATUS render = fabricated status = the
// exact PIN-2 violation. Pinned source-level, like the no-fetch-elsewhere check.

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => readFileSync(path.join(srcDir, f), "utf8");

describe("the --demo gate is hard (PIN-2 fabrication fence)", () => {
  it("no live render/hydration module imports the demo fixture", () => {
    for (const file of ["hydrate.ts", "render.ts", "state.ts", "daemon-client.ts", "socket-server.ts", "grammar.ts", "input.ts"]) {
      expect(read(file), `${file} must not import demo-data`).not.toMatch(/demo-data/);
    }
  });

  it("main.ts reaches demoSnapshot ONLY behind the --demo flag, and never constructs a client with it", () => {
    const main = read("main.ts");
    const demoUses = main.match(/demoSnapshot\(\)/g) ?? [];
    expect(demoUses).toHaveLength(1);
    expect(main).toMatch(/demo \? demoSnapshot\(\) : emptySnapshot\(\)/);
    expect(main).toMatch(/demo \? null : new DaemonClient/);
  });
});
