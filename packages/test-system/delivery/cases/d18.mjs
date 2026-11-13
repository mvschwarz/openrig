// D18: every typing-guard mode, against every input state and every kind of sender. Judged by expected.yaml's D18:
// one cell per mode and program walks the states (idle, draft, copy mode, busy, dialog) and, in each, the senders
// (a deliberate send, a deliberate urgent send, OpenRig's own watchdog reminder). An outcome the expected matrix
// doesn't state is recorded, not judged.
//
// Every judgement rests on positive evidence of the attempt: the send's own JSON result, or the reminder occurrence's
// evaluation in the watchdog's history. Missing evidence (no occurrence, a send with no JSON result, a reason the version
// doesn't record) makes that combination NOT RUN, never a PASS by absence. A delivery is judged as s2's are: the
// complete body, exactly once after a final re-read.
//
// The harness's sends carry no sender identity, so per-sender coalescing (which doesn't apply to unattributed
// senders) isn't exercised here.
import { NotRun } from "../harness/case-context.mjs";
import { deliveredOnce } from "./s2.mjs";

const MODES = ["off", "draft-aware", "openrig-urgent", "urgent-only", "sends-only", "hold"];
// The dialog runs last: where a version types into it, the program's state (a model chosen, a sub-dialog open) is no
// longer the one the later states assume.
const STATES = ["idle", "draft", "copy_mode", "busy", "dialog"];
const SENDERS = ["deliberate", "deliberate_urgent", "automatic"];
const PICKER = [/Select model/i, /Select Model and Effort/];
// How long held and refused messages are watched for a replay after the walk and the change to off.
const REPLAY_WINDOW_MS = 15_000;

/** Whether a mode lets this kind of sender type at all (seat-delivery.md's mode table). */
function permitted(mode, sender) {
  if (mode === "hold") return false;
  if (mode === "openrig-urgent") return sender !== "deliberate";
  if (mode === "urgent-only") return sender === "deliberate_urgent";
  if (mode === "sends-only") return sender !== "automatic";
  return true;
}

/** The expected outcome of one cell of the matrix, from expected.yaml's expect_matrix:
 *  deliver | merge | refuse | copy-then-deliver | held (with reasons allowed) | record. At busy under draft-aware the
 *  matrix depends on the input box: pass `composer` ("empty" or "unreadable") as observed at the attempt; without it the
 *  outcome is the unresolved deliver-or-held. */
export function expectFor(mode, state, sender, { composer } = {}) {
  const offLike = mode === "off" || mode === "sends-only";
  if (!permitted(mode, sender)) {
    // A held mode holds before anything else; at a dialog, a refusal before input is equally no input.
    return { type: "held", reasons: state === "dialog" ? ["typing_guard_enabled", "target_needs_input"] : ["typing_guard_enabled"] };
  }
  if (state === "idle") return { type: "deliver" };
  // At a dialog, off-like modes refuse with the contract's reason; the guarded modes are stated only as "refused, no
  // write", so any no-input outcome counts there and its reason is recorded.
  if (state === "dialog") return { type: "refuse", reasons: offLike ? ["target_needs_input"] : null };
  if (offLike) return { draft: { type: "merge" }, copy_mode: { type: "copy-then-deliver" }, busy: { type: "deliver", joins: true } }[state];
  if (mode === "draft-aware") {
    if (state === "busy") {
      // "busy with an empty, recognized composer: delivered (joins the turn); unreadable: HELD draft_input_unknown"
      if (composer === "empty") return { type: "deliver", joins: true };
      if (composer === "unreadable") return { type: "held", reasons: ["draft_input_unknown"] };
      return { type: "deliver-or-held", reasons: ["draft_input_unknown"] };
    }
    return { draft: { type: "held", reasons: ["draft_input_busy"] }, copy_mode: { type: "held", reasons: null } }[state];
  }
  // openrig-urgent and urgent-only: a permitted sender "never over a draft"; copy mode and busy aren't stated.
  if (state === "draft") return { type: "held", reasons: null };
  return { type: "record" };
}

const bodyFor = (sender, marker) => sender === "automatic" ? `Reminder ${marker}: an automatic notice.` : `Delivery check ${marker}: ${sender.replace("_", " ")} message.`;

