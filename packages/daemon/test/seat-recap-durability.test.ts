import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ phase: "", linkCode: "" }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.phase === "write" && String(args[1]).includes("new recap")) {
        actual.writeFileSync(args[0], "partial new recap");
        throw new Error("injected partial write");
      }
      return actual.writeFileSync(...args);
    },
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      if (fault.phase === "fallback-copy" && String(args[1]).endsWith(".md")) {
        actual.writeFileSync(args[1], "partial archive");
        throw new Error("injected fallback copy");
      }
      if (fault.phase === "source") {
        throw Object.assign(new Error("injected unreadable archive source"), { code: "EACCES" });
      }
      if (fault.phase === "archive") {
        actual.writeFileSync(args[1], "partial archive");
        throw new Error("injected archive copy");
      }
      return actual.copyFileSync(...args);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (fault.linkCode) throw Object.assign(new Error("injected unsupported hard link"), { code: fault.linkCode });
      if (fault.phase === "link") throw new Error("injected archive publication failure");
      return actual.linkSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fault.phase === "publish" && String(args[1]).endsWith("RECAP.md")) throw new Error("injected publication failure");
      return actual.renameSync(...args);
    },
  };
});
import { listRecapChain, writeSeatRecap } from "../src/domain/context-packs/seat-recap-store.js";

let seatDir: string | undefined;
afterEach(() => { fault.phase = ""; fault.linkCode = ""; if (seatDir) rmSync(seatDir, { recursive: true, force: true }); });

function seed() {
  seatDir = mkdtempSync(join(tmpdir(), "recap-durability-"));
  writeSeatRecap({ seatDir, content: "## Decisions\nfirst recap", now: () => 1 });
  writeSeatRecap({ seatDir, content: "## Decisions\ncurrent recap", now: () => 2 });
  return seatDir;
}

describe("recap publication durability", () => {
  it.each(["EOPNOTSUPP", "ENOTSUP", "EPERM", "EXDEV"])("archives exclusively when links fail with %s", (code) => {
    const dir = seed();
    fault.linkCode = code;
    writeSeatRecap({ seatDir: dir, content: "## Decisions\nnew recap", now: () => 2 });
    expect(readFileSync(join(dir, "RECAP.md"), "utf8")).toBe("## Decisions\nnew recap");
    expect(listRecapChain(dir).map(e => readFileSync(e.path, "utf8"))).toEqual(["## Decisions\nfirst recap", "## Decisions\ncurrent recap"]);
    expect(readdirSync(join(dir, "recap-superseded"))).toHaveLength(2);
    expect(readdirSync(dir).sort()).toEqual(["RECAP.md", "recap-superseded"]);
  });

  it.each(["fallback-copy", "publish"])("removes an owned fallback archive after %s failure", (phase) => {
    const dir = seed();
    const chain = listRecapChain(dir);
    fault.linkCode = "EOPNOTSUPP";
    fault.phase = phase;
    expect(() => writeSeatRecap({ seatDir: dir, content: "## Decisions\nnew recap", now: () => 2 })).toThrow();
    expect(readFileSync(join(dir, "RECAP.md"), "utf8")).toBe("## Decisions\ncurrent recap");
    expect(listRecapChain(dir)).toEqual(chain);
    expect(readFileSync(chain[0]!.path, "utf8")).toBe("## Decisions\nfirst recap");
    expect(readdirSync(join(dir, "recap-superseded"))).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual(["RECAP.md", "recap-superseded"]);
  });

  it("preserves a collided archive when the current source cannot be copied", () => {
    const dir = seed();
    const chain = listRecapChain(dir);
    fault.phase = "source";
    expect(() => writeSeatRecap({ seatDir: dir, content: "## Decisions\nnew recap", now: () => 2 })).toThrow("unreadable archive source");
    expect(readFileSync(join(dir, "RECAP.md"), "utf8")).toBe("## Decisions\ncurrent recap");
    expect(listRecapChain(dir)).toEqual(chain);
    expect(readFileSync(chain[0]!.path, "utf8")).toBe("## Decisions\nfirst recap");
    expect(readdirSync(join(dir, "recap-superseded"))).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual(["RECAP.md", "recap-superseded"]);
  });
  for (const phase of ["write", "archive", "link", "publish"]) {
    it(`preserves readable current and prior chain after ${phase} failure`, () => {
      const dir = seed();
      const chain = listRecapChain(dir);
      fault.phase = phase;
      expect(() => writeSeatRecap({ seatDir: dir, content: "## Decisions\nnew recap", now: () => 3 })).toThrow();
      expect(readFileSync(join(dir, "RECAP.md"), "utf8")).toBe("## Decisions\ncurrent recap");
      expect(listRecapChain(dir)).toEqual(chain);
      expect(readFileSync(chain[0]!.path, "utf8")).toBe("## Decisions\nfirst recap");
      expect(readdirSync(join(dir, "recap-superseded"))).toHaveLength(1);
      expect(readdirSync(dir).sort()).toEqual(["RECAP.md", "recap-superseded"]);
    });
  }
  it("publishes all new bytes and archives precisely the previous current", () => {
    const dir = seed();
    writeSeatRecap({ seatDir: dir, content: "## Decisions\nnew recap", now: () => 3 });
    expect(readFileSync(join(dir, "RECAP.md"), "utf8")).toBe("## Decisions\nnew recap");
    expect(listRecapChain(dir).map(e => readFileSync(e.path, "utf8"))).toEqual(["## Decisions\nfirst recap", "## Decisions\ncurrent recap"]);
  });
});
