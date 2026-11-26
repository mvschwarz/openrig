import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { exitPaneRuntime } from "../src/domain/runtime-exit.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { codexTwoRowComposer } from "./fixtures/codex-two-row-composer.js";
import { Pane, codex, codexPane, codexTwoRowComposerAt, timing } from "./fixtures/runtime-exit-pane.js";

// #3901 (X-F1): Codex's typed /exit is checked again at the input boundary itself, inside the real adapter's sendText
// (beforePaste: after the paste buffer is loaded, right before the paste) and sendKeys (beforeKeys: right before Enter).
// The adapter here is the real TmuxAdapter; only tmux, `kill` and the screen are scripted.

/** Codex showing a command approval in place of its input box. */
const approval: ComposerSnapshot = {
  screen: ["› Earlier request", "", "Would you like to run the following command?", "", "  $ rm -rf build", "",
    "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel", ""].join("\n"),
  cursor: { x: 0, y: 6, width: 60, height: 11 }, inMode: false,
};

function adapterFor(pane: Pane, script: { onLoadBuffer?: () => void; afterReadBack?: () => void } = {}) {
  // `kill -SIG pid`, as signalPid runs it: Codex ends on any signal.
  const shell = vi.fn(async (command: string) => {
    const [, signal, pid] = /^kill -(\w+) (\d+)$/.exec(command) ?? [];
    pane.effects.push(`${signal} ${pid}`);
    pane.runtimeGone(Number(pid));
    return "";
  });
  const tmux = vi.fn(async (argv: string[]) => {
    const verb = argv[1];
    if (verb === "load-buffer") { pane.effects.push("load-buffer"); script.onLoadBuffer?.(); return ""; }
    if (verb === "paste-buffer") {
      pane.effects.push("paste-buffer");
      pane.composer = codexTwoRowComposerAt("/exit");
      return "";
    }
    if (verb === "delete-buffer") { pane.effects.push("delete-buffer"); return ""; }
    if (verb === "send-keys") {
      pane.effects.push(`send-keys ${argv.slice(4).join(" ")}`);
      if (argv.includes("Enter") && pane.rows.some((row) => row.pid === codex.pid)) pane.runtimeGone(codex.pid);
      return "";
    }
    if (verb === "display-message") {
      const format = argv.at(-1);
      if (format === "#{pane_pid}") return `${pane.panePid}\n`;
      if (format?.startsWith("#{session_id}")) return `$1|4000|1764061200|${pane.session}\n`;
    }
    throw new Error(`unexpected tmux ${argv.join(" ")}`);
  });
  const files: TmuxFileOps = { tmpName: () => "/tmp/openrig-test-exit", bufferName: () => "openrig-test-exit", writeFile: async () => {}, unlink: async () => {} };
  const adapter = new TmuxAdapter(shell, files, tmux);
  let readBack = false;
  vi.spyOn(adapter, "captureComposerSnapshot").mockImplementation(async () => {
    const frame = pane.composer;
    // The first read that shows the typed /exit is the read-back; what changes after it is only seen at the boundary.
    if (!readBack && pane.effects.includes("paste-buffer")) { readBack = true; script.afterReadBack?.(); }
    return frame;
  });
  return adapter;
}

const exit = (pane: Pane, adapter: TmuxAdapter) =>
  exitPaneRuntime(adapter, { pane: "%1", inputTarget: "%1", runtime: "codex" }, timing, pane.list);

describe("Codex's typed /exit is checked again at the input boundary (#3901)", () => {
  it("still types /exit and presses Enter through the real adapter when nothing changes", async () => {
    const pane = codexPane();
    const outcome = await exit(pane, adapterFor(pane));
    expect(outcome).toMatchObject({ state: "exited", path: "graceful" });
    expect(pane.effects).toEqual(["load-buffer", "paste-buffer", "send-keys Enter"]);
  });

  it("a draft typed while the paste buffer loads isn't typed over: nothing is pasted, the buffer is removed, and Codex is ended with TERM", async () => {
    const pane = codexPane();
    const adapter = adapterFor(pane, { onLoadBuffer: () => { pane.composer = codexTwoRowComposer("a late draft"); } });
    const outcome = await exit(pane, adapter);
    expect(pane.effects).toEqual(["load-buffer", "delete-buffer", "TERM 300"]);
    expect(outcome).toEqual({ state: "exited", path: "forced", detail: "Codex was ended with TERM, which doesn't run its own shutdown, "
      + "because /exit couldn't be used: its input box held text just before /exit was typed." });
  });

  it("an agent replaced while the paste buffer loads gets nothing typed", async () => {
    const pane = codexPane();
    // Codex exits and another process takes its pid (another start time).
    const adapter = adapterFor(pane, { onLoadBuffer: () => {
      pane.rows = pane.rows.map((row) => row.pid === codex.pid ? { ...row, startedAt: "Wed Nov 25 09:00:59 2026" } : row);
    } });
    const outcome = await exit(pane, adapter);
    expect(pane.effects).toEqual(["load-buffer", "delete-buffer"]);
    expect(pane.effects).not.toContain("paste-buffer");
    // The observed Codex is gone; nothing reached the new process either.
    expect(outcome).toEqual({ state: "exited", path: "graceful", detail: "Codex exited by itself before it was signalled." });
  });

  it("a prompt that opens after the read-back gets no Enter: Codex is ended with TERM, reported forced", async () => {
    const pane = codexPane();
    const adapter = adapterFor(pane, { afterReadBack: () => { pane.composer = approval; } });
    const outcome = await exit(pane, adapter);
    expect(pane.effects).toEqual(["load-buffer", "paste-buffer", "TERM 300"]);
    expect(outcome).toEqual({ state: "exited", path: "forced", detail: "Codex was ended with TERM, which doesn't run its own shutdown, "
      + "because /exit couldn't be used: it was showing a prompt just before Enter." });
  });

  it("an agent replaced after the read-back gets no Enter", async () => {
    const pane = codexPane();
    const adapter = adapterFor(pane, { afterReadBack: () => {
      pane.rows = pane.rows.map((row) => row.pid === codex.pid ? { ...row, startedAt: "Wed Nov 25 09:00:59 2026" } : row);
    } });
    const outcome = await exit(pane, adapter);
    expect(pane.effects).toEqual(["load-buffer", "paste-buffer"]);
    expect(outcome).toEqual({ state: "exited", path: "graceful", detail: "Codex exited by itself before it was signalled." });
  });
});
