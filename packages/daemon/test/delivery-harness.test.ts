// The delivery suite's harness pieces that need no real program: the receiver-side oracle, the containment command,
// the input-box reader, the /proc reader, the bank's export and credential scan, and the logging tmux. The real-program
// cells run from packages/test-system/delivery/run.mjs; these tests keep the parts they rely on honest.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// packages/daemon/test -> packages/test-system/delivery/harness
import { arrivedAs, conversation, deliveriesOf, markersIn, orderAndMerge, partWith, seatThread, sha256, Verdict } from "../../test-system/delivery/harness/oracle.mjs";
import { containedArgv } from "../../test-system/delivery/harness/contain.mjs";
import { composerText } from "../../test-system/delivery/harness/screen.mjs";
import { ownsEnviron, parseStat, reapByIdentity } from "../../test-system/delivery/harness/world.mjs";
import { caseContext } from "../../test-system/delivery/harness/case-context.mjs";
import { isRefusal } from "../../test-system/delivery/cases/s3.mjs";
import { attempt, enterState, expectFor, idsCorrelate, judge, modeChangeControl, occurrenceResult } from "../../test-system/delivery/cases/d18.mjs";
import { runArm } from "../../test-system/delivery/cases/d04.mjs";
import { recordScreen } from "../../test-system/delivery/harness/screen.mjs";
import { bankCell } from "../../test-system/delivery/harness/evidence.mjs";

const HARNESS = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test-system", "delivery", "harness");
const MARK = "DLV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

// Request-log entries shaped as the stand-ins log them, with bodies shaped as the real programs sent them.
const codexMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
// OpenRig's identity prompt, the first turn every seat gets: it anchors the seat's thread.
const IDENTITY_TEXT = "OpenRig-generated identity context (not a project task):\np-seat@dlv\nOpenRig session identity:\n- rig: dlv\n- pod: p";
const identity = () => codexMsg(IDENTITY_TEXT);
const codexAnswer = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
let seq = 0;
const codexReq = (input: unknown[], thread: string | null = "t1", tools = 13) =>
  ({ seq: ++seq, at: new Date(1_800_000_000_000 + seq * 1000).toISOString(), body: { input, tools: Array(tools).fill({}) }, request: { thread, tools, structuredOutput: tools === 0 } });
const claudeReq = (messages: unknown[], thread = "s1") =>
  ({ seq: ++seq, at: new Date(1_800_000_000_000 + seq * 1000).toISOString(), body: { messages }, request: { thread, tools: 13, structuredOutput: false } });

