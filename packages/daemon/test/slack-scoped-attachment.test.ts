// A scoped writer's evidence file is attached only from inside the shared roots its grant names, judged when the file is
// read: the reference as written must sit under one of them, and its real target must stay there.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultReadLocalImage } from "../src/domain/gateway/slack/slack-delivery.js";
import { FilePathSafetyError, resolveAllowedAbsoluteFile, type AllowlistRoot } from "../src/domain/files/path-safety.js";

describe("a scoped writer's evidence attachment", () => {
  let root: string;
  let other: string;
  let outside: string;
  let roots: AllowlistRoot[];
  const file = (dir: string, name: string, text: string) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const text = (read: ReturnType<typeof defaultReadLocalImage>) => (read && "bytes" in read ? Buffer.from(read.bytes).toString() : read);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-root-")));
    other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-other-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-outside-")));
    roots = [{ name: "proof", canonicalPath: root }];
  });
  afterEach(() => {
    for (const dir of [root, other, outside]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a file in a permitted root, and one reached through a link that stays in it", () => {
    const chart = file(root, "chart.png", "CHART");
    expect(text(defaultReadLocalImage(chart, { roots }))).toBe("CHART");
    fs.mkdirSync(path.join(root, "real"));
    file(path.join(root, "real"), "shot.png", "SHOT");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
    expect(text(defaultReadLocalImage(path.join(root, "alias", "shot.png"), { roots }))).toBe("SHOT");
  });

  it("skips a file outside the roots, in a root it doesn't name, or behind a link out, with the reason", () => {
    const secret = file(outside, "private.png", "SECRET");
    const elsewhere = file(other, "statement.pdf", "OTHER");
    fs.symlinkSync(secret, path.join(root, "chart.png"));
    fs.mkdirSync(path.join(root, "dir"));
    fs.symlinkSync(outside, path.join(root, "dir", "out"));
    const reason = { skipped: "outside the shared roots its writer may read" };
    expect(defaultReadLocalImage(secret, { roots })).toEqual(reason);
    expect(defaultReadLocalImage(elsewhere, { roots })).toEqual(reason);
    expect(defaultReadLocalImage(path.join(root, "chart.png"), { roots })).toEqual(reason);
    expect(defaultReadLocalImage(path.join(root, "dir", "out", "private.png"), { roots })).toEqual(reason);
    expect(defaultReadLocalImage(path.join(root, "..", path.basename(outside), "private.png"), { roots })).toEqual(reason);
    // No roots at all: nothing is read.
    expect(defaultReadLocalImage(path.join(root, "chart.png"), { roots: [] })).toEqual(reason);
  });

  it("names a missing file as missing, and keeps the reader's other answers", () => {
    expect(defaultReadLocalImage(path.join(root, "gone.png"), { roots })).toEqual({ skipped: "missing or unreadable" });
    expect(defaultReadLocalImage(path.join(root, "notes.txt"), { roots })).toBeNull();
    expect(defaultReadLocalImage("relative/chart.png", { roots })).toBeNull();
  });

  it("without a scope, reads as before, wherever the file is", () => {
    const secret = file(outside, "private.png", "LOCAL");
    expect(text(defaultReadLocalImage(secret))).toBe("LOCAL");
  });

  it("resolveAllowedAbsoluteFile places a path under a root as written and checks its real target", () => {
    const chart = file(root, "chart.png", "CHART");
    expect(resolveAllowedAbsoluteFile(roots, chart)).toBe(chart);
    fs.symlinkSync(file(outside, "x.png", "X"), path.join(root, "x.png"));
    expect(() => resolveAllowedAbsoluteFile(roots, path.join(root, "x.png"))).toThrow(FilePathSafetyError);
    expect(() => resolveAllowedAbsoluteFile(roots, path.join(outside, "x.png"))).toThrow(FilePathSafetyError);
  });
});
