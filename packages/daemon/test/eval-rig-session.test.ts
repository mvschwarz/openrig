// Test-A preflight blocker 3 (row testa-provider) — pins for the CLI-backed
// RigSeatSession behind `run-evals.mjs --provider rig`. The exec boundary is
// injected, so these pin the MECHANICS (spawn/attach identity, capture-since
// anchoring across pane wrapping and truncation, stability polling, timeout,
// retire-only-when-spawned) without a daemon; the live leg is the frozen
// command run by the non-author.

import { describe, it, expect, vi } from "vitest";
import { createRigCliSession, sliceAfterPrompt, type RigExec } from "./helpers/eval-rig-session.js";

const WHOAMI = JSON.stringify({ session: "ops-eval@evalrig", occupantGeneration: "gen-1234", nodeId: "01NODE" });
const UP = JSON.stringify({ status: "completed", rigId: "01RIG", attachCommand: "tmux attach -t ops-eval@evalrig" });

function scriptedExec(script: (args: string[]) => string | undefined): { exec: RigExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: RigExec = async (args) => {
    calls.push(args);
    const out = script(args);
    if (out === undefined) throw new Error(`unscripted exec: ${args.join(" ")}`);
    return out;
  };
  return { exec, calls };
}

describe("sliceAfterPrompt — the since-the-prompt anchor", () => {
  it("wrapped echo: the prompt broken across pane lines still anchors, output follows", () => {
    const prompt = "What can I do here in this world?";
    const capture = "old scroll\n> What can I do\nhere in this world?\nI will check rig context profile now.\n";
    const since = sliceAfterPrompt(capture, prompt, "old scroll\n");
    expect(since).toContain("I will check rig context profile now.");
    expect(since).not.toContain("old scroll");
  });

  it("truncated echo: a TUI-elided prompt anchors on the prompt head", () => {
    const prompt = "What can I do here in this world? Please be thorough about it.";
    const capture = "> What can I do here in th…\nrunning rig context get now\n";
    expect(sliceAfterPrompt(capture, prompt, "")).toBe("running rig context get now\n");
  });

  it("REPEATED prompt (r2 QA finding 1): the SAME prompt from an earlier case does NOT leak its response into the current one", () => {
    // The real corpus repeats prompts across loading.yaml + selection.yaml. The
    // earlier case's response contained `rig context get`; the current case did
    // NOT pull context. Anchoring on the current SEND boundary must return only
    // the current response.
    const prompt = "the box rebooted and everything's gone — bring the whole fleet back";
    const earlier = `> ${prompt}\nI ran rig context get skills/core/rig-lifecycle first.\n`;
    const preSend = earlier; // the pane BEFORE the current send holds the earlier case
    const rawCapture = earlier + `> ${prompt}\nI'll just restart it directly, no context needed.\n`;
    const since = sliceAfterPrompt(rawCapture, prompt, preSend);
    expect(since).toContain("no context needed");
    expect(since).not.toContain("rig context get");
  });

  it("REDRAWN footer (r2 QA finding, redraw residual): a repeated input/status footer at the bottom is NOT the boundary; the response is retained", () => {
    // Interactive TUIs REDRAW their footer rather than preserving it as history.
    // The pre-send footer reappears at the bottom of the post-send capture; a
    // lastIndexOf(footer) boundary would skip past NEW RESPONSE. LCS-diff keeps it.
    const prompt = "What can I do here?";
    const footer = "────────\n> \n  esc to interrupt · gpt-5.6\n";
    const preSend = `prior scrollback line\n${footer}`;
    const rawCapture = `prior scrollback line\n> ${prompt}\nNEW RESPONSE: rig context get skills/x\n${footer}`;
    const since = sliceAfterPrompt(rawCapture, prompt, preSend);
    expect(since).toContain("NEW RESPONSE: rig context get skills/x");
    expect(since).not.toBe("");
  });

  it("BOUNDED-SCROLL identity (r2 QA finding): an OLD identical command scrolled out, the current turn re-emits it — the MARKER keeps it, LCS-alone would delete it", () => {
    const prompt = "the box rebooted — bring the fleet back";
    const marker = "eval-sync-NONCE1";
    // pre-send still holds the earlier identical command; post-send has scrolled
    // it off the top and shows only the current turn (after the marker echo).
    const preSend = "hist\nrig context get skills/core/rig-lifecycle\n> \n";
    const rawCapture = `${marker}\n> ${prompt}\nrig context get skills/core/rig-lifecycle\n> \n`;
    // WITHOUT the marker, LCS matches the new command to pre's old one -> "".
    expect(sliceAfterPrompt(rawCapture, prompt, preSend)).not.toContain("rig context get");
    // WITH the marker, the current command is retained.
    const since = sliceAfterPrompt(rawCapture, prompt, preSend, marker);
    expect(since).toContain("rig context get skills/core/rig-lifecycle");
  });

  it("marker scrolled out too (turn > window): falls back to the LCS diff, never returns pre-send history", () => {
    const prompt = "what can I do";
    const preSend = "old history line\n";
    const rawCapture = "old history line\n> what can I do\nfresh response here\n"; // no marker visible
    const since = sliceAfterPrompt(rawCapture, prompt, preSend, "eval-sync-GONE");
    expect(since).toContain("fresh response here");
    expect(since).not.toContain("old history line");
  });

  it("scrolled-off echo: falls back to the pre-send snapshot tail", () => {
    const pre = "line a\nline b\nline c\n";
    const capture = "line b\nline c\nfresh output only\n";
    const since = sliceAfterPrompt(capture, "a prompt that is entirely gone", pre);
    expect(since).toContain("fresh output only");
    expect(since).not.toContain("line b");
  });

  it("a LATER genuine quotation stays IN the transcript — the anchor is the FIRST echo occurrence", () => {
    const prompt = "pull the lifecycle entry";
    const capture = '> pull the lifecycle entry\nthinking...\nyou asked "pull the lifecycle entry" so I ran it\n';
    expect(sliceAfterPrompt(capture, prompt, "")).toBe('thinking...\nyou asked "pull the lifecycle entry" so I ran it\n');
  });
});

