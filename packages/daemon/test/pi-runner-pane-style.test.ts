// Hermetic tests for the pane's status row and text emphasis: what a seat shows about
// itself, and how the runner's own lines are marked. No live pi.

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import {
  createPaneCompositor, mapPiEvent, paneStyles, RunnerCore, type RunnerIo,
} from "../src/adapters/pi-runner.js";

function paneOut(columns: number | null = 40) {
  let buf = "";
  const output = Object.assign(new PassThrough(), typeof columns === "number" ? { isTTY: true, columns } : {});
  output.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { output: output as unknown as NodeJS.WriteStream, text: () => buf };
}

const GET_STATE = "pi-runner-get-state";

describe("pane styles", () => {
  it("is the identity when disabled", () => {
    const style = paneStyles(false);
    expect(style.bold("x")).toBe("x");
    expect(style.dim("x")).toBe("x");
    expect(style.commit("you ▸")).toBe("you ▸");
    expect(style.failed("FAILED")).toBe("FAILED");
  });

  it("uses SGR emphasis when enabled", () => {
    const style = paneStyles(true);
    expect(style.bold("x")).toBe("\u001b[1mx\u001b[0m");
    expect(style.dim("x")).toBe("\u001b[2mx\u001b[0m");
    expect(style.commit("you ▸")).toBe("\u001b[1;36myou ▸\u001b[0m");
    expect(style.failed("FAILED")).toBe("\u001b[1;31mFAILED\u001b[0m");
  });
});

describe("styled tool lines", () => {
  it("dims a running tool and marks a failed one", () => {
    const style = paneStyles(true);
    const running = mapPiEvent({ type: "tool_execution_start", toolName: "Bash" }, "pi", style);
    expect(running.mirrorLines[0]).toBe("  \u001b[2m⚙ Bash …\u001b[0m");
    const failed = mapPiEvent({ type: "tool_execution_end", toolName: "Bash", isError: true }, "pi", style);
    expect(failed.mirrorLines[0]).toBe("  \u001b[2m⚙ Bash\u001b[0m \u001b[1;31mFAILED\u001b[0m");
    const done = mapPiEvent({ type: "tool_execution_end", toolName: "Bash" }, "pi", style);
    expect(done.mirrorLines[0]).toBe("  \u001b[2m⚙ Bash\u001b[0m done");
  });

  it("keeps the same words in plain output, so a log reads the same without colour", () => {
    const plain = paneStyles(false);
    expect(mapPiEvent({ type: "tool_execution_start", toolName: "Bash" }, "pi", plain).mirrorLines[0]).toBe("  ⚙ Bash …");
    expect(mapPiEvent({ type: "tool_execution_end", toolName: "Bash", isError: true }, "pi", plain).mirrorLines[0])
      .toBe("  ⚙ Bash FAILED");
    expect(mapPiEvent({ type: "tool_execution_end", toolName: "Bash" }, "pi", plain).mirrorLines[0]).toBe("  ⚙ Bash done");
  });

  it("never colours model output", () => {
    const styled = mapPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "plain words" },
    }, "pi", paneStyles(true));
    expect(styled.mirrorAppend).toBe("plain words");
  });
});

