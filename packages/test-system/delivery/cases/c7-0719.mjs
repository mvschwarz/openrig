// 0.7.19 C7: nine preparation entries, each named on its own. Items 1-5 are
// cases here; item 6 is D12 (d12.mjs), item 7 the D18 matrix's automatic cells (d18.mjs), item 8 D15 (s2.mjs), and
// item 9 the run's --tmux (run.mjs). C7_0719_ITEMS maps every item to what runs it, so none is dropped or merged.
//
// Preparation only: none of these has run natively. A capability that doesn't exist is registered by name and
// recorded NOT RUN with its source evidence (a case's `notRun`), never built to turn a fixture green. Fixture actions
// that aren't a person's (closing a dialog the fixture opened, renaming or killing the seat's tmux session) are
// recorded as the fixture operator's.

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { NotRun } from "../harness/case-context.mjs";
import { RIG } from "../harness/world.mjs";
import { attempt } from "./d18.mjs";
import { dialogRegion, resendOnce, sendIntoDialog } from "./s3.mjs";

const SENDER = "delivery-suite@dlv";
const ACK = { say: "ack {{marker}}" };
const json = (out) => { try { return JSON.parse(out.stdout); } catch { return { raw: String(out.stdout ?? "").slice(0, 600), stderr: String(out.stderr ?? "").slice(0, 600), exit: out.exit }; } };

