// The first cases: idle, busy, drafts under the default and with protection opted in, copy mode, order and a
// multi-line paste (D01, D02, D03, D04, D08, D09, D15), on both programs. Each case's expected result is Quality's, in
// expected.yaml beside this file; a case here only acts and checks what that file says.
//
// A case is { id, title, programs, script(kind), claudeSettings?, run(ctx) }. `script` is the stand-in's; `run` acts
// through ctx (harness/case-context.mjs) and records checks on ctx.verdict. A check states what was seen, so a FAIL
// reads as evidence, not a bare verdict.

import { arrivedAs, conversation, markersIn, orderAndMerge, partWith } from "../harness/oracle.mjs";

const ACK = "ack {{marker}}";
const MARK = "DLV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

/** The common close of a delivery: delivered exactly once, intact, alone in its turn, and answered on screen. */
async function deliveredOnce(ctx, marker, body, { label = marker, alone = true } = {}) {
  const { verdict } = ctx;
  const seen = await ctx.waitDelivered(marker);
  await ctx.sleep(2000); // a late duplicate has time to arrive before the count is final
  const final = ctx.deliveries(marker);
  verdict.check(`${label}: delivered exactly once in the seat's thread`, final.turns.length === 1,
    { thread: final.thread, items: final.turns.map((t) => ({ index: t.index, firstSeq: t.seq, kind: t.kind, carriedBy: t.carriedBy })) });
  const turn = final.turns[0] ?? seen.turns[0];
  if (!turn) return null;
  const { part } = partWith(turn, marker, body);
  const wireSha256s = ctx.writtenSince("1970-01-01T00:00:00Z").map((w) => w.wireSha256);
  const arrived = arrivedAs(part, body, { kind: ctx.kind, version: ctx.version, wireSha256s });
  const intact = arrived.intact;
  if (arrived.transform) {
    ctx.verdict.transformed(arrived.transform);
    verdict.info(`${label}: a listed program transform explains the difference, and its inverse restores OpenRig's written bytes`, arrived);
  }
  verdict.check(`${label}: arrived byte for byte${arrived.transform ? ` (after undoing ${arrived.transform})` : ""}`, intact, { bytes: part?.bytes, sha256: part?.sha256, expectedBytes: Buffer.byteLength(body) });
  // OpenRig's own record of the same bytes. Best effort: a missing record isn't proof nothing was written.
  if (part) {
    const records = ctx.evidenceFor(part.sha256);
    verdict.info(`${label}: OpenRig's records of the same bytes (#2937 wire evidence; the prompt hook, where installed)`, records);
    // The bytes changed somewhere: put what OpenRig says it wrote beside what the model got.
    if (!intact && records.deliveryEvidence.length === 0) {
      verdict.info(`${label}: OpenRig's record of what it wrote for this send, to compare with what the model received`,
        { received: { bytes: part.bytes, sha256: part.sha256 }, written: ctx.writtenSince(new Date(Date.parse(turn.at) - 60_000).toISOString()) });
    }
  }
  if (alone) {
    const markers = markersIn(turn, MARK);
    verdict.check(`${label}: alone in its turn (no merge)`, markers.length === 1, markers);
  }
  return turn;
}

function sendAccepted(ctx, sent, label) {
  ctx.verdict.check(`${label}: rig send accepted it`, sent.exit === 0 && sent.json?.ok === true,
    { exit: sent.exit, ok: sent.json?.ok, warning: sent.json?.warning?.slice(0, 120), stderr: sent.stderr?.slice(0, 300) });
}