describe("pane status row", () => {
  function seat(options: { model?: string; thinking?: string; style?: ReturnType<typeof paneStyles> } = {}) {
    const statuses: string[] = [];
    const mirrored: string[] = [];
    const io: RunnerIo = {
      sendRpc: () => {},
      mirrorLine: (line) => mirrored.push(line),
      mirrorAppend: () => {},
      diagnostic: () => {},
      clearStatus: () => {},
      status: (text) => statuses.push(text),
      postActivity: () => {},
      writeSidecar: () => {},
      now: () => "2026-11-13T00:00:00Z",
    };
    const core = new RunnerCore(io, { sessionName: "seat-a@some-rig", nodeId: "node-1", launchId: "launch-1" }, options);
    core.start();
    const ready = () => core.handlePiLine(JSON.stringify({
      type: "response", id: GET_STATE,
      data: { sessionFile: "/state/pi/seat-a/sessions/2026_0197.jsonl", sessionId: "0197a2f0" },
    }));
    return { core, statuses, mirrored, ready };
  }

  it("says starting until the seat is ready, naming the configured model and effort", () => {
    const { statuses } = seat({ model: "seat-lead", thinking: "high" });
    expect(statuses.at(-1)).toBe("seat-lead · thinking:high · starting");
  });

  it("shows what is known and only what is known", () => {
    const { statuses, ready } = seat({ model: "seat-lead" });
    ready();
    expect(statuses.at(-1)).toBe("seat-lead · idle");
  });

  it("omits a model and effort the launch did not name instead of inventing one", () => {
    const { statuses, ready } = seat();
    ready();
    expect(statuses.at(-1)).toBe("idle");
  });

  it("follows the working state", () => {
    const { core, statuses, ready } = seat({ model: "seat-lead", thinking: "high" });
    ready();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    expect(statuses.at(-1)).toBe("seat-lead · thinking:high · working");
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(statuses.at(-1)).toBe("seat-lead · thinking:high · idle");
  });

  it("reports a turn that failed as error, and does not turn it into idle at agent_end", () => {
    const { core, statuses, ready } = seat({ model: "seat-lead" });
    ready();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" },
    }));
    // A known failure outranks the still-open turn, and never reads as idle.
    expect(statuses.at(-1)).toBe("seat-lead · error");
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(statuses.at(-1)).toBe("seat-lead · error");
  });

  it("reports a seat waiting on the operator as waiting for input, not idle", () => {
    const { core, statuses, ready } = seat({ model: "seat-lead" });
    ready();
    core.handlePiLine(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick one" }));
    expect(statuses.at(-1)).toBe("seat-lead · waiting for input");
  });

  it("reports a refused get_state as error, not starting", () => {
    const { core, statuses } = seat({ model: "seat-lead" });
    core.handlePiLine(JSON.stringify({ type: "response", id: GET_STATE, success: false, error: "no session" }));
    expect(statuses.at(-1)).toBe("seat-lead · error");
  });

  it("clears a failed turn's error when the next turn opens with turn_start alone", () => {
    const { core, statuses, ready } = seat({ model: "seat-lead" });
    ready();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" },
    }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(statuses.at(-1)).toBe("seat-lead · error");
    core.handlePiLine(JSON.stringify({ type: "turn_start" }));
    expect(statuses.at(-1)).toBe("seat-lead · working");
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(statuses.at(-1)).toBe("seat-lead · idle");
  });

  it("shows an automatic retry as retrying, and the failure when it exhausts", () => {
    const { core, statuses, ready } = seat({ model: "seat-lead" });
    ready();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_start", attempt: 1 }));
    expect(statuses.at(-1)).toBe("seat-lead · retrying");
    core.handlePiLine(JSON.stringify({
      type: "auto_retry_end", success: false, attempt: 1, finalError: "429 rate limited",
    }));
    expect(statuses.at(-1)).toBe("seat-lead · error");
  });

  it("neutralizes terminal controls in the configured labels", () => {
    const { statuses } = seat({ model: "evil\u001b[31mred", thinking: "hi\u0007gh" });
    const row = statuses.at(-1)!;
    expect(row).not.toContain("\u001b");
    expect(row).not.toContain("\u0007");
    expect(row).toContain("evilred");
    expect(row).toContain("thinking:hi gh");
  });

  it("reports a child that exited as exited", () => {
    const { core, statuses, ready } = seat({ model: "seat-lead" });
    ready();
    core.handlePiExit(1);
    expect(statuses.at(-1)).toBe("seat-lead · exited");
  });

  it("keeps the status row and the readiness markers plain", () => {
    const { core, statuses, mirrored, ready } = seat({ model: "seat-lead", style: paneStyles(true) });
    ready();
    expect(statuses.at(-1)).not.toContain("\u001b");
    expect(mirrored.some((line) => line.startsWith("[pi-runner] READY"))).toBe(true);
    expect(mirrored.every((line) => !line.includes("READY") || !line.includes("\u001b"))).toBe(true);
  });
});

describe("compositor status region", () => {
  it("keeps the seat row and the pinned diagnostic on separate rows", () => {
    const out = paneOut(40);
    const pane = createPaneCompositor(out.output);
    pane.status("seat-lead · idle");
    pane.diagnostic("[pi-runner] ERROR rpc: no session");
    expect(out.text()).toContain("seat-lead · idle\n");
    expect(out.text()).toContain("[pi-runner] ERROR rpc: no session\n");
  });

  it("shows an in-progress streamed line while the status row is on screen", () => {
    const out = paneOut(40);
    const pane = createPaneCompositor(out.output);
    pane.status("seat-lead · working");
    pane.transcript("Hello wor");
    expect(out.text()).toContain("Hello wor\n");
    pane.transcript("ld\n");
    expect(out.text().match(/Hello world/g)).toHaveLength(1);
  });

  it("keeps the in-progress line visible above the pinned diagnostic too", () => {
    const out = paneOut(40);
    const pane = createPaneCompositor(out.output);
    pane.diagnostic("[pi-runner] ERROR rpc: no session");
    pane.transcript("partial reply");
    expect(out.text()).toContain("partial reply\n");
  });

  it("drops only the pinned diagnostic on a new turn", () => {
    const out = paneOut(40);
    const pane = createPaneCompositor(out.output);
    pane.status("seat-lead · working");
    pane.diagnostic("latest diagnostic");
    const before = out.text().length;
    pane.clearStatus();
    const after = out.text().slice(before);
    expect(after).not.toContain("latest diagnostic");
    expect(after).toContain("seat-lead · working\n");
  });

  it("clears the seat row with an empty status", () => {
    const out = paneOut(40);
    const pane = createPaneCompositor(out.output);
    pane.status("seat-lead · idle");
    const before = out.text().length;
    pane.status("");
    expect(out.text().slice(before)).not.toContain("seat-lead");
  });

  it("erases every painted status row before writing a transcript line", () => {
    const out = paneOut(40);
    const pane = createPaneCompositor(out.output);
    pane.status("seat-lead · idle");
    pane.diagnostic("latest diagnostic");
    const before = out.text().length;
    pane.line("streamed line");
    const chunk = out.text().slice(before);
    // Two status rows plus the blank row their trailing newlines left the cursor on.
    expect(chunk.split("\u001b[2K").length - 1).toBe(3);
    expect(chunk).toContain("streamed line\n");
  });
});