describe("delivery harness: the receiver-side oracle", () => {
  it("counts each message once when Codex re-requests a running turn with the next message added (recorded D09 shape)", () => {
    const start = [codexMsg("<environment_context/>"), identity(), codexAnswer("ok")];
    const [one, two, three] = ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"].map((m) => codexMsg(`Delivery check ${m}`));
    const requests = [
      codexReq([...start]),
      codexReq([...start, one]),
      codexReq([...start, one, two]),        // no answer to `one` in between: the running turn, re-requested
      codexReq([...start, one, two, three]),
    ];
    const seen = ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"].map((m) => deliveriesOf(requests, m).turns);
    expect(seen.map((turns) => turns.length)).toEqual([1, 1, 1]);
    expect(seen.map((turns) => turns[0]!.seq)).toEqual([requests[1]!.seq, requests[2]!.seq, requests[3]!.seq]);
    expect(seen.map((turns) => markersIn(turns[0]!, MARK))).toEqual([["DLV-D09-one-1"], ["DLV-D09-two-2"], ["DLV-D09-three-3"]]);
    expect(seen[0]![0]!.carriedBy).toBe(3);
  });

  it("doesn't count a side request in another thread that quotes the message (Codex's task title)", () => {
    const msg = codexMsg("Delivery check DLV-D01-x-1");
    const requests = [codexReq([identity(), msg]), codexReq([codexMsg("Generate a title for: Delivery check DLV-D01-x-1")], null, 0)];
    expect(seatThread(requests)).toBe("t1");
    expect(deliveriesOf(requests, "DLV-D01-x-1").turns).toHaveLength(1);
  });

  it("counts a message twice when the program really submitted it twice", () => {
    const msg = codexMsg("Delivery check DLV-D01-dup-1");
    const requests = [codexReq([identity(), msg]), codexReq([identity(), msg, codexAnswer("ack"), msg])];
    expect(deliveriesOf(requests, "DLV-D01-dup-1").turns).toHaveLength(2);
  });

  it("counts a retried request once", () => {
    const body = [identity(), codexMsg("Delivery check DLV-D01-retry-1")];
    const requests = [codexReq(body), codexReq(body)];
    expect(deliveriesOf(requests, "DLV-D01-retry-1").turns).toHaveLength(1);
  });

  it("finds a message typed during a tool run beside the tool's result (Claude), and never counts a tool's output", () => {
    const first = { role: "user", content: [{ type: "text", text: IDENTITY_TEXT }, { type: "text", text: "start DLV-D02-first-1" }] };
    const tool = { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] };
    const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "echo DLV-D02-quoted-1" }, { type: "text", text: "now DLV-D02-second-1" }] };
    const requests = [claudeReq([first]), claudeReq([first, tool, result])];
    const second = deliveriesOf(requests, "DLV-D02-second-1").turns;
    expect(second).toHaveLength(1);
    expect(second[0]!.kind).toBe("tool_result");
    expect(deliveriesOf(requests, "DLV-D02-quoted-1").turns).toHaveLength(0);
  });

  it("reads two sends in one item as a merge, and checks the bytes of the part that holds the marker", () => {
    const merged = { role: "user", content: [{ type: "text", text: "a DLV-D09-a-1" }, { type: "text", text: "b DLV-D09-b-2" }] };
    const start = { role: "user", content: [{ type: "text", text: IDENTITY_TEXT }] };
    const [item] = deliveriesOf([claudeReq([start, merged])], "DLV-D09-a-1").turns;
    expect(markersIn(item!, MARK)).toEqual(["DLV-D09-a-1", "DLV-D09-b-2"]);
    expect(partWith(item!, "DLV-D09-b-2", "b DLV-D09-b-2").intact).toBe(true);
    expect(partWith(item!, "DLV-D09-b-2", "b\tDLV-D09-b-2").intact).toBe(false);
    expect(conversation([claudeReq([start, merged])]).items).toHaveLength(2);
  });

  it("finds no conversation, rather than an empty one, when no request carries OpenRig's identity prompt", () => {
    const requests = [codexReq([codexMsg("Delivery check DLV-D01-q-1")])];
    expect(seatThread(requests)).toBeNull();
    expect(conversation(requests)).toMatchObject({ identified: false, items: [] });
    expect(deliveriesOf(requests, "DLV-D01-q-1")).toMatchObject({ identified: false, turns: [] });
  });

  it("leaves the conversation unidentified when two threads carry OpenRig's identity prompt, rather than taking the first", () => {
    const requests = [codexReq([identity(), codexMsg("Delivery check DLV-D01-a-1")], "t1"), codexReq([identity(), codexMsg("Delivery check DLV-D01-a-1")], "t2")];
    expect(seatThread(requests)).toBeNull();
    expect(conversation(requests)).toMatchObject({ identified: false, anchored: ["t1", "t2"] });
  });

  it("never reads a same-thread request without tools, or one asking for a JSON-schema answer, as the conversation", () => {
    // A Claude Code side request can carry the seat's session id with no tools; its history isn't the seat's.
    const start = { role: "user", content: [{ type: "text", text: IDENTITY_TEXT }] };
    const msg = { role: "user", content: [{ type: "text", text: "Delivery check DLV-D01-side-1" }] };
    const side = { ...claudeReq([{ role: "user", content: [{ type: "text", text: "Summarize: Delivery check DLV-D01-side-1 DLV-D01-side-1" }] }]),
      request: { thread: "s1", tools: 0, structuredOutput: false } };
    const schema = { ...claudeReq([start, msg, msg]), request: { thread: "s1", tools: 13, structuredOutput: true } };
    const requests = [claudeReq([start]), claudeReq([start, msg]), side, schema];
    const { turns } = deliveriesOf(requests, "DLV-D01-side-1");
    expect(turns).toHaveLength(1);
    expect(conversation(requests).lastSeq).toBe(requests[1]!.seq);
  });

  it("judges order and merge by the items' positions, so two messages first seen in one request are neither merged nor out of order", () => {
    const start = [identity(), codexAnswer("ok")];
    const [one, two, three] = ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"].map((m) => codexMsg(`Delivery check ${m}`));
    const requests = [codexReq([...start]), codexReq([...start, one]), codexReq([...start, one, two, three])]; // two and three arrive together
    const judged = orderAndMerge(requests, ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"], MARK);
    expect(judged.merged).toEqual([]);
    expect(judged.inOrder).toBe(true);
    expect(judged.first.map((t) => t!.seq)).toEqual([requests[1]!.seq, requests[2]!.seq, requests[2]!.seq]);
    // A real merge is two markers inside one item.
    const both = codexMsg("Delivery check DLV-D09-one-1 and DLV-D09-two-2");
    const mergedRun = orderAndMerge([codexReq([...start, both])], ["DLV-D09-one-1", "DLV-D09-two-2"], MARK);
    expect(mergedRun.merged).toHaveLength(1);
    expect(mergedRun.inOrder).toBe(false);
  });

  it("credits a listed program transform only when its exact inverse restores OpenRig's written bytes, on a listed version", () => {
    const body = "line one\n\tindented with a tab DLV-D15-t-1";
    const wire = `From: x\n---\n${body}\n---`;
    const part = { text: wire.replace("\t", "    ") };
    const known = { kind: "claude", version: "2.1.322", wireSha256s: [sha256(wire)] };
    expect(arrivedAs(part, body, known)).toMatchObject({ intact: true, transform: "claude-code-tab-expansion", restoredSha256: sha256(wire) });
    // Exact bytes need no transform.
    expect(arrivedAs({ text: wire }, body, known)).toEqual({ intact: true, transform: null });
    // Not without OpenRig's record of what it wrote, not on another version or program, not for another difference.
    expect(arrivedAs(part, body, { ...known, wireSha256s: [] }).intact).toBe(false);
    expect(arrivedAs(part, body, { ...known, version: "2.1.311" }).intact).toBe(false);
    expect(arrivedAs(part, body, { ...known, kind: "codex" }).intact).toBe(false);
    expect(arrivedAs({ text: wire.replace("\t", "  ") }, body, known).intact).toBe(false);
    const v = new Verdict();
    v.check("a", true, null);
    v.transformed("claude-code-tab-expansion");
    expect(v.result).toBe("PASS (program transform: claude-code-tab-expansion)");
    v.check("b", false, null);
    expect(v.result).toBe("FAIL");
  });

  it("judges PASS only when every check holds, and keeps NOT RUN's reason", () => {
    const v = new Verdict();
    v.check("a", true, null); v.info("note", 1);
    expect(v.result).toBe("PASS");
    v.check("b", false, { seen: 1 });
    expect(v.toJSON()).toMatchObject({ result: "FAIL", failed: ["b"] });
    const n = new Verdict(); n.skip("no program");
    expect(n.toJSON()).toMatchObject({ result: "NOT RUN", reason: "no program" });
  });
});