export const CASES = [
  {
    id: "D01",
    title: "idle seat",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ when: "DLV-D01", say: ACK }] }),
    async run(ctx) {
      await ctx.settle();
      const marker = ctx.mark("idle");
      const body = `Delivery check ${marker}: an idle seat, one message.`;
      const sent = await ctx.send(body);
      sendAccepted(ctx, sent, "the message");
      await deliveredOnce(ctx, marker, body);
      ctx.verdict.check("the reply reached the screen", await ctx.waitScreen(`ack ${marker}`), `ack ${marker}`);
      ctx.verdict.check("the seat returned to idle (screen settled)", await ctx.settle({ timeoutMs: 30_000, optional: true }), null);
      ctx.verdict.info("not exercised here: a doorbell pointing at an owned fixture row (later case set)", null);
    },
  },

  {
    id: "D02",
    title: "busy seat (mid-turn)",
    programs: ["claude", "codex"],
    // The first message starts a tool that runs for 8 seconds; the second is sent while it runs.
    claudeSettings: { permissions: { allow: ["Bash(sleep 8)", "Bash(echo D02-tool-finished)"] } },
    script: (kind) => ({ rules: [
      { when: "DLV-D02-first", times: 1, tool: kind === "claude"
        ? { name: "Bash", input: { command: "sleep 8; echo D02-tool-finished", description: "Wait eight seconds" } }
        : { name: "exec_command", input: { cmd: "sleep 8; echo D02-tool-finished" } } },
      { on: "tool_result", say: "tool round done {{marker}}" },
      { when: "DLV-D02", say: ACK },
    ] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      const first = ctx.mark("first");
      const firstBody = `Delivery check ${first}: start the long tool.`;
      sendAccepted(ctx, await ctx.send(firstBody), "the first message");
      await deliveredOnce(ctx, first, firstBody, { label: "the first message" });
      await ctx.sleep(2500);
      // In flight is shown, not assumed: the tool's result hasn't come back to the model yet.
      const toolRoundsBefore = ctx.requests().filter((r) => r.turn?.kind === "tool_result").length;
      verdict.check("the tool was still running when the second message was sent", toolRoundsBefore === 0, { toolRoundsBefore });
      const second = ctx.mark("second");
      const secondBody = `Delivery check ${second}: sent while the tool runs.`;
      const sent = await ctx.send(secondBody);
      sendAccepted(ctx, sent, "the second message");
      verdict.info("the send's own answer about the busy seat", { warning: sent.json?.warning, result: sent.json?.result ?? null });
      const turn = await deliveredOnce(ctx, second, secondBody, { label: "the second message", alone: false });
      const toolResult = ctx.requests().find((r) => r.turn?.kind === "tool_result");
      const output = toolResult?.turn.parts.filter((p) => p.source === "tool_result").map((p) => p.text).join("\n") ?? "";
      verdict.check("the tool ran to completion (not interrupted or cancelled)", /D02-tool-finished/.test(output), output.slice(0, 400));
      if (turn && toolResult) {
        verdict.check("order kept: the second message reached the model after the first", turn.seq > ctx.deliveries(first).turns[0].seq,
          { first: ctx.deliveries(first).turns[0].seq, second: turn.seq, toolResultSeq: toolResult.seq });
        verdict.info("how the second message joined", turn.kind === "tool_result" ? "beside the tool's result, in the same turn" : "as its own user turn");
      }
    },
  },

  {
    id: "D03",
    title: "a person's unsent draft, default guard (off)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "got it" }] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      const draftMarker = ctx.mark("draft");
      const draft = `half typed ${draftMarker} by a person`;
      await ctx.typeDraft(draft);
      verdict.check("the draft is in the input box before the send", await ctx.waitScreen(draftMarker, { timeoutMs: 10_000 }), ctx.composer());
      const marker = ctx.mark("msg");
      const body = `Delivery check ${marker}: sent over a person's draft.`;
      sendAccepted(ctx, await ctx.send(body), "the message");
      const seen = await ctx.waitDelivered(marker);
      await ctx.sleep(2000);
      const turns = ctx.deliveries(marker).turns;
      verdict.check("the message reached the model exactly once (no loss)", turns.length === 1, turns.map((t) => t.seq));
      const turn = turns[0] ?? seen.turns[0];
      const merged = !!turn && turn.parts.some((p) => p.source === "text" && p.text.includes(draftMarker));
      const input = await ctx.readComposer();
      const draftStillTyped = input.includes(draftMarker);
      verdict.check("the person's draft wasn't deleted (submitted with the message, or still in the input)", merged || draftStillTyped,
        { merged, draftStillTyped, input });
      verdict.info("outcome under the default", merged ? "MERGED: draft and message submitted together (documented)" : "SEPARATE: the draft stayed in the input");
    },
  },

  {
    id: "D04",
    title: "a person's unsent draft, draft-aware guard (opted in)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "got it" }] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.setGuard("draft-aware");
      await ctx.setDraftDelivery("refuse");
      await ctx.settle();
      // Variant "footer: none" with an empty input box: an idle draft-aware seat is not held.
      const empty = ctx.mark("empty");
      const emptyBody = `Delivery check ${empty}: draft-aware, empty input.`;
      sendAccepted(ctx, await ctx.send(emptyBody), "the empty-input message");
      await deliveredOnce(ctx, empty, emptyBody, { label: "the empty-input message" });
      await ctx.settle();

      const draftMarker = ctx.mark("draft");
      const draft = `half typed ${draftMarker} by a person`;
      await ctx.typeDraft(draft);
      verdict.check("the draft is in the input box before the send", await ctx.waitScreen(draftMarker, { timeoutMs: 10_000 }), ctx.composer());
      const held = ctx.mark("held");
      const heldBody = `Delivery check ${held}: must wait for the person's draft.`;
      const since = ctx.nowNs();
      const sent = await ctx.send(heldBody);
      verdict.check("the send was retained, not sent", sent.json?.sent === false || /retain|held|draft_input/.test(JSON.stringify(sent.json ?? sent.stdout ?? "")),
        { exit: sent.exit, json: sent.json, stdout: sent.stdout });
      verdict.info("the reason given", sent.json?.reason ?? sent.json?.result ?? sent.json?.code ?? null);
      await ctx.sleep(3000);
      verdict.check("nothing was written to the pane for it", ctx.paneWrites(since).length === 0, ctx.paneWrites(since));
      verdict.check("the draft never became part of a model turn", !ctx.requests().some((r) => r.turn?.parts.some((p) => p.text.includes(draftMarker))), null);
      verdict.check("the held message didn't reach the model", ctx.deliveries(held).turns.length === 0, ctx.deliveries(held).turns.map((t) => t.seq));
      const listed = await ctx.heldMessages();
      verdict.check("the retained message is readable with rig seat held-messages", JSON.stringify(listed).includes(held), JSON.stringify(listed).slice(0, 600));
      const input = await ctx.readComposer();
      verdict.check("the draft is untouched", input.includes(draftMarker), input);

      await ctx.eraseDraft(draft.length + 2);
      await ctx.settle();
      await ctx.sleep(5000);
      verdict.check("clearing the draft didn't deliver the held message by itself", ctx.deliveries(held).turns.length === 0, ctx.deliveries(held).turns.map((t) => t.seq));
      const again = ctx.mark("again");
      const againBody = `Delivery check ${again}: the explicit resend after the draft cleared (${held}).`;
      sendAccepted(ctx, await ctx.send(againBody), "the explicit new send");
      await deliveredOnce(ctx, again, againBody, { label: "the explicit new send", alone: false });
      verdict.check("the held message reached the model only through that new send", ctx.deliveries(held).turns.length === 1, ctx.deliveries(held).turns.map((t) => t.seq));
      verdict.info("footer variants not run in this cell: Claude's context hint and its auto-update failure footer (full and clipped at 80x24) need a program state this harness doesn't produce yet", null);
    },
  },

  {
    id: "D08",
    title: "tmux copy mode",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ when: "DLV-D08", say: ACK }] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      // Guard off (the default): the seat is taken out of copy mode through its own address, and delivered once.
      await ctx.enterCopyMode();
      verdict.check("the pane is in copy mode before the guard-off send", await ctx.inMode(), null);
      const off = ctx.mark("off");
      const offBody = `Delivery check ${off}: sent while the pane is in copy mode, guard off.`;
      sendAccepted(ctx, await ctx.send(offBody), "the guard-off message");
      await deliveredOnce(ctx, off, offBody, { label: "the guard-off message" });
      verdict.check("the pane left copy mode", !(await ctx.inMode()), null);
      await ctx.settle();

      // Draft-aware: retained with no write; leaving copy mode later doesn't replay it.
      await ctx.setGuard("draft-aware");
      await ctx.setDraftDelivery("refuse");
      await ctx.enterCopyMode();
      verdict.check("the pane is in copy mode before the draft-aware send", await ctx.inMode(), null);
      const aware = ctx.mark("aware");
      const since = ctx.nowNs();
      const sent = await ctx.send(`Delivery check ${aware}: sent in copy mode, draft-aware.`);
      verdict.check("draft-aware: the send was retained, not sent", sent.json?.sent === false || /retain|held|mode/.test(JSON.stringify(sent.json ?? sent.stdout ?? "")), { exit: sent.exit, json: sent.json });
      await ctx.sleep(2000);
      verdict.check("draft-aware: nothing was written to the pane", ctx.paneWrites(since).length === 0, ctx.paneWrites(since));
      verdict.check("draft-aware: still in copy mode (the send didn't take it out)", await ctx.inMode(), null);
      await ctx.leaveCopyMode();
      await ctx.sleep(5000);
      verdict.check("leaving copy mode didn't replay the retained send", ctx.deliveries(aware).turns.length === 0, ctx.deliveries(aware).turns.map((t) => t.seq));
    },
  },

  {
    id: "D09",
    title: "order (back-to-back sends from one sender)",
    programs: ["claude", "codex"],
    // Each answer streams for about two seconds, so later sends land while the seat is busy.
    script: () => ({ rules: [{ when: "DLV-D09", say: "ack {{marker}} after a slow answer", chunks: 4, chunkDelayMs: 500 }] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      const markers = [ctx.mark("one"), ctx.mark("two"), ctx.mark("three")];
      const bodies = markers.map((m, i) => `Delivery check ${m}: message ${i + 1} of 3.`);
      for (const [i, body] of bodies.entries()) sendAccepted(ctx, await ctx.send(body), `message ${i + 1}`);
      for (const m of markers) await ctx.waitDelivered(m, { timeoutMs: 60_000 });
      await ctx.sleep(3000);
      const judged = orderAndMerge(ctx.requests(), markers, MARK);
      markers.forEach((m, i) => verdict.check(`message ${i + 1}: delivered exactly once`, judged.each[i].length === 1, judged.each[i].map((t) => ({ index: t.index, firstSeq: t.seq }))));
      verdict.check("each message is its own item (a merge of two sends is a FAIL)", judged.merged.length === 0 && judged.first.every(Boolean),
        judged.first.map((t, i) => t && { message: i + 1, index: t.index, firstSeq: t.seq, markers: markersIn(t, MARK) }));
      verdict.check("the model got them in send order", judged.inOrder, judged.positions);
      const firstTurns = judged.first;
      bodies.forEach((body, i) => { if (firstTurns[i]) verdict.check(`message ${i + 1}: intact`, partWith(firstTurns[i], markers[i], body).intact, null); });
    },
  },

  {
    id: "D15",
    title: "multi-line paste",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ when: "DLV-D15", say: ACK }] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      const marker = ctx.mark("multi");
      // Newlines, indentation, both quotes, Unicode and harmless shell-shaped text that must arrive as text.
      const body = [
        `Delivery check ${marker}: several lines, one message.`,
        "    an indented line with \"double\" and 'single' quotes",
        "\ta tab-indented line",
        "$(echo this-is-text-not-a-command) `also text` ; true && false || echo still-text",
        "Unicode: café — naïve ✓ 漢字 🙂",
        "",
        "the last line, after a blank one",
      ].join("\n");
      sendAccepted(ctx, await ctx.send(body), "the message");
      const turn = await deliveredOnce(ctx, marker, body);
      // Any line of it in some other item would mean the paste was split into several submissions.
      const lines = body.split("\n").filter((line) => line.trim().length > 8);
      const holding = conversation(ctx.requests()).items.filter((item) => item.parts.some((p) => p.source === "text" && lines.some((line) => p.text.includes(line.trim()))));
      verdict.check("submitted once as one message, not one per line", holding.length === 1, holding.map((i) => ({ index: i.index, firstSeq: i.seq })));
      if (turn) {
        const { part } = partWith(turn, marker, body);
        verdict.info("the delivered part around the message (exact bytes in the stand-in log)", part?.text);
      }
      const input = await ctx.readComposer();
      verdict.check("nothing was left unsubmitted in the input", !input.includes("still-text"), input);
      verdict.info("#2800 control (unreadable input: --dangerously-interact pastes with a warning and no Enter) is not run in this cell: it needs an unreadable-input state the harness doesn't produce yet", null);
    },
  },
];