describe("createRigCliSession — spawn/attach, polling, retirement", () => {
  it("SPAWN: rig up -> adopt the attach session, generation from whoami, retire tears the spawned rig down ONCE", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "up") return UP;
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "down") return "torn down";
      return undefined;
    });
    const session = await createRigCliSession({ spec: "/tmp/eval-rig.yaml", exec }).spawn();
    expect(session.generation).toBe("gen-1234");
    await session.retire();
    // teardown targets the rigId from `rig up` (survives even an unparseable attach line)
    expect(calls.filter((c) => c[0] === "down")).toEqual([["down", "01RIG"]]);
  });

  it("ATTACH: a named seat is verified via whoami and NEVER torn down on retire", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      return undefined;
    });
    const session = await createRigCliSession({ seat: "ops-eval@evalrig", exec }).spawn();
    expect(session.generation).toBe("gen-1234");
    await session.retire();
    expect(calls.some((c) => c[0] === "down")).toBe(false);
  });

  it("CLEANUP on empty identity (r2 QA finding 2): whoami succeeds but yields no generation -> the spawned rig is torn DOWN", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "up") return JSON.stringify({ status: "completed", rigId: "01RIGX", attachCommand: "tmux attach -t p-s@evalx" });
      if (args[0] === "whoami") return JSON.stringify({ resolvedBy: "session", identity: {}, peers: [] }); // no generation
      if (args[0] === "down") return "torn down";
      return undefined;
    });
    await expect(createRigCliSession({ spec: "/tmp/r.yaml", exec }).spawn()).rejects.toThrow(/stable seat generation/);
    expect(calls.filter((c) => c[0] === "down")).toEqual([["down", "01RIGX"]]);
  });

  it("CLEANUP on unparseable attach (r2 QA finding 2): rig up completed but no attach session -> the rig (by rigId) is torn DOWN", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "up") return JSON.stringify({ status: "completed", rigId: "01RIGY", attachCommand: "" }); // no -t session
      if (args[0] === "down") return "torn down";
      return undefined;
    });
    await expect(createRigCliSession({ spec: "/tmp/r.yaml", exec }).spawn()).rejects.toThrow(/did not launch a seat/);
    expect(calls.filter((c) => c[0] === "down")).toEqual([["down", "01RIGY"]]);
  });

  it("exactly one of seat/spec is required, loud", () => {
    expect(() => createRigCliSession({})).toThrow(/exactly ONE/);
    expect(() => createRigCliSession({ seat: "a", spec: "b" })).toThrow(/exactly ONE/);
  });

  it("send snapshots the pane BEFORE typing; captureSince waits for stability then slices after the echo", async () => {
    let pane = "idle prompt box\n";
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") {
        pane = "idle prompt box\n> the natural prompt\n";
        return "sent";
      }
      if (args[0] === "capture") {
        const out = pane;
        // simulate the seat producing output across polls, then going stable
        if (pane.includes("> the natural prompt") && !pane.includes("DONE")) pane = pane + "working...\nDONE rig context get skills/x\n";
        return out;
      }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "ops-eval@evalrig", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, nonce: () => "N1" }).spawn();
    await session.sendPrompt("the natural prompt");
    const since = await session.captureSince("the natural prompt");
    expect(since).toContain("DONE rig context get skills/x");
    expect(since).not.toContain("idle prompt box");
    expect(since).not.toContain("eval-sync-N1"); // the marker is excluded from the graded transcript
  });

  it("a seat that never goes stable times out as an ERROR, never a silent partial", async () => {
    let n = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      if (args[0] === "capture") return `always changing ${n++}\n`;
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 30, sleep: async () => {} }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/did not go stable/);
  });

  it("TRANSIENT capture failures are tolerated — a lag-slow daemon's 5s timeout retries, not errors the case", async () => {
    let pane = "idle\n";
    let captureCall = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { pane = "idle\n> the prompt\n"; return "sent"; }
      if (args[0] === "capture") {
        captureCall++;
        // fail a couple of polls transiently (daemon lag), then succeed + go stable
        if (captureCall === 3 || captureCall === 4) throw new Error("Daemon did not respond in time");
        if (pane.includes("> the prompt") && !pane.includes("DONE")) pane += "DONE rig context get skills/x\n";
        return pane;
      }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {} }).spawn();
    await session.sendPrompt("the prompt");
    const since = await session.captureSince("the prompt");
    expect(since).toContain("DONE rig context get skills/x");
  });

  it("SUSTAINED capture failure IS a dead daemon — surfaces loud after the consecutive bound", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      if (args[0] === "capture") throw new Error("Daemon did not respond in time");
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 60_000, sleep: async () => {} }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/consecutive capture failures|unresponsive/);
  });
});
