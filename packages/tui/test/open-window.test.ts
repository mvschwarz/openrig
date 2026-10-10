import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTerminalInWindow, terminalWindowNotice } from "../src/terminals/open-window.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { terminalLines } from "../src/terminals/terminal-model.js";
import type { DaemonClient } from "../src/daemon-client.js";

// Keep the prior implementation callable: it ignores the optional recovery hook.
const openWithRecovery: (view: string, endpoint: string, entry?: string, plan?: string, onUnavailable?: () => void) => ReturnType<typeof openTerminalInWindow> = openTerminalInWindow;

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
  it.each(["rig", "pod"])("direct %s action reaches exact attach guidance after definite window refusal, without relaunch", async kind => {
    let snap = demoSnapshot();
    const view = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
    view.dispatch(parseCommand("rig openrig-build"));
    const action = renderScreen(view.get(), snap, { cols: 140, rows: 42 }).hitMap
      .map(hit => hit.action).find(a => a?.type === "act" && a.act === "open-terminal" && a.view.startsWith(`${kind}:`));
    if (action?.type !== "act" || action.act !== "open-terminal") throw new Error("direct terminal action missing");
    expect(view.get().section).not.toBe("terminals");
    const f = child({ ...opened, ok: false, opened: [], code: "terminal_window_failed", windowAttempted: false,
      error: "No terminal window was opened. No local desktop display is available." }, 1);
    await expect(openWithRecovery(action.view, "http://selected.example:7654", f.entry, action.expectedPlan,
      () => view.dispatch({ type: "terminal-preview", view: action.view }))).rejects.toThrow("No terminal window was opened");
    expect(view.get()).toMatchObject({ section: "terminals", terminalView: action.view });
    const paneCommand = "ssh viewer@other.example \"tmux attach -r -t '=seat with spaces'\"";
    const reads: string[] = [];
    const client = { baseUrl: "http://selected.example:7654",
      terminalViews: async () => { reads.push("catalog"); return { saved: [], rigs: [] }; },
      previewTerminal: async (selected: string) => { reads.push(selected); return {
        view: selected, provider: "herdr", planId: "recovery-plan", status: { available: false },
        composed: { id: "recovery", opened: [{ seat: "remote" }], absent: [], degraded: [],
          pages: [[{ seat: "remote", label: "Remote seat", readOnly: true, paneCommand }]] },
        grids: [{ columns: 1, rows: 1, blanks: 0 }],
      }; },
    } as unknown as DaemonClient;
    snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
    const text = terminalLines(view.get(), snap, 1000).map(line => line.text).join("\n");
    expect(text).toContain(action.view);
    expect(text).toContain("Headless or remote: open a NEW terminal/tab");
    expect(text).toContain("http://selected.example:7654");
    expect(text).toContain("env -u TMUX ssh -t viewer@other.example \"tmux attach -r -t '=seat with spaces'\"");
    expect(reads).toEqual(["catalog", action.view]);
    expect(f.calls()).toHaveLength(1);
  });

  it.each([true, undefined])("keeps an unknown outcome on the current view without recovery/replay (attempted: %s)", async windowAttempted => {
    const f = child({ ...opened, ok: false, opened: [], code: "terminal_window_failed", windowAttempted,
      error: "Terminal window status is unknown. Inspect the desktop before retrying." }, 1);
    let recoveries = 0;
    await expect(openWithRecovery("rig:team", "http://localhost:7433", f.entry, undefined, () => { recoveries++; }))
      .rejects.toThrow("Inspect the desktop before retrying");
    expect(recoveries).toBe(0);
    expect(f.calls()).toHaveLength(1);
  });

  it("runs the installed CLI once with the selected daemon, unchanged view and preview", async () => {
    const f = child(opened);
    expect(await openTerminalInWindow("saved:team with spaces", "http://selected.example:7439", f.entry, "preview-42")).toEqual(opened);
    expect(f.calls()).toEqual([{ url: "http://selected.example:7439", args: ["terminal", "open", "--window", "--json", "--expected-plan", "preview-42", "--", "saved:team with spaces"] }]);
  });

  it("accepts a confirmed reused workspace without new tiles, preserving partial-state notes", async () => {
    const reused = { ...opened, provider: "herdr", opened: [], pages: 0,
      reusedWorkspace: { id: "existing", tabId: "first", view: "kernel" },
      absent: [{ seat: "operator", reason: "stopped" }],
      notes: ["Check the new terminal shows the intended view."],
    };
    const f = child(reused);
    let recoveries = 0;
    expect(await openTerminalInWindow("saved:kernel", "http://localhost:7433", f.entry, undefined, () => { recoveries++; })).toEqual(reused);
    expect(f.calls()).toHaveLength(1);
    expect(recoveries).toBe(0);
    const notice = terminalWindowNotice("saved:kernel", reused);
    expect(notice).toContain("Reused Herdr workspace existing");
    expect(notice).toContain("0 tiles prepared; 1 absent");
    expect(notice).toContain("Absent: operator — stopped");
    expect(notice).toContain(reused.notes[0]);
  });

  it.each(["unconfirmed", "nonzero exit"])("does not accept reused-workspace metadata after %s", async kind => {
    const f = child({ ...opened, ok: kind !== "unconfirmed", opened: [], pages: 0,
      reusedWorkspace: { id: "existing", tabId: "first", view: "kernel" },
    }, kind === "nonzero exit" ? 1 : 0);
    await expect(openTerminalInWindow("saved:kernel", "http://localhost:7433", f.entry)).rejects.toThrow();
    expect(f.calls()).toHaveLength(1);
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
