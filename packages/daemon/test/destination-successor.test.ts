import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedSuccessorNotice } from "../src/domain/destination-successor.js";

const header = '| old address | new owner (or "retired") | date | decided by |\n| --- | --- | --- | --- |\n';
describe("recorded destination successor", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "destination-successor-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const write = (text: string) => writeFileSync(join(root, "FORWARDING.md"), text);

  it("an absent ledger leaves the successor unrecorded", () => {
    expect(recordedSuccessorNotice(root, "worker@old-team")).toContain("unrecorded");
  });
  it("a header-only ledger leaves the successor unrecorded", () => {
    write(header);
    expect(recordedSuccessorNotice(root, "worker@old-team")).toContain("unrecorded");
  });
  it.each(["worker@new-team@host", "retired"])("quotes the exact recorded owner %s and provenance", owner => {
    write(header + `| \`worker@old-team\` | ${owner} | 2026-11-13 | operator |\n`);
    const notice = recordedSuccessorNotice(root, "worker@old-team");
    expect(notice).toContain(JSON.stringify(owner));
    expect(notice).toContain('date "2026-11-13", decided by "operator"');
  });
  it("does not infer from a different address or a rig name", () => {
    write(header + "| other@old-team | worker@new-team | 2026-11-13 | operator |\n");
    expect(recordedSuccessorNotice(root, "worker@old-team")).toContain("unrecorded");
  });
  it("multiple exact entries are unknown, without choosing the latest date", () => {
    write(header + "| worker@old-team | worker@new-team | 2026-11-12 | operator |\n| worker@old-team | retired | 2026-11-13 | operator |\n");
    expect(recordedSuccessorNotice(root, "worker@old-team")).toContain("unknown");
  });
  it.each(["arbitrary prose", header + "| worker@old-team | retired | | |\n"])("an unreadable format is unknown", text => {
    write(text);
    expect(recordedSuccessorNotice(root, "worker@old-team")).toContain("unknown");
  });
  it("an unreadable file is unknown", () => {
    mkdirSync(join(root, "FORWARDING.md"));
    expect(recordedSuccessorNotice(root, "worker@old-team")).toContain("unknown");
  });
});