describe("delivery harness: the typing-guard matrix (D18)", () => {
  it("holds every sender a mode doesn't let type, in every state", () => {
    expect(expectFor("hold", "idle", "automatic")).toEqual({ type: "held", reasons: ["typing_guard_enabled"] });
    expect(expectFor("urgent-only", "idle", "deliberate")).toEqual({ type: "held", reasons: ["typing_guard_enabled"] });
    expect(expectFor("openrig-urgent", "draft", "deliberate").type).toBe("held");
    expect(expectFor("sends-only", "idle", "automatic").type).toBe("held");
    expect(expectFor("hold", "dialog", "deliberate_urgent").reasons).toEqual(["typing_guard_enabled", "target_needs_input"]);
  });

  it("types where the mode allows it, as the expected matrix says per state", () => {
    expect(expectFor("off", "draft", "automatic")).toEqual({ type: "merge" });
    expect(expectFor("sends-only", "copy_mode", "deliberate")).toEqual({ type: "copy-then-deliver" });
    expect(expectFor("off", "dialog", "deliberate")).toEqual({ type: "refuse", reasons: ["target_needs_input"] });
    // The guarded modes are stated only as "refused, no write" at a dialog: any no-input reason, recorded.
    expect(expectFor("draft-aware", "dialog", "deliberate")).toEqual({ type: "refuse", reasons: null });
    expect(expectFor("draft-aware", "draft", "deliberate")).toEqual({ type: "held", reasons: ["draft_input_busy"] });
    expect(expectFor("draft-aware", "busy", "automatic").type).toBe("deliver-or-held");
    expect(expectFor("openrig-urgent", "idle", "automatic")).toEqual({ type: "deliver" });
    expect(expectFor("urgent-only", "draft", "deliberate_urgent").type).toBe("held");
    // Not stated by the matrix: recorded, never judged.
    expect(expectFor("openrig-urgent", "copy_mode", "automatic")).toEqual({ type: "record" });
  });

  it("resolves draft-aware's busy row by the input box observed at the attempt", () => {
    expect(expectFor("draft-aware", "busy", "deliberate", { composer: "empty" })).toEqual({ type: "deliver", joins: true });
    expect(expectFor("draft-aware", "busy", "automatic", { composer: "unreadable" })).toEqual({ type: "held", reasons: ["draft_input_unknown"] });
    expect(expectFor("off", "busy", "deliberate", { composer: "unreadable" })).toEqual({ type: "deliver", joins: true });
  });
});

/** A case context with nothing behind it: each control below sets only what its counterexample needs. */
function fakeCtx(over: Record<string, unknown> = {}) {
  const verdict = new Verdict();
  const turns: Record<string, unknown[]> = {};
  const ctx = {
    kind: "claude", version: "x", verdict, nowNs: () => 0, sleep: async () => {}, paneWrites: () => [],
    heldMessages: async () => ({ items: [] }), readComposer: async () => "", inMode: async () => false,
    deliveries: (m: string) => ({ thread: "t", identified: true, turns: turns[m] ?? [] }),
    waitDelivered: async (m: string) => ({ thread: "t", identified: true, turns: turns[m] ?? [] }),
    writtenSince: () => [], evidenceFor: () => ({ deliveryEvidence: [], promptObservation: [] }),
    ...over,
  };
  return { ctx, verdict, turns };
}
const userTurn = (index: number, text: string) => ({ index, seq: index, kind: "user", carriedBy: 1, at: new Date().toISOString(),
  parts: [{ text, source: "text", bytes: Buffer.byteLength(text), sha256: sha256(text) }] });
const sendBody = (m: string) => `Delivery check ${m}: deliberate message.`;