/** The input box as read from a screen: "empty" (what it showed at the cell's start), "unreadable", or "text". */
function composerCondition(ctx, screen, empty) {
  const input = ctx.composerOf(screen);
  if (input === null) return { condition: "unreadable", input };
  return { condition: input.trim() === (empty ?? "").trim() ? "empty" : "text", input };
}

async function enterState(ctx, state, label, empty) {
  if (state === "idle") {
    const { condition, input } = composerCondition(ctx, (await ctx.observe()).screen, empty);
    if (condition !== "empty") throw new NotRun(`the input box wasn't empty at the idle attempt (${condition}: ${JSON.stringify(input)})`);
    return {};
  }
  if (state === "draft") {
    const draft = `PERSONDRAFT${label}`;
    await ctx.typeDraft(draft);
    if (!(await ctx.waitScreen(draft, { timeoutMs: 10_000 }))) throw new NotRun(`the draft never showed in the input box (${label})`);
    return { draft };
  }
  if (state === "dialog") {
    await ctx.typeDraft("/model");
    await ctx.sleep(500);
    await ctx.personKeys("Enter");
    if (!(await ctx.waitScreenAny(PICKER, { timeoutMs: 15_000 }))) throw new NotRun(`the model picker didn't open (${label})`);
    await ctx.settle({ timeoutMs: 15_000 });
    return {};
  }
  if (state === "copy_mode") {
    await ctx.enterCopyMode();
    if (!(await ctx.inMode())) throw new NotRun(`the pane didn't enter copy mode (${label})`);
    return {};
  }
  if (state === "busy") {
    // The person submits a prompt whose answer the stand-in holds on a gate named after the prompt's marker: the turn
    // runs until the case releases it, after the attempt. A longer wait would prove nothing; the gate does.
    const busy = ctx.mark("busy");
    await ctx.typeDraft(`Busy turn ${busy}`);
    await ctx.sleep(300);
    await ctx.personKeys("Enter");
    if (!(await ctx.waitDelivered(busy, { timeoutMs: 15_000 })).turns.length) {
      ctx.releaseGate(busy);
      throw new NotRun(`the busy turn never reached the model (${label})`);
    }
    // Which of the matrix's two busy rows applies: the input box as it reads now, while the turn is held.
    await ctx.sleep(1000);
    const frame = await ctx.observe();
    const { condition, input } = composerCondition(ctx, frame.screen, empty);
    if (condition === "text") {
      ctx.releaseGate(busy);
      throw new NotRun(`the input box held text during the busy turn, so neither busy row applies (${JSON.stringify(input)})`);
    }
    return { busy, gate: busy, released: false, condition, screenAtAttempt: frame.screen.split("\n").slice(-8) };
  }
  return {};
}

/** Every held message that carries `marker`, as rig seat held-messages lists it. */
async function heldFor(ctx, marker) {
  return (await ctx.heldMessages())?.items?.filter((i) => (i.body ?? "").includes(marker)) ?? [];
}

/** Whatever a combination left in the input box, recorded and cleared so the next one starts from an empty input, as
 *  a person would clear it. `empty` is the input box as read at the cell's start (a program's placeholder). */
async function clearResidue(ctx, label, empty) {
  const input = await ctx.readComposer().catch(() => null);
  if (input === null || input.trim() === (empty ?? "").trim()) return null;
  await ctx.eraseDraft(Buffer.byteLength(input) + 400);
  await ctx.settle({ timeoutMs: 20_000, optional: true });
  const after = await ctx.readComposer().catch(() => null);
  ctx.verdict.info(`${label}: left in the input box afterwards, then cleared`, { input, after });
  return input;
}

async function leaveState(ctx, state, entered) {
  if (state === "draft") {
    const input = await ctx.readComposer().catch(() => "");
    if (input.includes(entered.draft)) await ctx.eraseDraft(input.length + 4);
  } else if (state === "dialog") {
    const { screen } = await ctx.observe();
    if (PICKER.some((p) => p.test(screen))) await ctx.personKeys("Escape");
  } else if (state === "copy_mode") {
    if (await ctx.inMode()) await ctx.leaveCopyMode();
  }
  await ctx.settle({ timeoutMs: 40_000 });
}

/** The reminder occurrence's evaluation as a send result: the fields a `rig send --json` result has, from the
 *  watchdog's history (`deliveryStatus`, and in `evaluationNotes` the input phase, the no-input code and the outboxIds). */
