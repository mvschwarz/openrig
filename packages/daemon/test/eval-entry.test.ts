import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// slice-07 re-review MEDIUM-1 — the standalone eval entry must be runnable by a DOCUMENTED path.
// The TS helpers it imports need the tsx loader, so `node run-evals.mjs` alone fails; the package
// command supplies the loader, and the file also ships executable so the shebang is real.
const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = resolve(HERE, "..");
const ENTRY = resolve(DAEMON, "scripts/run-evals.mjs");

describe("run-evals — has a runnable, documented entry", () => {
  it("exposes an `eval` package command that supplies the tsx loader", () => {
    const pkg = JSON.parse(readFileSync(resolve(DAEMON, "package.json"), "utf-8"));
    const cmd = String(pkg.scripts?.eval ?? "");
    expect(cmd).toMatch(/run-evals\.mjs/);
    expect(cmd).toMatch(/tsx/);
  });

  it("ships the entry executable (the shebang is real)", () => {
    expect(statSync(ENTRY).mode & 0o111).not.toBe(0);
  });
});