describe("delivery harness: D18's attempt evidence (X-F1)", () => {
  it("makes an automatic attempt with no evaluated occurrence NOT RUN, never a refusal, when nothing was observed", async () => {
    const { ctx, verdict } = fakeCtx({ registerReminder: async () => "job", watchdogStatus: async () => ({ recentHistory: [] }), stopWatchdog: async () => {} });
    const at = await attempt(ctx, "automatic", "DLV-a-1", { occurrenceTimeoutMs: 30, pollMs: 1 });
    expect(at).toMatchObject({ json: null, missing: expect.stringMatching(/no occurrence/) });
    const judged = await judge(ctx, { mode: "off", state: "dialog", sender: "automatic", marker: "DLV-a-1", attempt: at, expect: { type: "refuse", reasons: ["target_needs_input"] } });
    expect(judged.notRun).toMatch(/no occurrence/);
    expect(verdict.result).toBe("PASS"); // the cell then reads NOT RUN: see run()
  });

  it("fails a send with no JSON result when a forbidden effect was observed anyway (Q1)", async () => {
    const paste = { timeNs: 5, argv: ["paste-buffer", "-t", "%0", "-b", "openrig_1", "-d", "-r", "-p"] };
    const { ctx, verdict } = fakeCtx({ send: async () => ({ exit: 1, json: null, stderr: "daemon unreachable" }), paneWrites: () => [paste] });
    const at = await attempt(ctx, "deliberate", "DLV-a-2");
    expect(at).toMatchObject({ json: null, missing: expect.stringMatching(/no JSON result \(exit 1\): daemon unreachable/) });
    const judged = await judge(ctx, { mode: "off", state: "dialog", sender: "deliberate", marker: "DLV-a-2", attempt: at, expect: { type: "refuse", reasons: ["target_needs_input"] } });
    expect(judged.notRun).toBeNull();
    expect(verdict.toJSON().failed.join(" ")).toMatch(/no forbidden effect without a record/);
  });

  it("reads an occurrence's own evaluation as its result: sent, retained with its held ids, or refused before input", () => {
    expect(occurrenceResult({ deliveryStatus: "ok" })).toEqual({ ok: true, sent: true });
    expect(occurrenceResult({ deliveryStatus: "retained", evaluationNotes: { outboxIds: ["g1"] } })).toMatchObject({ outcome: "retained", sent: false, outboxIds: ["g1"] });
    expect(occurrenceResult({ deliveryStatus: "failed", evaluationNotes: { deliveryInputPhase: "not_reached", deliveryCode: "target_needs_input" } }))
      .toMatchObject({ ok: false, sent: false, reason: "target_needs_input" });
  });

  it("fails an automatic hold whose recorded reason isn't the expected one, and confirms nothing when no reason is recorded", async () => {
    const held = (reason: string | null) => fakeCtx({ heldMessages: async () => ({ items: [{ outboxId: "g1", deliveryState: "retained", body: "Reminder DLV-h-1: an automatic notice.",
      ...(reason ? { delivery: { reason } } : {}) }] }) });
    const at = { since: 0, source: "watchdog", json: occurrenceResult({ deliveryStatus: "retained", evaluationNotes: { outboxIds: ["g1"] } }) };
    const args = { mode: "hold", state: "idle", sender: "automatic", marker: "DLV-h-1", attempt: at, expect: { type: "held", reasons: ["typing_guard_enabled"] } };
    const wrong = held("draft_input_busy");
    await judge(wrong.ctx, args);
    expect(wrong.verdict.result).toBe("FAIL");
    const right = held("typing_guard_enabled");
    expect((await judge(right.ctx, args)).notRun).toBeNull();
    expect(right.verdict.result).toBe("PASS");
    const unknown = held(null);
    expect((await judge(unknown.ctx, args)).notRun).toMatch(/reason isn't recorded/);
    expect(unknown.verdict.result).toBe("PASS"); // the cell then reads NOT RUN, never PASS: see run()
  });

  it("retires only the held messages held-messages lists, never the occurrence that held them", async () => {
    const { ctx } = fakeCtx({ heldMessages: async () => ({ items: [{ outboxId: "guard-send-1", deliveryState: "retained", body: "Reminder DLV-h-2: an automatic notice." }] }) });
    const at = { since: 0, source: "watchdog", json: occurrenceResult({ deliveryStatus: "retained", evaluationNotes: { outboxIds: ["watchdog-occurrence-1", "guard-send-1"] } }) };
    const judged = await judge(ctx, { mode: "hold", state: "idle", sender: "automatic", marker: "DLV-h-2", attempt: at, expect: { type: "held", reasons: null } });
    expect(judged.heldIds).toEqual(["guard-send-1"]);
  });
});

describe("delivery harness: D18's round-2 controls (Q2 to Q5)", () => {
  const paste = (timeNs: number) => ({ timeNs, argv: ["paste-buffer", "-t", "%0", "-b", "openrig_1", "-d", "-r", "-p"] });
  const enter = (timeNs: number) => ({ timeNs, argv: ["send-keys", "-t", "%0", "Enter"] });

  it("doesn't type a fixture over an input box that wasn't verified clean (Q2)", async () => {
    let typed = 0;
    const residue = fakeCtx({ observe: async () => ({ screen: "x" }), composerOf: () => "From: a\nleft over", typeDraft: async () => { typed++; } });
    await expect(enterState(residue.ctx, "draft", "x1", "")).rejects.toMatchObject({ notRun: true, message: expect.stringMatching(/wasn't verified clean before the draft fixture/) });
    const unreadable = fakeCtx({ observe: async () => ({ screen: "x" }), composerOf: () => null, enterCopyMode: async () => { typed++; } });
    await expect(enterState(unreadable.ctx, "copy_mode", "x2", "")).rejects.toMatchObject({ notRun: true });
    expect(typed).toBe(0);
  });

  it("fails a held result whose returned outboxIds miss or misname its held messages (Q3)", async () => {
    expect(idsCorrelate({ outboxIds: ["g1"] }, ["g1"], "send")).toBe(true);
    expect(idsCorrelate({ outboxIds: ["watchdog-occurrence-1", "g1"] }, ["g1"], "watchdog")).toBe(true);
    expect(idsCorrelate({ outboxIds: [] }, ["g1"], "send")).toBe(false);
    expect(idsCorrelate({ outboxIds: ["g2"] }, ["g1"], "send")).toBe(false);
    expect(idsCorrelate({ outboxIds: ["watchdog-occurrence-1", "g1"] }, ["g1"], "send")).toBe(false);
    const { ctx, verdict } = fakeCtx({ heldMessages: async () => ({ items: [{ outboxId: "g1", deliveryState: "retained", body: "Delivery check DLV-q3-1: deliberate message." }] }) });
    const at = { since: 0, source: "send", json: { ok: true, outcome: "retained", sent: false, reason: "typing_guard_enabled", outboxIds: ["g2"] } };
    await judge(ctx, { mode: "hold", state: "idle", sender: "deliberate", marker: "DLV-q3-1", attempt: at, expect: { type: "held", reasons: ["typing_guard_enabled"] } });
    expect(verdict.toJSON().failed.join(" ")).toMatch(/outboxIds name its held messages/);
  });

  it("fails a busy join whose paste and Enter came only after the busy answer was released (Q4)", async () => {
    const m = "DLV-q4-1";
    const join = (writes: unknown[]) => {
      const f = fakeCtx({ paneWrites: () => writes });
      f.turns[m] = [userTurn(1, sendBody(m))];
      return f;
    };
    const args = { mode: "off", state: "busy", sender: "deliberate", marker: m, attempt: { since: 0, source: "send", json: { ok: true, sessionName: "s" } },
      expect: { type: "deliver", joins: true }, entered: { releasedNs: 100 } };
    const late = join([paste(150), enter(160)]);
    await judge(late.ctx, args);
    expect(late.verdict.toJSON().failed.join(" ")).toMatch(/written into the running turn/);
    const during = join([paste(50), enter(60)]);
    await judge(during.ctx, args);
    expect(during.verdict.result).toBe("PASS");
  });

  it("sees a paste made during the no-arrival observation, and fails the refusal (Q5)", async () => {
    let waited = false;
    const { ctx, verdict } = fakeCtx({ sleep: async () => { waited = true; }, paneWrites: () => waited ? [paste(5)] : [] });
    const at = { since: 0, source: "send", json: { ok: false, sent: false, reason: "target_needs_input", inputPhase: "not_reached" } };
    await judge(ctx, { mode: "off", state: "dialog", sender: "deliberate", marker: "DLV-q5-1", attempt: at, expect: { type: "refuse", reasons: ["target_needs_input"] } });
    expect(verdict.result).toBe("FAIL");
  });
});

describe("delivery harness: D18's merge, body and count (X-F2)", () => {
  const deliver = (expectType: string, entered = {}) => ({ mode: "off", state: "idle", sender: "deliberate", attempt: { since: 0, source: "send", json: { ok: true, sessionName: "s" } },
    expect: { type: expectType }, entered });

  it("fails a merge whose draft stayed unsubmitted in the input box while the message went alone", async () => {
    const m = "DLV-m-1";
    const { ctx, verdict, turns } = fakeCtx({ readComposer: async () => "PERSONDRAFTx" });
    turns[m] = [userTurn(1, sendBody(m))];
    await judge(ctx, { ...deliver("merge", { draft: "PERSONDRAFTx" }), marker: m });
    expect(verdict.result).toBe("FAIL");
    const merged = fakeCtx();
    merged.turns[m] = [userTurn(1, `PERSONDRAFTx${sendBody(m)}`)];
    await judge(merged.ctx, { ...deliver("merge", { draft: "PERSONDRAFTx" }), marker: m });
    expect(merged.verdict.result).toBe("PASS");
  });

  it("fails a delivery whose marker arrived without the rest of its body", async () => {
    const m = "DLV-m-2";
    const { ctx, verdict, turns } = fakeCtx();
    turns[m] = [userTurn(1, `Delivery check ${m}: delib`)];
    await judge(ctx, { ...deliver("deliver"), marker: m });
    expect(verdict.result).toBe("FAIL");
    expect(verdict.toJSON().failed.join(" ")).toMatch(/byte for byte/);
  });

  it("fails a delivery that arrives a second time after the first was seen", async () => {
    const m = "DLV-m-3";
    const { ctx, verdict } = fakeCtx({
      waitDelivered: async () => ({ thread: "t", identified: true, turns: [userTurn(1, sendBody(m))] }),
      deliveries: () => ({ thread: "t", identified: true, turns: [userTurn(1, sendBody(m)), userTurn(2, sendBody(m))] }),
    });
    await judge(ctx, { ...deliver("deliver"), marker: m });
    expect(verdict.toJSON().failed.join(" ")).toMatch(/delivered exactly once/);
  });
});

describe("delivery harness: D18's held message kept through the change to off (X-F3)", () => {
  const offResult = { pending: false, desiredMode: "off", effectiveMode: "off", desiredLevel: null, effectiveLevel: null };
  const kept = { id: "g1", marker: "DLV-k-1", name: "draft · deliberate" };

  it("fails when the change to off flushes only the active held message", async () => {
    let flushed = false;
    const { ctx, verdict } = fakeCtx({
      settle: async () => true, retireHeld: async () => ({ exit: 1, state: null }),
      setGuard: async () => { flushed = true; return offResult; },
      heldMessages: async () => ({ items: [{ outboxId: "g1", deliveryState: flushed ? "delivered" : "retained" }] }),
      deliveries: (m: string) => ({ thread: "t", identified: true, turns: flushed && m === kept.marker ? [userTurn(1, sendBody(m))] : [] }),
    });
    expect(await modeChangeControl(ctx, { mode: "draft-aware", kept, watched: [kept.marker] })).toBeNull();
    expect(verdict.result).toBe("FAIL");
    expect(verdict.toJSON().failed.join(" ")).toMatch(/still held, not flushed/);
  });

  it("is NOT RUN, judging nothing, when the change to off is still pending", async () => {
    const { ctx, verdict } = fakeCtx({ settle: async () => true, setGuard: async () => ({ ...offResult, pending: true, effectiveMode: "draft-aware" }),
      heldMessages: async () => ({ items: [{ outboxId: "g1", deliveryState: "retained" }] }) });
    expect(await modeChangeControl(ctx, { mode: "draft-aware", kept, watched: [kept.marker] })).toMatch(/wasn't observed effective/);
    expect(verdict.checks).toEqual([]);
  });

  it("passes when the kept message stays held through an effective change and then retires", async () => {
    const { ctx, verdict } = fakeCtx({ settle: async () => true, setGuard: async () => offResult, retireHeld: async () => ({ exit: 0, state: "retired" }),
      heldMessages: async () => ({ items: [{ outboxId: "g1", deliveryState: "retained" }] }) });
    expect(await modeChangeControl(ctx, { mode: "draft-aware", kept, watched: [kept.marker] })).toBeNull();
    expect(verdict.result).toBe("PASS");
  });
});

describe("delivery harness: D04's state at each arm's attempt (X-F4)", () => {
  const screenWith = (footer: string) => `● got it\n────────\n❯ \n────────\n  ⏵⏵ accept edits on\n  ${footer}`;
  const armCtx = (screen: string, over: Record<string, unknown> = {}) => fakeCtx({
    resize: async (w: number, h: number) => `${w}x${h}`, settle: async () => true, observe: async () => ({ screen }),
    composerOf: (text: string) => text.includes("❯") ? text.split("\n").find((r) => r.startsWith("❯"))!.slice(1).trim() : null,
    send: async () => { throw new Error("an arm whose state isn't established must not send"); }, ...over });
  const clipped = { label: "80x24, clipped footer", size: [80, 24], footer: (rows: string[]) => rows.some((r) => r.endsWith("…")), footerText: "the width-clipped form" };

  it("makes an arm NOT RUN, without sending or judging, when its footer isn't there at the attempt", async () => {
    const { ctx, verdict } = armCtx(screenWith("? for shortcuts"));
    verdict.check("an earlier arm failed", false, null);
    expect(await runArm(ctx, clipped, "")).toMatch(/isn't the width-clipped form/);
    expect(verdict.result).toBe("FAIL"); // the earlier failure stands
    expect(verdict.checks.filter((c) => c.ok !== null)).toHaveLength(1);
  });

  it("fails an arm whose send left no record but whose paste was observed with nothing delivered (Q1)", async () => {
    const paste = { timeNs: 5, argv: ["paste-buffer", "-t", "%0", "-b", "openrig_1", "-d", "-r", "-p"] };
    const { ctx, verdict } = armCtx(screenWith("✘ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-c…"), {
      mark: () => "DLV-d04-1", send: async () => ({ exit: 1, json: null, stderr: "lost" }), paneWrites: () => [paste], eraseDraft: async () => {} });
    expect(await runArm(ctx, clipped, "")).toBeNull();
    expect(verdict.toJSON().failed.join(" ")).toMatch(/no forbidden effect without a record of the send/);
  });

  it("clears an earlier arm's residue first, and is NOT RUN if the input box still isn't empty", async () => {
    let erased = 0;
    const residue = `${screenWith("✘ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-c…")}`.replace("❯ ", "❯ [Pasted text #1 +6 lines]");
    const { ctx } = armCtx(residue, { readComposer: async () => "[Pasted text #1 +6 lines]", eraseDraft: async () => { erased++; } });
    expect(await runArm(ctx, clipped, "")).toMatch(/input box wasn't empty/);
    expect(erased).toBe(1);
  });
});

describe("delivery harness: the cell's surroundings", () => {
  it("contains a cell in a loopback-only namespace, then maps back to this user", () => {
    const argv = containedArgv(["node", "x.mjs", "a b"]);
    expect(argv.slice(0, 5)).toEqual(["unshare", "--user", "--map-root-user", "--net", "--"]);
    expect(argv[7]).toContain("ip link set lo up && exec unshare --user");
    expect(argv[7]).toContain(`--map-user=${process.getuid!()}`);
    // The command is passed through as arguments, never spliced into the shell text.
    expect(argv.slice(-3)).toEqual(["node", "x.mjs", "a b"]);
  });

  it("reads the input box of each program from a screen (recorded frames)", () => {
    const claude = ["● ok", "", "──────────── p-seat@dlv ─", "❯ half typed DLV-D03-draft-1 by a person", "──────────────────", "  ⏵⏵ accept edits on"].join("\n");
    expect(composerText("claude", claude)).toBe("half typed DLV-D03-draft-1 by a person");
    const codex = ["› From: someone", "• ok DLV-x", "", "› half typed words", "", "  stand-in default · /w"].join("\n");
    expect(composerText("codex", codex)).toBe("half typed words");
    expect(composerText("claude", "no prompt here")).toBeNull();
  });

  it("owns a process only by an exact HOME or tmux-socket entry in its environment", () => {
    const identity = { home: "/c/home", sockets: "/tmp/dlv-x" };
    expect(ownsEnviron("PATH=/bin\0HOME=/c/home\0", identity)).toBe(true);
    expect(ownsEnviron("TMUX_TMPDIR=/tmp/dlv-x\0HOME=/elsewhere", identity)).toBe(true);
    expect(ownsEnviron("XHOME=/c/home\0HOME=/elsewhere", identity)).toBe(false);
    expect(ownsEnviron("HOME=/c/home/sub", identity)).toBe(false);
  });

  it("never offers an old screen as the current one once a capture fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-screen-"));
    let fail = false;
    const cell = { session: "s", tmux: async (args: string[]) => { if (fail) throw new Error("no server"); return args[0] === "capture-pane" ? "screen A" : "0\t80x24"; } };
    const rec = recordScreen(cell, join(dir, "frames.jsonl"), { everyMs: 20 });
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(rec.last()?.screen).toBe("screen A");
      fail = true;
      await new Promise((r) => setTimeout(r, 80));
      expect(rec.last()).toBeNull();
      expect(rec.failures()).toBeGreaterThan(0);
    } finally { await rec.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("makes a cell NOT RUN, never a verdict, when it can't observe the screen or read the input box after an action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-observe-"));
    let screen: string | null = "no prompt row here";
    const cell = { session: "s", logs: dir, record: () => {}, standIn: { requests: () => [] },
      tmux: async (args: string[]) => { if (screen === null) throw new Error("no server"); return args[0] === "capture-pane" ? screen : "0\t80x24"; } };
    const ctx = caseContext(cell, { caseId: "T", kind: "claude", version: "x" });
    try {
      await expect(ctx.readComposer()).rejects.toMatchObject({ notRun: true, message: expect.stringMatching(/input box couldn't be read/) });
      screen = "● ok\n────────\n❯ typed text\n────────";
      expect(await ctx.readComposer()).toBe("typed text");
      expect(await ctx.settle({ quietMs: 50, timeoutMs: 2000 })).toBe(true);
      screen = null;
      await new Promise((r) => setTimeout(r, 400));
      await expect(ctx.observe({ timeoutMs: 300 })).rejects.toMatchObject({ notRun: true });
      await expect(ctx.settle({ quietMs: 50, timeoutMs: 300 })).rejects.toMatchObject({ notRun: true, message: expect.stringMatching(/no screen observation/) });
    } finally { await ctx.screen.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("credits a capture with its start, so one begun before an action never counts as after it, however late it finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-capture-order-"));
    let screen = "● ok\n────────\n❯ PRE\n────────";
    let actionAt: number | null = null;
    let armed = false;
    const cell = { session: "s", logs: dir, record: () => {}, standIn: { requests: () => [] },
      tmux: async (args: string[]) => {
        if (args[0] === "capture-pane") {
          const content = screen;
          // The action happens while this capture is in flight: after its content was read, before its state read.
          if (armed && actionAt === null) { actionAt = performance.now(); screen = "● ok\n────────\n❯ POST\n────────"; }
          return content;
        }
        await new Promise((r) => setTimeout(r, 300)); // a slow display-message
        return "0\t80x24";
      } };
    const ctx = caseContext(cell, { caseId: "T", kind: "claude", version: "x" });
    try {
      expect(await ctx.readComposer()).toBe("PRE");
      armed = true;
      while (actionAt === null) await new Promise((r) => setTimeout(r, 10));
      expect(await ctx.readComposer({ after: actionAt, timeoutMs: 3000 })).toBe("POST");
    } finally { await ctx.screen.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports a cell's processes that survive SIGKILL or refuse a signal, and keeps the socket dir while any survive", async () => {
    const sockets = mkdtempSync("/tmp/dlv-test-reap-");
    const signals: string[] = [];
    const quick = { pause: async () => {} };
    try {
      // One survives everything, one refuses signals, one is already gone (ESRCH isn't a failure).
      const survivor = await reapByIdentity({ home: "/x", sockets }, { ...quick, list: () => [{ pid: 11, comm: "tmux: server" }],
        kill: (pid: number, sig: string) => { signals.push(`${pid}:${sig}`); } });
      expect(signals).toEqual(["11:SIGTERM", "11:SIGKILL"]);
      expect(survivor.unresolved).toEqual([{ pid: 11, comm: "tmux: server" }]);
      expect(existsSync(sockets)).toBe(true);
      let calls = 0;
      const refused = await reapByIdentity({ home: "/x", sockets }, { ...quick, list: () => (calls++ < 1 ? [{ pid: 12, comm: "node" }] : []),
        kill: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); } });
      expect(refused.unresolved).toEqual([{ pid: 12, comm: "node", error: "SIGTERM: EPERM" }]);
      let gone = 0;
      const clean = await reapByIdentity({ home: "/x", sockets }, { ...quick, list: () => (gone++ < 1 ? [{ pid: 13, comm: "claude" }] : []),
        kill: () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); } });
      expect(clean.unresolved).toEqual([]);
      expect(existsSync(sockets)).toBe(false);
    } finally { rmSync(sockets, { recursive: true, force: true }); }
  });

  it("takes only the contract's refusal at a dialog as a refusal", () => {
    expect(isRefusal({ ok: false, sent: false, reason: "target_needs_input" })).toBe(true);
    expect(isRefusal({ ok: false, sent: false, reason: "daemon_unreachable" })).toBe(false);
    expect(isRefusal({ ok: false, reason: "target_needs_input" })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });

  it("reads a process's name and parent from /proc stat even when the name holds parentheses and spaces", () => {
    expect(parseStat(7, "7 (a) b (c)) S 3 7 7 0 -1")).toEqual({ pid: 7, comm: "a) b (c)", state: "S", ppid: 3 });
  });

  it("logs each tmux call's argv and then runs the real tmux", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-tmux-"));
    try {
      const log = join(dir, "argv.jsonl");
      const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
      if (!real) return; // no tmux on this host: nothing to wrap
      const r = spawnSync(join(HARNESS, "tmux"), ["-V"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", DELIVERY_REAL_TMUX: real, DELIVERY_TMUX_LOG: log, DELIVERY_ARM: "t" } });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^tmux /);
      const [entry] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(entry).toMatchObject({ arm: "t", argv: [real, "-V"] });
      expect(Object.keys(entry).sort()).toEqual(["argv", "arm", "cwd", "monotonicNs", "pid", "timeNs"]);
      // A relative path is refused rather than guessed.
      expect(spawnSync(join(HARNESS, "tmux"), ["-V"], { env: { PATH: "/usr/bin:/bin", DELIVERY_REAL_TMUX: "tmux", DELIVERY_TMUX_LOG: log, DELIVERY_ARM: "t" } }).status).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("types an armed draft into exactly the armed pane, once, and shows it before letting the paste run", () => {
    const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
    if (!real) return; // no tmux on this host
    // The tmux server's socket goes where this run may reach it: CI's macOS sandbox allows socket connects only under
    // TMUX_TMPDIR. Kept short for the socket path limit, as the repo's other native tmux tests do.
    const sockets = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? (process.platform === "darwin" ? "/private/tmp" : tmpdir()), "dlv-test-")));
    const dir = mkdtempSync(join(tmpdir(), "delivery-inject-"));
    const env = { PATH: "/usr/bin:/bin", TMUX_TMPDIR: sockets, DELIVERY_REAL_TMUX: real, DELIVERY_TMUX_LOG: join(dir, "argv.jsonl"), DELIVERY_ARM: "t", DELIVERY_INJECT_DIR: dir };
    const tmux = (...args: string[]) => spawnSync(real, args, { encoding: "utf8", env });
    const wrapped = (...args: string[]) => spawnSync(join(HARNESS, "tmux"), args, { encoding: "utf8", env });
    try {
      // The setup must hold before the wrapper is judged: a tmux that can't start fails here, not as a paste.
      expect(tmux("new-session", "-d", "-s", "s", "-x", "80", "-y", "10", "cat")).toMatchObject({ status: 0, stderr: "" });
      const pane = tmux("display-message", "-p", "-t", "s", "#{pane_id}").stdout.trim();
      expect(pane).toMatch(/^%\d+$/);
      expect(tmux("set-buffer", "-b", "openrig_t_1", "NOTICE-TEXT")).toMatchObject({ status: 0, stderr: "" });
      expect(tmux("set-buffer", "-b", "other_1", "OTHER")).toMatchObject({ status: 0, stderr: "" });
      writeFileSync(join(dir, "arm.json"), JSON.stringify({ pane, text: "DRAFT-TEXT", bufferPrefix: "openrig_" }));
      // A paste from another buffer leaves the arm in place.
      expect(wrapped("paste-buffer", "-t", pane, "-b", "other_1")).toMatchObject({ status: 0, stderr: "" });
      expect(existsSync(join(dir, "fired.json"))).toBe(false);
      expect(existsSync(join(dir, "arm.json"))).toBe(true);
      expect(wrapped("paste-buffer", "-t", pane, "-b", "openrig_t_1").status).toBe(0);
      const fired = JSON.parse(readFileSync(join(dir, "fired.json"), "utf8"));
      expect(fired).toMatchObject({ target: pane, buffer: "openrig_t_1", text: "DRAFT-TEXT", visible: true });
      expect(fired.screenBeforePaste).toContain("DRAFT-TEXT");
      expect(fired.screenBeforePaste).not.toContain("NOTICE-TEXT");
      expect(existsSync(join(dir, "arm.json"))).toBe(false);
      // Once: a second paste types nothing more.
      tmux("set-buffer", "-b", "openrig_t_2", "SECOND");
      expect(wrapped("paste-buffer", "-t", pane, "-b", "openrig_t_2").status).toBe(0);
      const screen = tmux("capture-pane", "-p", "-t", pane).stdout;
      expect(screen.match(/DRAFT-TEXT/g)).toHaveLength(1);
      expect(screen).toContain("NOTICE-TEXT");
    } finally {
      tmux("kill-server");
      rmSync(sockets, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run into an --out that already holds a run, so no earlier verdict can be read as this run's", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-out-"));
    try {
      writeFileSync(join(dir, "RESULT.json"), "{}");
      const r = spawnSync(process.execPath, [join(HARNESS, "..", "run.mjs"), "run", "--out", dir, "--openrig", "/nonexistent"], { encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/already holds a run/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("banks the daemon's tables without credential-like columns, and flags credential-shaped text", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-bank-"));
    try {
      const home = join(dir, "home");
      const openrigHome = join(home, ".openrig");
      const logs = join(dir, "logs");
      for (const d of [openrigHome, logs]) spawnSync("mkdir", ["-p", d]);
      const db = new DatabaseSync(join(openrigHome, "openrig.sqlite"));
      db.exec("CREATE TABLE events (seq INTEGER, type TEXT, payload TEXT, created_at TEXT, auth_token TEXT)");
      db.prepare("INSERT INTO events VALUES (1, 'transport.delivery_evidence', ?, '2026-11-12 16:00:00', 'secret-value')").run(JSON.stringify({ wireSha256: "ab", written: "submitted" }));
      db.close();
      spawnSync("sh", ["-c", `printf '%s\\n' '{"leak":"sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"}' > ${join(logs, "stand-in.jsonl")}`]);
      const cell = { root: dir, home, logs, env: { OPENRIG_HOME: openrigHome, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") } };
      const manifest = bankCell(cell, join(dir, "bank"));
      const tables = JSON.parse(readFileSync(join(dir, "bank", "daemon-tables.json"), "utf8"));
      expect(tables.events.dropped).toEqual(["auth_token"]);
      expect(JSON.stringify(tables)).not.toContain("secret-value");
      expect(JSON.parse(readFileSync(join(dir, "bank", "delivery-events.json"), "utf8"))).toMatchObject([{ type: "transport.delivery_evidence", payload: { wireSha256: "ab" } }]);
      expect(manifest.credentialScan).toEqual({ clean: false, files: ["stand-in.jsonl"] });
      expect(manifest.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