export function occurrenceResult(entry) {
  const notes = entry.evaluationNotes ?? {};
  if (entry.deliveryStatus === "ok") return { ok: true, sent: true };
  if (entry.deliveryStatus === "retained") return { ok: true, outcome: "retained", sent: false, reason: null, outboxIds: notes.outboxIds ?? [] };
  const phase = notes.deliveryInputPhase ?? null;
  return { ok: false, outcome: "failed", sent: phase === "not_reached" ? false : phase === null ? null : true, inputPhase: phase,
    reason: notes.deliveryCode ?? null, error: notes.deliveryReason ?? null };
}

/** One sender's attempt, and OpenRig's own record of what it did: the send's JSON result, or the reminder occurrence's
 *  evaluation. NOT RUN when there's no such record. */
export async function attempt(ctx, sender, marker, { occurrenceTimeoutMs = 40_000, pollMs = 1000 } = {}) {
  const since = ctx.nowNs();
  if (sender === "automatic") {
    const jobId = await ctx.registerReminder(bodyFor(sender, marker), 5);
    let entry = null;
    try {
      const deadline = Date.now() + occurrenceTimeoutMs;
      while (!entry && Date.now() < deadline) {
        const status = await ctx.watchdogStatus(jobId);
        entry = (status?.recentHistory ?? []).find((h) => h.deliveryStatus && (h.deliveryMessage ?? "").includes(marker)) ?? null;
        if (!entry) await ctx.sleep(pollMs);
      }
    } finally { await ctx.stopWatchdog(jobId); }
    if (!entry) throw new NotRun(`no occurrence of the reminder was evaluated within ${occurrenceTimeoutMs / 1000} s, so there is no attempt to judge`);
    return { since, source: "watchdog", json: occurrenceResult(entry), occurrence: entry };
  }
  const sent = await ctx.send(bodyFor(sender, marker), sender === "deliberate_urgent" ? ["--urgent"] : []);
  if (!sent.json) throw new NotRun(`the send gave no JSON result (exit ${sent.exit}): ${String(sent.stderr || sent.stdout || "").slice(0, 300)}`);
  return { since, source: "send", json: sent.json, exit: sent.exit };
}

/** Judge one attempt against its expected outcome. Returns the held outboxIds to retire, whether it was refused, and
 *  why the combination is NOT RUN when its evidence is short (only where nothing it showed was a failure). */
