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

  // PERMANENT RED (review-r2 round-5 HIGH-1, required before the round-6 replacement): the shipped
  // `rig transcript` is a BOUNDED-OVERWRITE pane snapshot (transcript-rotation.ts overwrites the file
  // each tick, default 1000 trailing lines), NOT append-only. So the pre-send text is not guaranteed
  // a prefix of the post-send text: when an OLD identical command has rotated toward/out of the tail,
  // LCS matches the current turn's re-emission to the older occurrence and DELETES current-turn
  // evidence. This models the real bounded rotation (not an append-only fake) and stays RED until the
  // boundary binds to a source that is actually monotonic for the exact seat generation.
  it.fails("BOUNDED-ROTATION repeated command (r2 HIGH-1): the current-turn command survives — RED until a monotonic boundary source", () => {
    const prompt = "the box rebooted — bring the fleet back";
    const command = "rig context get skills/core/rig-lifecycle";
    const preRotation = `${command}\n`;                 // the older occurrence, still in the bounded tail
    const postRotation = `> ${prompt}\n${command}\n`;   // the current turn re-emits it
    expect(sliceAfterPrompt(postRotation, prompt, preRotation)).toContain(command);
  });

  it("APPEND-ONLY transcript (round-5 custody): an earlier identical command stays in the prefix; the current turn's re-emission is returned from the suffix — no marker needed", () => {
    const prompt = "the box rebooted — bring the fleet back";
    // The transcript APPENDS — the earlier case's identical command line is RETAINED in the pre-send
    // transcript (it never scrolls off), so LCS matches THAT occurrence and the current turn's
    // re-emission is the new suffix. This append-only property is exactly why round-5 needs no in-band
    // marker (round-4's marker was a forbidden second send).
    const preSend = `> ${prompt}\nrig context get skills/core/rig-lifecycle\n`;
    const post = `${preSend}> ${prompt}\nrig context get skills/core/rig-lifecycle\n`;
    const since = sliceAfterPrompt(post, prompt, preSend);
    expect(since).toContain("rig context get skills/core/rig-lifecycle");
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
  it("CUSTODY (Test-A no-intervening-input, round 5): sendPrompt submits EXACTLY ONE rig send — the natural prompt, never a marker", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "capture") return "prior pane\n";       // round-4 boundary source
      if (args[0] === "transcript") return "prior transcript line\n"; // round-5 out-of-band boundary
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const session = await createRigCliSession({ seat: "ops-eval@evalrig", exec }).spawn();
    await session.sendPrompt("the natural prompt");
    // The frozen custody contract forbids ANY intervening input between BASELINE and POST.
    // Exactly one submitted send per case, and it is the natural prompt — no eval-sync marker.
    const sends = calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "ops-eval@evalrig", "the natural prompt"]]);
    expect(calls.some((c) => c[0] === "send" && /eval-sync/.test(c[2] ?? ""))).toBe(false);
  });

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

  it("records the pre-send transcript, then captureSince waits for the transcript to stabilize and slices after the echo", async () => {
    let transcript = "prior transcript line\n";
    let sent = false;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") {
        // the seat records the prompt turn into its APPEND-ONLY transcript
        sent = true;
        transcript = transcript + "> the natural prompt\n";
        return "sent";
      }
      if (args[0] === "transcript") {
        const out = transcript;
        // simulate the seat appending its response across polls, then going quiet
        if (sent && !transcript.includes("DONE")) transcript = transcript + "working...\nDONE rig context get skills/x\n";
        return out;
      }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "ops-eval@evalrig", exec, pollMs: 1, stablePolls: 2, sleep: async () => {} }).spawn();
    await session.sendPrompt("the natural prompt");
    const since = await session.captureSince("the natural prompt");
    expect(since).toContain("DONE rig context get skills/x");
    expect(since).not.toContain("prior transcript line"); // pre-send content is the matched prefix, not the turn
  });

  it("a seat that never goes stable times out as an ERROR, never a silent partial", async () => {
    let n = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      if (args[0] === "transcript") return `always changing ${n++}\n`;
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 30, sleep: async () => {} }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/did not go stable/);
  });

  it("TRANSIENT transcript-read failures are tolerated — a lag-slow daemon's 5s timeout retries, not errors the case", async () => {
    let transcript = "idle\n";
    let sent = false;
    let readCall = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; transcript = transcript + "> the prompt\n"; return "sent"; }
      if (args[0] === "transcript") {
        readCall++;
        // fail a couple of polls transiently (daemon lag), then succeed + go stable
        if (readCall === 3 || readCall === 4) throw new Error("Daemon did not respond in time");
        if (sent && !transcript.includes("DONE")) transcript = transcript + "DONE rig context get skills/x\n";
        return transcript;
      }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {} }).spawn();
    await session.sendPrompt("the prompt");
    const since = await session.captureSince("the prompt");
    expect(since).toContain("DONE rig context get skills/x");
  });

  it("SUSTAINED transcript-read failure IS a dead daemon — surfaces loud after the consecutive bound", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      if (args[0] === "transcript") throw new Error("Daemon did not respond in time");
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 60_000, sleep: async () => {} }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/consecutive transcript-read failures|unresponsive/);
  });
});