/** A read-only query of the cell's OpenRig database. */
function query(ctx, sql, ...params) {
  const db = new DatabaseSync(join(ctx.cell.env.OPENRIG_HOME, "openrig.sqlite"), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
const qitem = (ctx, id) => query(ctx, "SELECT state, claimed_at, last_nudge_result, closure_reason FROM queue_items WHERE qitem_id = ?", id)[0] ?? null;
/** The queue row's wake rows: its outbox rows by id or audit pointer, with the binding and tags parsed. */
const wakeRows = (ctx, id) => query(ctx, "SELECT outbox_id, sender_session, delivery_state, tags, guard_binding FROM outbox_entries WHERE outbox_id = ? OR audit_pointer = ? ORDER BY rowid",
  `wake-intent-${id}`, id).map((r) => ({ outboxId: r.outbox_id, sender: r.sender_session, state: r.delivery_state, tags: r.tags ? JSON.parse(r.tags) : [],
  binding: r.guard_binding ? JSON.parse(r.guard_binding) : null }));
const transitions = (ctx, id) => query(ctx, "SELECT transition_id, state, transition_note, actor_session FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id", id);
/** The seat's recorded binding (tmux session and pane) and current occupant generation. */
function seatBinding(ctx) {
  const row = query(ctx, `SELECT b.tmux_session, b.tmux_pane, n.id AS node_id FROM bindings b JOIN nodes n ON n.id = b.node_id JOIN rigs r ON r.id = n.rig_id WHERE r.name = ?`, RIG)[0] ?? null;
  const occupant = row ? query(ctx, "SELECT generation_uuid FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1", row.node_id)[0]?.generation_uuid ?? null : null;
  return row ? { session: row.tmux_session, pane: row.tmux_pane, occupant } : null;
}
const PRE_INPUT_TAG = "queue:wake-pre-input-failure";

/** Every tmux call OpenRig made, from the logging tmux's record: any pane, not only the current one. */
function tmuxCalls(ctx, sinceNs = 0) {
  const path = join(ctx.cell.logs, "tmux-argv.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.timeNs >= sinceNs).map((r) => ({ timeNs: r.timeNs, argv: r.argv.slice(1) }));
}
const targetOf = (argv) => argv[argv.indexOf("-t") + 1] ?? null;
const openrigPastes = (calls) => calls.filter((c) => c.argv[0] === "paste-buffer" && c.argv.some((a) => a.startsWith("openrig_")));

/** A queue row to the seat from the suite; its create-path notice is an automatic queue wake. */
async function queueTo(ctx, label) {
  const marker = ctx.mark(label);
  const out = await ctx.cell.rig(["queue", "create", "--destination", ctx.cell.session, "--summary", `Delivery check ${marker}`,
    "--body", `Delivery check ${marker}: a queue row for the seat (${label}).`, "--json"], { allowFail: true, as: SENDER });
  const created = json(out);
  const qitemId = created?.qitemId ?? created?.qitem?.qitemId ?? created?.id ?? null;
  ctx.verdict.info(`${label}: queue row created`, { exit: out.exit, qitemId, sender: SENDER });
  if (!qitemId) throw new NotRun(`${label}: the queue row wasn't created`);
  return { marker, qitemId };
}

/** Wait for the row's first wake attempt to be recorded (its nudge result). */
async function firstAttempt(ctx, qitemId, timeoutMs = 30_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await ctx.sleep(500)) { const row = qitem(ctx, qitemId); if (row?.last_nudge_result) return row; }
  return qitem(ctx, qitemId);
}

/** The first attempt failed before any input, and the queue kept its proof: the precondition of both retry items. */
function provedPreInput(ctx, label, qitemId, since) {
  const row = qitem(ctx, qitemId);
  const wakes = wakeRows(ctx, qitemId);
  ctx.verdict.info(`${label}: the first attempt as recorded`, { row, wakes });
  const result = row?.last_nudge_result ?? "";
  if (result.startsWith("unroutable:")) throw new NotRun(`${label}: the wake was recorded unroutable (#2789's path), not a failed pre-input attempt: ${result}`);
  if (!result.startsWith("failed:")) throw new NotRun(`${label}: the first attempt didn't fail before input (${result || "no result recorded"}), so the retry's precondition is unproven`);
  ctx.verdict.check(`${label}: the first attempt is a proved pre-input failure (failed, tagged ${PRE_INPUT_TAG})`,
    wakes.length === 1 && wakes[0].state === "failed" && wakes[0].tags.includes(PRE_INPUT_TAG), wakes);
  ctx.verdict.check(`${label}: nothing was pasted for it`, openrigPastes(tmuxCalls(ctx, since)).length === 0, openrigPastes(tmuxCalls(ctx, since)));
  ctx.verdict.check(`${label}: it didn't reach the model`, ctx.deliveries(qitemId).turns.length === 0, null);
  return wakes[0];
}

async function waitWake(ctx, qitemId, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await ctx.sleep(1000)) if (ctx.deliveries(qitemId).turns.length) return true;
  return ctx.deliveries(qitemId).turns.length > 0;
}

/** The retried wake as the model received it, exactly once, and not again on the next activity (no replay). */
async function retriedOnce(ctx, label, qitemId) {
  const { verdict } = ctx;
  await ctx.sleep(2000);
  const turns = ctx.deliveries(qitemId).turns;
  verdict.check(`${label}: the retried wake reached the model exactly once`, turns.length === 1, turns.map((t) => ({ seq: t.seq, index: t.index })));
  const text = turns[0]?.parts.filter((p) => p.source === "text").map((p) => p.text).join("\n") ?? "";
  verdict.info(`${label}: the wake as the model received it (native context)`, { thread: ctx.deliveries(qitemId).thread, text });
  verdict.check(`${label}: it says it's the one retry of a pre-input failure`, /Recovered queue notification: a wake that failed before input is retried once/.test(text), null);
  verdict.check(`${label}: it doesn't say delivery may repeat (no uncertain replay)`, !/may repeat/i.test(text), null);
  await ctx.settle({ timeoutMs: 60_000 });
  await ctx.sleep(20_000);
  verdict.check(`${label}: no second delivery after the seat's next activity`, ctx.deliveries(qitemId).turns.length === 1, ctx.deliveries(qitemId).turns.map((t) => t.seq));
}

/** Delivered is not picked up: the row is still unclaimed after the wake, and a claim is the seat's own, separate step. */
async function deliveredNotClaimed(ctx, label, qitemId) {
  const after = qitem(ctx, qitemId);
  ctx.verdict.check(`${label}: delivered, not picked up (the row is still pending and unclaimed, with no result)`,
    after?.state === "pending" && !after?.claimed_at && !after?.closure_reason, after);
  const claim = await ctx.cell.rig(["queue", "claim", qitemId, "--json"], { allowFail: true, as: ctx.cell.session });
  const claimed = qitem(ctx, qitemId);
  ctx.verdict.check(`${label}: the claim is its own step (in-progress, claimed only now)`, claim.exit === 0 && claimed?.state === "in-progress" && !!claimed?.claimed_at, { exit: claim.exit, row: claimed });
}

/** Bring the seat back with its conversation, as an operator would (rig down, rig up <rig> --existing). */
async function resumeSeat(ctx, label) {
  const down = await ctx.cell.rig(["down", RIG, "--json", "--yes"], { allowFail: true, timeout: 120_000 });
  ctx.verdict.info(`${label}: rig down`, { exit: down.exit, out: json(down) });
  const up = await ctx.cell.rig(["up", RIG, "--existing", "--json"], { allowFail: true, timeout: 240_000 });
  ctx.verdict.info(`${label}: rig up --existing`, { exit: up.exit, out: json(up) });
  if (up.exit !== 0) throw new NotRun(`${label}: the seat didn't come back (rig up --existing exit ${up.exit})`);
  const pane = (await ctx.cell.tmux(["display-message", "-p", "-t", ctx.cell.session, "#{pane_id}"]).catch(() => "")).trim();
  if (pane) ctx.cell.paneId = pane;
  return pane || null;
}

// Item 4: the person's draft typed after OpenRig's paste and before the read that precedes its Enter (#3176's gap).
async function preparePreEnter(ctx) {
  await ctx.setGuard("draft-aware");
  await ctx.setDraftDelivery("refuse");
  await ctx.settle();
  ctx.verdict.info("the input box before the gap", { text: await ctx.readComposer() });
  ctx.verdict.info("scope (source, 795dcc853)", "an ordinary rig send and a watchdog notice carry no write-time check (beforeKeys), so this proves the "
    + "post-paste refusal but can't tell the code before and after 795dcc853 apart; only a conditional send (expectedIdentity) could");
}

async function judgePreEnter(ctx, { draft, marker, since }) {
  const { verdict } = ctx;
  const fired = await ctx.waitInjection();
  if (!fired) throw new NotRun("OpenRig made no paste to the seat's pane, so the gap was never reached");
  // The barrier, positively: the paste had finished and shows OpenRig's text without the draft, then the draft showed,
  // and only after that did OpenRig read the input box. A draft seen before the paste would be #3076's gap, not this.
  if (fired.at !== "pre-enter" || fired.pasteRc !== 0) throw new NotRun(`the injection didn't run after a finished paste (at ${fired.at}, paste exit ${fired.pasteRc})`);
  if (!fired.visible) throw new NotRun("the draft never showed on screen after the paste, so the precondition is unproven");
  if ((fired.screenAfterPaste ?? "").includes(draft)) throw new NotRun("the draft was already on screen before the paste finished: that's the pre-paste gap, not this one");
  // Only a styled read of the armed pane, after the draft showed and before that delivery's Enter, is the read that
  // precedes its Enter. OpenRig's other styled captures (the activity probe's draft re-read, the input-box annotation)
  // aren't, so one aimed elsewhere or coming after the Enter doesn't count. With no Enter, the poll bounds the window.
  const barrierWindow = () => {
    const calls = tmuxCalls(ctx, since);
    const enterNs = calls.find((c) => c.argv[0] === "send-keys" && targetOf(c.argv) === fired.target && c.timeNs > fired.pasteDoneNs
      && c.argv.some((a) => a === "Enter" || a === "C-m"))?.timeNs ?? null;
    const reads = calls.filter((c) => c.argv[0] === "capture-pane" && c.argv.includes("-e") && targetOf(c.argv) === fired.target
      && c.timeNs > fired.visibleNs && (enterNs === null || c.timeNs < enterNs));
    return { enterNs, reads };
  };
  let barrier = barrierWindow();
  // fired.json precedes the wrapper's return; an automatic notice may still owe its post-paste read.
  const deadline = Date.now() + 10_000;
  while (barrier.reads.length === 0 && Date.now() < deadline) {
    await ctx.sleep(100);
    barrier = barrierWindow();
  }
  const { enterNs, reads } = barrier;
  verdict.info("the barrier: the paste finished, then the draft showed, then OpenRig read the input", {
    pane: fired.target, pasteDoneNs: fired.pasteDoneNs, typedNs: fired.typedNs, visibleNs: fired.visibleNs, enterNs, readsBefore: reads.map((r) => r.timeNs),
    screenAfterPaste: ctx.composerOf(fired.screenAfterPaste) });
  verdict.check("barrier: OpenRig read the armed pane's input box after the draft showed and before that delivery's Enter", reads.length > 0, reads.length);
  await ctx.sleep(4000);
  await ctx.settle({ timeoutMs: 20_000 });
  const enters = ctx.paneWrites(since).filter((w) => w.argv[0] === "send-keys" && w.argv.some((a) => a === "Enter" || a === "C-m") && w.timeNs > fired.pasteDoneNs);
  verdict.check("Enter wasn't pressed after the paste", enters.length === 0, enters);
  const after = await ctx.readComposer();
  verdict.info("the input box afterwards, exactly", { text: after });
  verdict.check("the person's draft is still in the input box, unchanged", (after ?? "").includes(draft), { draft, after });
  verdict.check("the person's draft never reached the model", !ctx.requests().some((r) => r.body && JSON.stringify(r.body).includes(draft)), null);
  verdict.check("OpenRig's text didn't reach the model either", ctx.deliveries(marker).turns.length === 0 && !ctx.requests().some((r) => r.body && JSON.stringify(r.body).includes(marker)), null);
  return fired;
}

// Item 5: Claude's own AskUserQuestion dialog (#3256's question footer family).
const QUESTION = "Delivery fixture: which colour?";
const QUESTION_FOOTER = [/^Enter to select · .+ · Esc to cancel$/m];

export const CASES = [
  {
    id: "C7-3339-withdrawal",
    title: "#3339 native-route permission withdrawal while native work is in flight (item 1)",
    programs: ["claude", "codex"],
    notRun: "no runner in this kit can take #3339's native route: on main (26598a18), runner-channel.ts:7-11 gives a native kind only to a managed-Pi "
      + "(pi or omp), preset or hosted-Pi-RPC binding, and RunnerChannel implements those three (:25); a Claude Code or Codex seat gets none, so admission "
      + "throws runner_unavailable (\"No current capable native runner; input was not offered\") and no native work can be in flight. Capability gap: "
      + "a managed-Pi or preset (dsh) runner install and launch in a cell",
    script: () => ({ rules: [ACK] }),
    async run() { throw new NotRun(this.notRun); },
  },
  {
    id: "C7-3311-current-binding",
    title: "#3311: a wake that failed before input on the seat's old binding is retried once on its current one, never on the old (item 2)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [ACK] }),
    async run(ctx) {
      const { verdict, cell } = ctx;
      await ctx.settle();
      const old = seatBinding(ctx);
      verdict.info("the seat's binding before", old);
      if (!old?.pane) throw new NotRun("the seat's binding has no pane, so an old binding can't be proven");
      const since = ctx.nowNs();
      verdict.info("fixture operator action (scripted, not a person): the seat's tmux session is ended, so its binding is unreachable", cell.session);
      await cell.tmux(["kill-session", "-t", cell.session]).catch((e) => verdict.info("kill-session", String(e.message ?? e)));
      await ctx.sleep(2000);
      verdict.info("the seat's binding after its session ended", seatBinding(ctx));
      const { qitemId } = await queueTo(ctx, "wake");
      await firstAttempt(ctx, qitemId);
      const proved = provedPreInput(ctx, "old binding", qitemId, since);
      if (!proved.binding?.pane) throw new NotRun("the failed wake froze no pane, so the old binding is unproven");
      const pane = await resumeSeat(ctx, "the seat comes back on a new binding");
      const current = seatBinding(ctx);
      verdict.info("the seat's binding now", { current, tmuxPane: pane });
      if (!current?.pane || current.pane === proved.binding.pane) throw new NotRun(`the seat came back on the same pane (${current?.pane}), so no binding change happened`);
      if (!(await waitWake(ctx, qitemId, 120_000))) verdict.check("current binding: the retried wake reached the model", false, { row: qitem(ctx, qitemId), wakes: wakeRows(ctx, qitemId) });
      else await retriedOnce(ctx, "current binding", qitemId);
      const notes = transitions(ctx, qitemId).filter((t) => (t.transition_note ?? "").startsWith("queue wake binding reconciled"));
      const moved = notes.map((t) => { try { return JSON.parse(t.transition_note.slice("queue wake binding reconciled ".length)); } catch { return null; } });
      verdict.info("the queue's own record of the move", notes);
      verdict.check("current binding: one recorded move, from the old pane to the current one",
        moved.length === 1 && moved[0]?.from?.pane === proved.binding.pane && moved[0]?.to?.pane === current.pane, moved);
      const wakes = wakeRows(ctx, qitemId);
      verdict.check("current binding: one wake row, now bound to the current pane and occupant, its proof spent",
        wakes.length === 1 && wakes[0].binding?.pane === current.pane && wakes[0].binding?.occupant === current.occupant && !wakes[0].tags.includes(PRE_INPUT_TAG), wakes);
      const pastes = openrigPastes(tmuxCalls(ctx, since));
      verdict.check("current binding: nothing pasted at the old pane; the retry's paste went to the current one",
        !pastes.some((p) => targetOf(p.argv) === proved.binding.pane) && pastes.some((p) => targetOf(p.argv) === current.pane), pastes.map((p) => targetOf(p.argv)));
      await deliveredNotClaimed(ctx, "current binding", qitemId);
    },
  },
  {
    id: "C7-3243-same-binding",
    title: "#3243: a wake that failed before input is retried once on the same binding, with its sender, channel, outbox and nudge receipt; delivered isn't picked up (item 3)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [ACK] }),
    async run(ctx) {
      const { verdict, cell } = ctx;
      await ctx.settle();
      const before = seatBinding(ctx);
      verdict.info("the seat's binding before", before);
      if (!before?.pane) throw new NotRun("the seat's binding has no pane");
      const since = ctx.nowNs();
      const away = `${RIG}-away-${Math.random().toString(36).slice(2, 6)}`;
      verdict.info("fixture operator action (scripted, not a person): the seat's tmux session is renamed away, so it can't be found; its pane stays", away);
      await cell.tmux(["rename-session", "-t", cell.session, away]);
      const { qitemId } = await queueTo(ctx, "wake");
      await firstAttempt(ctx, qitemId);
      let proved;
      try { proved = provedPreInput(ctx, "same binding", qitemId, since); }
      finally {
        verdict.info("fixture operator action (scripted, not a person): the session's own name is restored", cell.session);
        await cell.tmux(["rename-session", "-t", away, cell.session]);
      }
      // The retry runs on the seat's next activity. If none comes on its own, the fixture prompts the seat itself.
      let trigger = "the seat's own activity";
      if (!(await waitWake(ctx, qitemId, 30_000))) {
        trigger = "a fixture operator prompt";
        const nudge = ctx.mark("nudge");
        await ctx.operatorKeys("a prompt so the seat has activity (the retry runs on activity, not a timer)", "-l", `Fixture operator prompt ${nudge}`);
        await ctx.operatorKeys("submit that prompt", "Enter");
        await ctx.settle({ timeoutMs: 60_000 });
      }
      verdict.info("same binding: what set off the retry", trigger);
      if (!(await waitWake(ctx, qitemId, 90_000))) { verdict.check("same binding: the retried wake reached the model", false, { row: qitem(ctx, qitemId), wakes: wakeRows(ctx, qitemId) }); return; }
      await retriedOnce(ctx, "same binding", qitemId);
      const after = seatBinding(ctx);
      const wakes = wakeRows(ctx, qitemId);
      verdict.check("same binding: the binding didn't change", after?.pane === before.pane && after?.occupant === before.occupant, { before, after });
      verdict.check("same binding: the same single wake row (its id, sender and binding kept), its proof spent",
        wakes.length === 1 && wakes[0].outboxId === proved.outboxId && wakes[0].sender === SENDER && wakes[0].binding?.pane === before.pane && !wakes[0].tags.includes(PRE_INPUT_TAG), wakes);
      const row = qitem(ctx, qitemId);
      verdict.info("same binding: the nudge receipt", { first: "failed:… (above)", now: row?.last_nudge_result });
      verdict.check("same binding: the nudge receipt reads the retry's delivery", /^(verified|delivered)/.test(row?.last_nudge_result ?? ""), row?.last_nudge_result);
      const text = ctx.deliveries(qitemId).turns[0]?.parts.map((p) => p.text).join("\n") ?? "";
      verdict.check("same binding: the model sees the actual sender and the queue channel", text.includes(SENDER) && text.includes(qitemId), null);
      await deliveredNotClaimed(ctx, "same binding", qitemId);
    },
  },
  {
    id: "C7-3176-send",
    title: "post-paste refusal (not #3176's fix): a draft typed after an ordinary send's paste and before the read that precedes its Enter keeps Enter from being pressed (item 4)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "got it" }] }),
    async run(ctx) {
      await preparePreEnter(ctx);
      const draft = `PERSONDRAFT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const marker = ctx.mark("send");
      const since = ctx.nowNs();
      ctx.armDraftInjection(draft, { at: "pre-enter" });
      const sent = await ctx.send(`Delivery check ${marker}: a send meeting a draft after its paste.`);
      ctx.verdict.info("the send's own result", { exit: sent.exit, json: sent.json });
      await judgePreEnter(ctx, { draft, marker, since });
      ctx.verdict.check("the send says Enter wasn't sent because the input changed (draft_input_changed), after its paste",
        sent.json?.ok === false && sent.json?.reason === "draft_input_changed" && sent.json?.inputPhase === "written", sent.json);
    },
  },
  {
    id: "C7-3176-notice",
    title: "post-paste refusal (not #3176's fix): a draft typed after a watchdog notice's paste and before the read that precedes its Enter keeps Enter from being pressed (item 4)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "got it" }] }),
    async run(ctx) {
      await preparePreEnter(ctx);
      const draft = `PERSONDRAFT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const marker = ctx.mark("notice");
      const since = ctx.nowNs();
      ctx.armDraftInjection(draft, { at: "pre-enter" });
      const jobId = await ctx.registerReminder(`Reminder ${marker}: a watchdog notice meeting a draft after its paste.`, 5);
      try {
        await judgePreEnter(ctx, { draft, marker, since });
      } finally {
        ctx.verdict.info("the notice's own record", { status: await ctx.watchdogStatus(jobId), held: await ctx.heldMessages() });
        await ctx.stopWatchdog(jobId);
      }
    },
  },
  {
    id: "C7-3176-conditional",
    title: "#3176's fix itself: a conditional send's own check before Enter, then the input read, so a draft typed during that check isn't submitted (item 4)",
    programs: ["claude", "codex"],
    notRun: "not built this round: 795dcc853 only moves the guard's input read after the caller's beforeKeys (tmux.ts:1237-1244), and beforeKeys exists "
      + "only for a conditional send with expectedIdentity (session-transport.ts:3458), so an ordinary send and a watchdog notice keep the same order "
      + "with or without the fix. The discriminating leg sends through /send-expected (routes/transport.ts:59) and types the draft when its check "
      + "reads the pane pid (tmux display-message \"#{pane_pid}\", expected-conversation.ts:63) after the armed paste: before the fix Enter submits "
      + "the draft, after it the send is draft_input_changed. Capability gap: a wrapper trigger at that call and the seat's expected identity in the case",
    script: () => ({ rules: [ACK] }),
    async run() { throw new NotRun(this.notRun); },
  },
  {
    id: "C7-AUQ",
    title: "Claude's AskUserQuestion dialog (#3256): a peer send and an automatic notice are refused or held before input; nothing is chosen or answered for the person (item 5)",
    programs: ["claude"],
    script: () => ({ rules: [
      { when: "DLV-C7-AUQ-ask", times: 1, tool: { name: "AskUserQuestion", input: { questions: [{ question: QUESTION, header: "Fixture", multiSelect: false,
        options: [{ label: "Red", description: "fixture option A" }, { label: "Blue", description: "fixture option B" }] }] } } },
      { on: "tool_result", say: "tool round done" },
      ACK,
    ] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      const ask = ctx.mark("ask");
      await ctx.send(`Delivery check ${ask}: please ask the fixture's question.`);
      await ctx.waitDelivered(ask, { timeoutMs: 30_000 });
      const offered = ctx.requests().find((r) => JSON.stringify(r.body ?? "").includes(ask) && Array.isArray(r.body?.tools));
      if (!offered?.body.tools.some((t) => t?.name === "AskUserQuestion")) throw new NotRun("this Claude didn't offer an AskUserQuestion tool, so its question dialog can't be opened");
      const dialog = await ctx.waitScreenAny(QUESTION_FOOTER, { timeoutMs: 45_000 });
      const screen = (await ctx.observe()).screen;
      if (!dialog || !screen.includes(QUESTION) || !/❯\s*1\.\s*Red/.test(screen)) throw new NotRun("the question dialog wasn't positively on screen (footer, question and highlighted first option)");
      verdict.info("the question dialog on screen", { footer: String(dialog.pattern), region: dialogRegion(screen, /Delivery fixture: which colour/) });
      const pending = await sendIntoDialog(ctx, "pending", /Delivery fixture: which colour/);
      verdict.check("peer send: no answer reached the model (no tool result yet)", !ctx.requests().some((r) => r.turn?.kind === "tool_result"), null);

      // The automatic leg: a watchdog notice at the same dialog.
      const regionBefore = dialogRegion((await ctx.observe()).screen, /Delivery fixture: which colour/);
      const marker = ctx.mark("auto");
      const at = await attempt(ctx, "automatic", marker);
      verdict.info("automatic: the notice's outcome as recorded", { jobId: at.jobId, occurrenceIds: at.occurrenceIds, ...(at.json?.recorded ?? {}), missing: at.missing ?? null });
      if (!at.json) throw new NotRun(`automatic: ${at.missing}`);
      const writes = ctx.paneWrites(at.since);
      verdict.check("automatic: refused before input or held, with nothing written",
        ((at.json.ok === false && at.json.inputPhase === "not_reached") || (at.json.outcome === "retained" && at.json.sent === false)) && writes.length === 0, { json: at.json, writes });
      verdict.check("automatic: the dialog is unchanged", dialogRegion((await ctx.observe()).screen, /Delivery fixture: which colour/) === regionBefore, null);
      verdict.check("automatic: no answer reached the model", !ctx.requests().some((r) => r.turn?.kind === "tool_result"), null);

      await ctx.operatorKeys("Escape closes the fixture's own question; no option is chosen and no person answers it", "Escape");
      await ctx.settle({ timeoutMs: 30_000 });
      const closed = (await ctx.observe()).screen;
      verdict.check("the dialog closed", !QUESTION_FOOTER.some((p) => p.test(closed)), null);
      const result = ctx.requests().find((r) => r.turn?.kind === "tool_result");
      const resultText = result?.turn.parts.map((p) => p.text).join("\n") ?? "";
      verdict.info("the question's tool result (fixture-cancelled)", resultText);
      verdict.check("neither message was given to the model as the question's answer", !resultText.includes(pending) && !resultText.includes(marker), null);
      await resendOnce(ctx, pending);
      verdict.info("automatic: did the notice reach the model after the dialog closed (its occurrence may still be owed)", ctx.deliveries(marker).turns.map((t) => t.seq));
      verdict.check("automatic: never inside a tool result", !ctx.requests().some((r) => r.turn?.kind === "tool_result" && JSON.stringify(r.turn).includes(marker)), null);
    },
  },
];

/** The nine items, each named, with what runs it. `cases` are registered case ids; item 9 is a run option. */
export const C7_0719_ITEMS = [
  { item: 1, name: "#3339 native-route permission withdrawal", source: "8d94c0009", cases: ["C7-3339-withdrawal"] },
  { item: 2, name: "#3311 current-binding wake retry", source: "04e0c6c9e", cases: ["C7-3311-current-binding"] },
  { item: 3, name: "#3243 same-binding retry and wake attribution", source: "f6dac8030", cases: ["C7-3243-same-binding"] },
  { item: 4, name: "#3176 pre-Enter gap: its fix's own leg (a conditional send, NOT RUN) and the post-paste refusal it doesn't change", source: "795dcc853",
    cases: ["C7-3176-conditional", "C7-3176-send", "C7-3176-notice"] },
  { item: 5, name: "Claude's own AskUserQuestion dialog (#3256; native-standin)", source: "afd88f2ef", cases: ["C7-AUQ"] },
  { item: 6, name: "D12 managed compaction followed by a restore", source: "Builder A's D12 (cf1554ac4, carried)", casesFrom: "d12.mjs" },
  { item: 7, name: "D18 priority cells: automatic outcome reasons", source: "d18.mjs", cases: ["D18-urgent-only", "D18-sends-only", "D18-hold", "D18-queue-only"] },
  { item: 8, name: "D15 multi-line, and its #2800 unreadable-input control", source: "s2.mjs", cases: ["D15", "D15-2800-unreadable"] },
  { item: 9, name: "older tmux beside 3.6", source: "run.mjs --tmux", runOption: "--tmux" },
];