export async function judge(ctx, { mode, state, sender, marker, attempt: at, expect, entered }) {
  const { verdict } = ctx;
  const label = `${mode}: ${state} · ${sender}`;
  const body = bodyFor(sender, marker);
  const json = at.json;
  const writes = ctx.paneWrites(at.since);
  const held = await heldFor(ctx, marker);
  const retained = json.outcome === "retained" && json.sent === false;
  // An automatic hold's reason is on its held row's own delivery record, where the version keeps one.
  const reason = json.reason ?? held.map((i) => i.delivery?.reason).find(Boolean) ?? null;
  // The held messages are the ones held-messages lists as retained. An occurrence's outboxIds also name the occurrence
  // itself, which is no held message and can't be retired.
  const heldIds = held.filter((i) => i.deliveryState === "retained").map((i) => i.outboxId);
  const delivered = json.ok === true && !retained;
  const seen = { source: at.source, json, reason, held: held.map((h) => ({ outboxId: h.outboxId, state: h.deliveryState, reason: h.delivery?.reason ?? null })), writes: writes.length };
  // A named reason must be the one recorded; where the version records none, the combination can't be confirmed.
  const reasonFits = (reasons) => !reasons || reason === null || reasons.includes(reason);
  const reasonShort = (reasons) => reasons && reason === null ? `the outcome's reason isn't recorded by this version, so ${reasons.join(" or ")} can't be confirmed` : null;
  const nothingArrived = async () => { await ctx.sleep(3000); return ctx.deliveries(marker).turns.length === 0; };
  let notRun = null;

  switch (expect.type) {
    case "deliver":
    case "copy-then-deliver":
    case "merge": {
      if (!delivered) { verdict.check(`${label}: delivered once (the attempt's own result says it was sent)`, false, seen); break; }
      const turn = await deliveredOnce(ctx, marker, body, { label, alone: !expect.joins });
      if (expect.type === "copy-then-deliver") verdict.check(`${label}: copy mode left through the seat's address`, !(await ctx.inMode()), seen);
      if (expect.type === "merge") {
        // Merged and submitted: the draft is in the very turn that carried the message, and no longer in the input box.
        const merged = !!turn && turn.parts.some((p) => p.source === "text" && p.text.includes(entered.draft));
        const input = await ctx.readComposer().catch(() => null);
        verdict.check(`${label}: the draft merged into the message's turn and submitted (the default)`, merged && input !== null && !input.includes(entered.draft), { merged, input });
      }
      break;
    }
    case "refuse": {
      const refused = json.sent === false && writes.length === 0 && (retained || json.ok === false);
      const quiet = await nothingArrived();
      verdict.check(`${label}: refused before input (${expect.reasons ? expect.reasons.join(" or ") : "any no-input reason"}), nothing written or delivered`,
        refused && quiet && reasonFits(expect.reasons), seen);
      if (refused && quiet) notRun = reasonShort(expect.reasons);
      break;
    }
    case "held": {
      const quiet = await nothingArrived();
      const isHeld = retained && heldIds.length > 0 && writes.length === 0 && quiet;
      verdict.check(`${label}: held (${expect.reasons ? expect.reasons.join(" or ") : "any reason"}), retained, no write, not delivered`, isHeld && reasonFits(expect.reasons), seen);
      if (retained) verdict.check(`${label}: readable with rig seat held-messages`, held.length > 0, seen.held);
      if (isHeld) notRun = reasonShort(expect.reasons);
      break;
    }
    case "deliver-or-held":
      verdict.check(`${label}: delivered once, or held (${expect.reasons.join(" or ")}) with no write`, delivered || (retained && writes.length === 0 && reasonFits(expect.reasons)), seen);
      if (delivered) await deliveredOnce(ctx, marker, body, { label, alone: false });
      break;
    default:
      verdict.info(`${label}: not stated by the expected matrix; recorded`, seen);
  }
  if (entered?.condition) verdict.info(`${label}: the input box during the busy turn, at the attempt`, entered.condition);
  return { heldIds, notRun, refused: json.ok === false && json.sent === false };
}

/** After the walk: one held message kept active through a positively effective change to off, the replay window
 *  watched, then that message retired. Returns why the control can't run, or null. */
export async function modeChangeControl(ctx, { mode, kept, watched }) {
  const { verdict } = ctx;
  if (kept) {
    const before = (await ctx.heldMessages())?.items?.find((i) => i.outboxId === kept.id) ?? null;
    if (before?.deliveryState !== "retained") return `the kept held message (${kept.name}) wasn't active before the mode change (${before?.deliveryState ?? "not listed"})`;
  }
  if (mode !== "off") {
    const set = await ctx.setGuard("off");
    const effective = set?.pending === false && set?.desiredMode === "off" && set?.effectiveMode === "off" && !set?.desiredLevel && !set?.effectiveLevel;
    if (!effective) return `the change to off wasn't observed effective, so a no-replay result would prove nothing (${JSON.stringify(set)?.slice(0, 300)})`;
  }
  await ctx.settle({ timeoutMs: 20_000 });
  await ctx.sleep(REPLAY_WINDOW_MS);
  const replayed = watched.filter((m) => ctx.deliveries(m).turns.length > 0);
  verdict.check(`${mode}: no held or refused message was replayed by leaving each state${mode === "off" ? "" : " or by the change to off"} (watched ${REPLAY_WINDOW_MS / 1000} s)`,
    replayed.length === 0, { watched: watched.length, replayed });
  if (kept) {
    const after = (await ctx.heldMessages())?.items?.find((i) => i.outboxId === kept.id) ?? null;
    verdict.check(`${mode}: the held message kept active through the change (${kept.name}) is still held, not flushed or delivered`,
      after?.deliveryState === "retained" && ctx.deliveries(kept.marker).turns.length === 0, after ? { state: after.deliveryState } : null);
    const r = await ctx.retireHeld(kept.id);
    verdict.check(`${mode}: the kept held message retired afterwards`, r.exit === 0 && r.state === "retired", r);
  } else {
    verdict.info(`${mode}: no held message to keep through the change (this mode held nothing)`, null);
  }
  return null;
}

