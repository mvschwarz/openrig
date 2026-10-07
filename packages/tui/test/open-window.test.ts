import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTerminalInWindow, terminalWindowNotice } from "../src/terminals/open-window.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function child(result: unknown, exit = 0) {
  const root = mkdtempSync(join(tmpdir(), "tui-window-")); roots.push(root);
  const entry = join(root, "inert cli.mjs"), calls = join(root, "calls.jsonl");
  writeFileSync(entry, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),url:process.env.OPENRIG_URL})+'\\n');
console.log(${JSON.stringify(JSON.stringify(result))});process.exitCode=${exit};`);
  return { entry, calls: () => readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}
const opened = { provider: "tmux", ok: true, opened: ["advisor", "operator"], absent: [], degraded: [], pages: 1 };

describe("TUI desktop terminal action", () => {
  it("runs the installed CLI once with the selected daemon, unchanged view and preview", async () => {
    const f = child(opened);
    expect(await openTerminalInWindow("saved:team with spaces", "http://selected.example:7439", f.entry, "preview-42")).toEqual(opened);
    expect(f.calls()).toEqual([{ url: "http://selected.example:7439", args: ["terminal", "open", "--window", "--json", "--expected-plan", "preview-42", "--", "saved:team with spaces"] }]);
  });

  it("keeps partial results and named absences instead of claiming a full open", async () => {
    const partial = { ...opened, ok: false, absent: [{ seat: "review", reason: "stopped" }], notes: ["Existing conversations preserved."] };
    const f = child(partial);
    expect(await openTerminalInWindow("rig:team", "http://localhost:7433", f.entry)).toEqual(partial);
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0].args).not.toContain("--expected-plan");
  });

  it("preserves no-desktop and possible-viewer details on a nonzero result without replay", async () => {
    const f = child({ ...opened, ok: false, opened: [], error: "No local desktop display is available", notes: ["Viewing session own-test may exist; inspect before retrying."] }, 1);
    await expect(openTerminalInWindow("saved:kernel", "http://localhost:7433", f.entry)).rejects.toThrow(/No local desktop display[\s\S]*own-test/);
    expect(f.calls()).toHaveLength(1);
  });

  it("does not turn a nonzero command exit into a success even with an opened array", async () => {
    const f = child(opened, 1);
    await expect(openTerminalInWindow("saved:kernel", "http://localhost:7433", f.entry)).rejects.toThrow();
    expect(f.calls()).toHaveLength(1);
  });

  it("retains named absences on a zero-tile response", async () => {
    const f = child({ ...opened, ok: false, opened: [], absent: [{ seat: "operator", reason: "stopped" }] }, 1);
    await expect(openTerminalInWindow("saved:kernel", "http://localhost:7433", f.entry)).rejects.toThrow("Absent: operator — stopped");
    expect(f.calls()).toHaveLength(1);
  });

  it("rejects an unreadable result without trying a second terminal", async () => {
    const f = child(null);
    await expect(openTerminalInWindow("saved:kernel", "http://localhost:7433", f.entry)).rejects.toThrow("no view result");
    expect(f.calls()).toHaveLength(1);
  });

  it("reports named partial results and visibility limits without claiming a visible window", () => {
    const notice = terminalWindowNotice("saved:kernel", { ...opened, ok: false,
      absent: [{ seat: "review", reason: "stopped" }],
      degraded: [{ seat: "remote", reason: "connection refused" }],
      error: "Page two could not open.",
      notes: ["Check the new terminal shows the intended view; window creation alone is not visual confirmation."],
    });
    expect(notice).toContain("2 tiles prepared; 1 absent; 1 degraded.");
    expect(notice).toContain("Absent: review — stopped");
    expect(notice).toContain("Skipped: remote — connection refused");
    expect(notice).toContain("Page two could not open.");
    expect(notice).toContain("not visual confirmation");
  });
});
