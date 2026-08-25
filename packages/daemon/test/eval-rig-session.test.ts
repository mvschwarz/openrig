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

/** A fake round-6 current-generation record reader over a mutable state cell: the injected reader
 *  returns the CURRENT { generationId, content }, so a test can grow `content` (append-only) or roll
 *  `generationId` (a re-prime) between reads to exercise the boundary and the generation tripwire. */
function genReader(state: { generationId: string; content: string }): (seat: string) => Promise<{ generationId: string; content: string }> {
  return async () => ({ generationId: state.generationId, content: state.content });
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

// Harness-correction atom (door disposition qitem-20260825080716-ad2422ab; frozen criteria sha
// b0a426fc...). dev-qa's real Test-A run was INDETERMINATE: the capture is not Claude-JSONL-schema-aware
// — it treats the conversation record as an opaque string. These RED-FIRST discriminators pin the three
// required properties against the CURRENT string-based captureSince; the fix must parse the JSONL
// (messages: {type,message:{role,model,content:[{type:"text",text}],stop_reason}}) and (1) return only
// after the current assistant turn COMPLETES (terminal stop_reason), (2) grade assistant/tool output
// ONLY (exclude the user prompt + envelope), (3) never grade an earlier turn / footer-only fragment.
describe("captureSince — Claude-JSONL output-only + native-turn completion (RED-first, harness correction)", () => {
  const userMsg = (text: string) => `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
  const asstMsg = (text: string, stop: string | null) => `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":${JSON.stringify(stop)},"content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;

  async function driveOne(seed: string, promptText: string, appendOnSend: string, growTo?: string) {
    const state = { generationId: "g1", content: seed };
    let sent = false;
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + appendOnSend; return "sent"; }
      return undefined;
    });
    const reader = async () => {
      const out = { generationId: state.generationId, content: state.content };
      if (sent && growTo && !state.content.includes(growTo)) state.content = state.content + growTo;
      return out;
    };
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, timeoutMs: 200, sleep: async () => {}, readGenerationRecord: reader }).spawn();
    await session.sendPrompt(promptText);
    return { session, calls };
  }

  it("OUTPUT-ONLY (input-echo-negative gate): grades assistant text only, EXCLUDES the user prompt + JSON envelope [GREEN — JSONL-aware fix]", async () => {
    const { session } = await driveOne(
      userMsg("earlier turn") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n",
      asstMsg("rig context get skills/core/rig-lifecycle", "end_turn") + "\n",
    );
    const since = await session.captureSince("the case prompt");
    expect(since).toContain("rig context get skills/core/rig-lifecycle"); // assistant output kept
    expect(since).not.toContain("the case prompt");                       // the user prompt is not graded
    expect(since).not.toContain('"role":"user"');                          // no user-message envelope
    expect(since).not.toContain('"role":"assistant"');                     // no assistant-message envelope either — TEXT only
    expect(since).not.toContain('stop_reason');                            // no transport/reply envelope
  });

  it("NATIVE-TURN COMPLETION: does NOT return on a footer-only / stop_reason:null fragment while the turn is still open [GREEN — JSONL-aware fix]", async () => {
    // The assistant message is present but INCOMPLETE (stop_reason null) and the content goes stable —
    // the string-based captureSince returns it; a turn-aware capture must keep waiting (then time out
    // here, since this fixture never completes). Returning early is the 80-byte-footer-mid-generation bug.
    const { session } = await driveOne(
      userMsg("earlier") + "\n",
      "p",
      userMsg("p") + "\n" + asstMsg("partial…", null) + "\n",
      undefined,
    );
    await expect(session.captureSince("p")).rejects.toThrow(/did not go stable|did not complete/);
  });

  it("SUCCESSIVE-TURN SEPARATION: case 2's capture returns case-2 output, never case-1's completed turn", async () => {
    const state = { generationId: "g1", content: userMsg("older") + "\n" + asstMsg("case ONE output", "end_turn") + "\n" };
    let n = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { const which = n++ === 0 ? "prompt-1" : "prompt-2"; state.content = state.content + userMsg(which) + "\n" + asstMsg(`case TWO output ${which}`, "end_turn") + "\n"; return "sent"; }
      return undefined;
    });
    const reader = async () => ({ generationId: state.generationId, content: state.content });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, timeoutMs: 200, sleep: async () => {}, readGenerationRecord: reader }).spawn();
    await session.sendPrompt("prompt-1");
    await session.captureSince("prompt-1");
    await session.sendPrompt("prompt-2");
    const c2 = await session.captureSince("prompt-2");
    expect(c2).toContain("case TWO output prompt-2");
    expect(c2).not.toContain("case ONE output");     // never the earlier completed turn
    expect(c2).not.toContain("case TWO output prompt-1");
  });

  // Desk custody ruling qitem-20260825082034-6fa281f1 — pins 4-5, same RED-first set, criteria
  // untouched: both mechanically enforce the frozen no-intervening-input custody rule.
  it("PIN 4 — INTERVENING-INPUT FAIL-CLOSED: an extra user-role TEXT record entering the generation between prompt delivery and native-turn completion voids the CASE, loudly [GREEN — JSONL-aware fix]", async () => {
    // The contamination shape from the voided run: the seat followed an actionable reply hint and a
    // second user turn landed in its own generation. Detection, not prevention — the harness must
    // refuse to grade this case (one case lost, not a full run), never return gradable text.
    const { session } = await driveOne(
      userMsg("earlier turn") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n",
      userMsg("self-sent reply-hint contamination") + "\n" + asstMsg("answer text", "end_turn") + "\n",
    );
    await expect(session.captureSince("the case prompt")).rejects.toThrow(/CASE INVALID|intervening user input/i);
  });

  it("PIN 5 — ENVELOPE NEUTRALIZATION: probe delivery suppresses the message envelope, so no actionable reply hint reaches the blank seat [GREEN — raw-send fix]", async () => {
    // The frozen criteria's probes are answered in place; a From/To envelope with a reply hint is
    // harness leakage that INVITES the transport act pin 4 then has to catch. Probe sends go raw.
    const { calls } = await driveOne(
      userMsg("earlier") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n",
      asstMsg("answer", "end_turn") + "\n",
    );
    const sends = calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "--raw", "s@r", "the case prompt"]]);
  });

  it("TOOL-CYCLE: a multi-step turn (assistant tool_use -> tool_result -> assistant end_turn) is captured WHOLE, and the tool_result record never trips the intervening-input gate", async () => {
    // The runtime writes tool_result records with role "user" — they are the assistant's own tool
    // cycle in progress, not an intervening input; and stop_reason "tool_use" is NOT terminal, so
    // the capture must keep waiting for the closing assistant message and return the whole turn.
    const toolUse = `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","input":{"command":"rig context get skills/core/rig-lifecycle"}}]}}`;
    const toolResult = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"served 1618 tokens"}]}}`;
    const { session } = await driveOne(
      userMsg("earlier turn") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n" + toolUse + "\n",
      toolResult + "\n" + asstMsg("done: the lifecycle entry is served", "end_turn") + "\n",
    );
    const since = await session.captureSince("the case prompt");
    expect(since).toContain("rig context get skills/core/rig-lifecycle"); // the tool command the DOOR grader matches
    expect(since).toContain("done: the lifecycle entry is served");        // the whole turn, not the pre-tool fragment
    expect(since).not.toContain("tool_result");                            // no envelope
    expect(since).not.toContain("the case prompt");                        // still output-only
  });
});

describe("createRigCliSession — spawn/attach, polling, retirement", () => {
  it("CUSTODY (Test-A no-intervening-input, round 6): sendPrompt submits EXACTLY ONE rig send — the natural prompt, never a marker", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const session = await createRigCliSession({
      seat: "ops-eval@evalrig", exec,
      readGenerationRecord: genReader({ generationId: "g1", content: "prior record\n" }),
    }).spawn();
    await session.sendPrompt("the natural prompt");
    // The frozen custody contract forbids ANY intervening input between BASELINE and POST. Exactly one
    // submitted send per case, the natural prompt — no eval-sync marker; the boundary read is out-of-band.
    const sends = calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "--raw", "ops-eval@evalrig", "the natural prompt"]]); // raw per PIN 5 — envelope suppressed, still exactly one send
    expect(calls.some((c) => c[0] === "send" && c.slice(1).some((a) => /eval-sync/.test(a ?? "")))).toBe(false);
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

  it("records the pre-send generation record, then captureSince waits for NATIVE-TURN COMPLETION and returns the assistant output of the appended suffix", async () => {
    const state = { generationId: "g1", content: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"prior record line"}]}}\n' };
    let sent = false;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"the natural prompt"}]}}\n'; return "sent"; }
      return undefined;
    });
    // The append-only record grows across reads: the seat appends its completed turn.
    const readGenerationRecord = async () => {
      const out = { generationId: state.generationId, content: state.content };
      if (sent && !state.content.includes("DONE")) state.content = state.content + '{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"DONE rig context get skills/x"}]}}\n';
      return out;
    };
    const session = await createRigCliSession({ seat: "ops-eval@evalrig", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("the natural prompt");
    const since = await session.captureSince("the natural prompt");
    expect(since).toContain("DONE rig context get skills/x");
    expect(since).not.toContain("prior record line"); // pre-send content is the sliced-off prefix, not the turn
  });

  it("a seat that never goes stable times out as an ERROR, never a silent partial", async () => {
    const state = { generationId: "g1", content: "x\n" };
    let n = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const readGenerationRecord = async () => { state.content = state.content + `line ${n++}\n`; return { generationId: state.generationId, content: state.content }; }; // always growing, same generation
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 30, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/did not go stable/);
  });

  it("TRANSIENT record-read failures are tolerated — a lag-slow daemon's timeout retries, not errors the case", async () => {
    const state = { generationId: "g1", content: "idle\n" };
    let sent = false;
    let readCall = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + "> the prompt\n"; return "sent"; }
      return undefined;
    });
    const readGenerationRecord = async () => {
      readCall++;
      // sendPrompt's read is #1; fail a couple of capture polls transiently, then complete the turn
      if (readCall === 2 || readCall === 3) throw new Error("Daemon did not respond in time");
      if (sent && !state.content.includes("DONE")) state.content = state.content + '{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"DONE rig context get skills/x"}]}}\n';
      return { generationId: state.generationId, content: state.content };
    };
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("the prompt");
    const since = await session.captureSince("the prompt");
    expect(since).toContain("DONE rig context get skills/x");
  });

  it("SUSTAINED record-read failure IS a dead daemon — surfaces loud after the consecutive bound", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    let first = true;
    const readGenerationRecord = async () => { if (first) { first = false; return { generationId: "g1", content: "seed\n" }; } throw new Error("Daemon did not respond in time"); };
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 60_000, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/consecutive generation-record read failures|unresponsive/);
  });

  it("GENERATION-CHANGE TRIPWIRE (desk ruling constraint 3): a mid-observation re-prime fails loud, never reads across the swap", async () => {
    const state = { generationId: "g1", content: "gen-1 record\n" };
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { state.content = state.content + "> p\n"; return "sent"; }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord: genReader(state) }).spawn();
    await session.sendPrompt("p"); // binds generation g1
    // a re-prime rolls the generation and starts a NEW record mid-observation
    state.generationId = "g2";
    state.content = "gen-2 fresh record\n";
    await expect(session.captureSince("p")).rejects.toThrow(/generation changed mid-observation/);
  });

  it("SESSION-LIFETIME generation binding (r2 round-7 HIGH-1): a re-prime BETWEEN cases refuses before the second send, never re-binds", async () => {
    const state = { generationId: "g1", content: "gen-1 record\n" };
    let n = 0;
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { state.content = state.content + `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(args[3])}}]}}\n{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"completed ${n++}"}]}}\n`; return "sent"; }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord: genReader(state) }).spawn();
    // case 1 binds the session generation g1
    await session.sendPrompt("case-1");
    expect(await session.captureSince("case-1")).toContain("completed");
    // a re-prime rolls the generation BETWEEN cases (a new native session/JSONL)
    state.generationId = "g2";
    state.content = "gen-2 fresh record\n";
    // case 2 must refuse BEFORE the send — the session binding is g1 and is never overwritten
    await expect(session.sendPrompt("case-2")).rejects.toThrow(/generation changed BETWEEN cases/);
    expect(calls.filter((c) => c[0] === "send").map((c) => c[3])).toEqual(["case-1"]); // argv: send --raw <seat> <prompt>
  });

  it("LOUD REFUSAL (constraint 2): no generation-record reader wired -> sendPrompt refuses, never falls back to the pane", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, sleep: async () => {} }).spawn(); // no readGenerationRecord
    await expect(session.sendPrompt("p")).rejects.toThrow(/requires readGenerationRecord/);
  });

  it("LOUD REFUSAL (constraint 2): an unsupported runtime (reader throws) propagates loud, never a silent degrade", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const readGenerationRecord = async () => { throw new Error("seat is a codex seat with no Claude generation JSONL — observation refused"); };
    const session = await createRigCliSession({ seat: "s@r", exec, sleep: async () => {}, readGenerationRecord }).spawn();
    await expect(session.sendPrompt("p")).rejects.toThrow(/no Claude generation JSONL|observation refused/);
  });
});