function modeCase(mode) {
  return {
    id: `D18-${mode}`,
    title: `typing guard ${mode}: every state × every sender`,
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ when: "DLV-D18-[^ ]*-busy-", gate: "{{marker}}", say: "the slow turn is done" }, { say: "ack {{marker}}" }] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      const set = await ctx.setGuard(mode);
      if (set?.pending) throw new NotRun(`the mode change is still pending (HTTP 202 pending:true); a pending mode is never read as effective`);
      // The three interruption levels report as mode "off" with the level in desiredLevel/effectiveLevel.
      const level = ["openrig-urgent", "urgent-only", "sends-only"].includes(mode);
      const shown = level ? [set?.desiredLevel, set?.effectiveLevel] : [set?.desiredMode, set?.effectiveMode];
      verdict.check(`${mode}: the status shows it desired and effective`, shown[0] === mode && shown[1] === mode && set?.pending === false, set);
      if (level) verdict.info(`${mode}: how the status reports a level`, { desiredMode: set?.desiredMode, effectiveMode: set?.effectiveMode, desiredLevel: set?.desiredLevel, effectiveLevel: set?.effectiveLevel });
      const empty = await ctx.readComposer();
      const notRun = [];
      const watched = [];
      let kept = null;
      for (const state of STATES) {
        for (const sender of SENDERS) {
          const marker = ctx.mark(`${state.replace("_", "")}${sender === "automatic" ? "auto" : sender === "deliberate" ? "send" : "urgent"}`);
          const name = `${state} · ${sender}`;
          let heldIds = [];
          let entered = null;
          let judged = false;
          try {
            entered = await enterState(ctx, state, marker.split("-").at(-1), empty);
            const at = await attempt(ctx, sender, marker);
            if (entered.gate) {
              // The attempt is over and the busy turn's answer is still held: the attempt met a running turn.
              verdict.info(`${mode}: ${name}: the busy turn was still running when the attempt ended (its answer held until now)`, { screen: entered.screenAtAttempt });
              ctx.releaseGate(entered.gate);
              entered.released = true;
            }
            const result = await judge(ctx, { mode, state, sender, marker, attempt: at, expect: expectFor(mode, state, sender, { composer: entered.condition }), entered });
            judged = true;
            heldIds = result.heldIds;
            if (heldIds.length || result.refused) watched.push(marker);
            if (result.notRun) { notRun.push(`${name}: ${result.notRun}`); verdict.info(`${mode}: ${name}: NOT RUN`, result.notRun); }
            await leaveState(ctx, state, entered);
          } catch (error) {
            if (!error.notRun) throw error;
            notRun.push(`${name}: ${error.message}`);
            verdict.info(`${mode}: ${name}: NOT RUN`, error.message);
            if (entered?.gate && !entered.released) ctx.releaseGate(entered.gate);
            await ctx.personKeys("Escape").catch(() => {});
            if (await ctx.inMode().catch(() => false)) await ctx.leaveCopyMode();
            await ctx.settle({ timeoutMs: 30_000, optional: true });
            // What a combination that couldn't be judged held is still retired, so it can't skew the later ones.
            if (!judged) heldIds = (await heldFor(ctx, marker)).filter((i) => i.deliveryState === "retained").map((i) => i.outboxId);
          }
          await clearResidue(ctx, `${mode}: ${name}`, empty);
          for (const id of heldIds) {
            // The first held message the walk judged stays active through the change to off: the replay control.
            if (!kept && judged) { kept = { id, marker, name }; continue; }
            const r = await ctx.retireHeld(id);
            verdict.check(`${mode}: ${name}: its held message retired (the later combinations rely on the freed quota)`, r.exit === 0 && r.state === "retired", r);
          }
        }
      }
      // Never replayed: neither leaving the states, nor retiring, nor changing the mode delivers a held or refused message.
      const short = await modeChangeControl(ctx, { mode, kept, watched });
      if (short) { notRun.push(`mode-change control: ${short}`); verdict.info(`${mode}: mode-change control NOT RUN`, short); }
      // A combination that couldn't run leaves the cell NOT RUN, unless a judged one already failed.
      if (notRun.length && verdict.result !== "FAIL") verdict.skip(`not run: ${notRun.join("; ")}`);
    },
  };
}

export const CASES = MODES.map(modeCase);
