import { describe, expect, it } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { probeSessionActivity, readInputBox, readSeatBeforePaste } from "../src/domain/session-transport.js";

// A reporter's idle Codex 0.170.0 seat, verbatim from its `tmux capture-pane -p` and `rig capture` (identical from the
// completion row down). Its status line is the person's own `/statusline` choice (model, approval mode, context, weekly
// limit, version), so the row has no `~/path` segment; Codex 0.170.0's default is model, current dir and thread name
// (codex-rs/tui/src/chatwidget.rs DEFAULT_STATUS_LINE_ITEMS).
const REPORTER_IDLE_0170 = [
  "  Worked for 5m 15s • 7:12 PM",
  "",
  "",
  "› Ask Codex to do anything",
  "",
  "  GPT-6.2-Sol xhigh · Approve for me · Context 72% used · weekly 31% left · 0.170.0",
  "  ← for agents · ? for shortcuts                                                             ⚠ 2 warnings · f2 to view",
  "",
];

// Codex 0.170.0's exec approval as its own render test draws it (bottom_pane approval_overlay network_exec_prompt
// snapshot): the choices replace the input box, so no status line or hint row is drawn under them.
const APPROVAL_0170 = [
  "  Worked for 5m 15s • 7:12 PM",
  "",
  "  Do you want to approve network access to \"example.com\"?",
  "",
  "  Reason: network request blocked",
  "",
  "› 1. Yes, just this once (y)",
  "  2. Yes, and allow this host for this conversation (a)",
  "  3. Yes, and allow this host in the future (p)",
  "  4. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];

function probe(pane: string) {
  const tmux = { readPaneLastActivity: async () => null, hasSession: async () => true, capturePaneContent: async () => pane } as unknown as TmuxAdapter;
  return probeSessionActivity({ sessionName: "worker@rig", runtime: "codex", attachmentType: "tmux", tmuxAdapter: tmux, now: new Date(0) });
}

describe("a Codex status line the person configured", () => {
  it("reads the reporter's idle 0.170.0 seat as idle before a send", () => {
    expect(readSeatBeforePaste(REPORTER_IDLE_0170.join("\n"), "codex")).toBe("idle");
  });

  it("reads a draft in the box above that status line", () => {
    const pane = REPORTER_IDLE_0170.map((row) => row === "› Ask Codex to do anything" ? "› fix the failing test" : row);
    expect(readInputBox(pane.join("\n"), "codex", "fix the failing test")).toBe("exact");
  });

  it("still reads a one-item status line with no path as unknown", () => {
    const pane = REPORTER_IDLE_0170.map((row) => row.startsWith("  GPT-6.2-Sol") ? "  GPT-6.2-Sol xhigh" : row);
    expect(readSeatBeforePaste(pane.join("\n"), "codex")).toBe("unknown");
  });

  it("reads a running turn over the same footer as not idle", () => {
    const pane = REPORTER_IDLE_0170.map((row) => row.startsWith("  Worked for") ? "• Working (12s • esc to interrupt)" : row);
    expect(readSeatBeforePaste(pane.join("\n"), "codex")).toBe("not-idle");
  });

  it("finds no permission prompt on the idle seat, so a pending request clears", async () => {
    const activity = await probe(REPORTER_IDLE_0170.join("\n"));
    expect(activity.state).toBe("idle");
  });

  it("still reads Codex 0.170.0's approval as a prompt waiting on the person", async () => {
    const activity = await probe(APPROVAL_0170.join("\n"));
    expect(activity.state).toBe("needs_input");
    expect(["permission_prompt", "selection_prompt"]).toContain(activity.reason);
    expect(readSeatBeforePaste(APPROVAL_0170.join("\n"), "codex")).not.toBe("idle");
  });
});
