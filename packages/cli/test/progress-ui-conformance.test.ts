// OPR.0.4.0.33 FR-4 — UI-contract conformance. The scaffold templates
// AND the `progress` update verb must write EXACTLY the shape the
// PROGRESS UI's data source parses. This test runs the real scaffold +
// the real verb output through the real ProgressIndexer (the daemon's
// parser, imported as a pure reader) and asserts the parsed tree.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The daemon's PROGRESS indexer is the UI data source. It only depends
// on node:fs/node:path, so it imports as a standalone pure reader.
import { ProgressIndexer } from "../../daemon/src/domain/progress/progress-indexer.js";
import { renderMissionProgressTemplate, renderSliceProgressTemplate } from "../src/lib/scope/templates.js";
import { addProgressRow, setProgressRow } from "../src/lib/scope/progress-edit.js";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rig-ui-conf-"))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function indexerFor(): ProgressIndexer {
  return new ProgressIndexer({ roots: [{ name: "test", canonicalPath: root }], maxDepth: 8 });
}

describe("FR-4 — scaffold output parses into the expected UI tree", () => {
  it("mission scaffold: non-null title + Milestones heading + all-active checkbox rows", () => {
    const dir = path.join(root, "mission-a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROGRESS.md"), renderMissionProgressTemplate("Mission A"), "utf8");

    const file = indexerFor().scan().files.find((f) => f.relPath.includes("mission-a"))!;
    expect(file).toBeDefined();
    expect(file.title).toBe("Progress — Mission A"); // from the FIRST H1, not frontmatter
    expect(file.rows.some((r) => r.kind === "heading" && r.text === "Milestones")).toBe(true);
    expect(file.counts.total).toBe(4);
    expect(file.counts.active).toBe(4);
    expect(file.counts.done).toBe(0);
  });

  it("slice scaffold parses into a non-null title + checkbox rows", () => {
    const dir = path.join(root, "slices", "01-x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROGRESS.md"), renderSliceProgressTemplate("Slice X"), "utf8");

    const file = indexerFor().scan().files.find((f) => f.relPath.includes("01-x"))!;
    expect(file.title).toBe("Progress — Slice X");
    expect(file.rows.some((r) => r.kind === "heading" && r.text === "Acceptance")).toBe(true);
    expect(file.counts.total).toBe(3);
  });
});

describe("FR-4 — verb output parses into the expected UI tree", () => {
  it("set→done + add active/blocked rows yield the right parsed statuses", () => {
    const dir = path.join(root, "slices", "02-updated");
    fs.mkdirSync(dir, { recursive: true });

    // Real verb logic applied to the real scaffold.
    let content = renderSliceProgressTemplate("Slice Updated");
    content = setProgressRow(content, { text: "Implementation complete", status: "done" }).content;
    content = addProgressRow(content, { section: "Rail", text: "Active thing", status: "active" }).content;
    content = addProgressRow(content, { section: "Rail", text: "Blocked thing", status: "blocked" }).content;
    fs.writeFileSync(path.join(dir, "PROGRESS.md"), content, "utf8");

    const file = indexerFor().scan().files.find((f) => f.relPath.includes("02-updated"))!;
    expect(file.title).toBe("Progress — Slice Updated");

    const byText = (t: string) => file.rows.find((r) => r.kind === "checkbox" && r.text === t);
    expect(byText("Implementation complete")!.status).toBe("done");
    expect(byText("Active thing")!.status).toBe("active");
    expect(byText("Blocked thing")!.status).toBe("blocked");
    // The verb created a `## Rail` heading node.
    expect(file.rows.some((r) => r.kind === "heading" && r.text === "Rail")).toBe(true);
    expect(file.counts.done).toBe(1);
    expect(file.counts.blocked).toBe(1);
  });
});
