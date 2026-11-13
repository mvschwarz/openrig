// D18: every typing-guard mode, against every input state and every kind of sender. Judged by expected.yaml's D18:
// one cell per mode and program walks the states (idle, draft, dialog, copy mode, busy) and, in each, the senders
// (a deliberate send, a deliberate urgent send, OpenRig's own watchdog reminder). An outcome the expected matrix
// doesn't state is recorded, not judged.
//
// The harness's sends carry no sender identity, so per-sender coalescing (which doesn't apply to unattributed
// senders) isn't exercised here.
import { NotRun } from "../harness/case-context.mjs";

const MODES = ["off", "draft-aware", "openrig-urgent", "urgent-only", "sends-only", "hold"];
// The dialog runs last: where a version types into it, the program's state (a model chosen, a sub-dialog open) is no
// longer the one the later states assume.
const STATES = ["idle", "draft", "copy_mode", "busy", "dialog"];
const SENDERS = ["deliberate", "deliberate_urgent", "automatic"];
const PICKER = [/Select model/i, /Select Model and Effort/];

/** Whether a mode lets this kind of sender type at all (seat-delivery.md's mode table). */
function permitted(mode, sender) {
  if (mode === "hold") return false;
  if (mode === "openrig-urgent") return sender !== "deliberate";
  if (mode === "urgent-only") return sender === "deliberate_urgent";
  if (mode === "sends-only") return sender !== "automatic";
  return true;
}

/** The expected outcome of one cell of the matrix, from expected.yaml's expect_matrix:
 *  deliver | merge | refuse | copy-then-deliver | held (with reasons allowed) | record. */
export function expectFor(mode, state, sender) {
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
    return { draft: { type: "held", reasons: ["draft_input_busy"] }, copy_mode: { type: "held", reasons: null },
      busy: { type: "deliver-or-held", reasons: ["draft_input_unknown"] } }[state];
  }
  // openrig-urgent and urgent-only: a permitted sender "never over a draft"; copy mode and busy aren't stated.
  if (state === "draft") return { type: "held", reasons: null };
  return { type: "record" };
}

async function enterState(ctx, state, label) {
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
    // The person submits a prompt the stand-in answers slowly: the program is mid-turn when the sender arrives.
    const busy = ctx.mark("busy");
    await ctx.typeDraft(`Busy turn ${busy}`);
    await ctx.sleep(300);
    await ctx.personKeys("Enter");
    if (!(await ctx.waitDelivered(busy, { timeoutMs: 15_000 })).turns.length) throw new NotRun(`the busy turn never reached the model (${label})`);
    return { busy };
  }
  return {};
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
  } else if (state === "busy") {
    await ctx.sleep(1000);
  }
  await ctx.settle({ timeoutMs: 40_000 });
}

/** One sender's attempt, and what OpenRig said and did. */
async function attempt(ctx, sender, marker) {
  const body = `Delivery check ${marker}: ${sender.replace("_", " ")} message.`;
  const since = ctx.nowNs();
  if (sender === "automatic") {
    const jobId = await ctx.registerReminder(`Reminder ${marker}: an automatic notice.`, 5);
    try {
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        if (ctx.deliveries(marker).turns.length || ctx.paneWrites(since).length || JSON.stringify(await ctx.heldMessages()).includes(marker)) break;
        await ctx.sleep(1000);
      }
      await ctx.sleep(2000);
    } finally { await ctx.stopWatchdog(jobId); }
    return { since, json: null };
  }
  const sent = await ctx.send(body, sender === "deliberate_urgent" ? ["--urgent"] : []);
  return { since, json: sent.json, exit: sent.exit };
}

/** Judge one attempt against its expected outcome. Returns the held outboxIds to retire. */
async function judge(ctx, { mode, state, sender, marker, since, json, expect, entered }) {
  const { verdict } = ctx;
  const name = `${state} · ${sender}`;
  const held = (await ctx.heldMessages())?.items?.filter((i) => (i.body ?? "").includes(marker)) ?? [];
  const writes = ctx.paneWrites(since);
  const waitFor = expect.joins ? 60_000 : 30_000;
  const delivered = (expect.type === "deliver" || expect.type === "merge" || expect.type === "copy-then-deliver" || expect.type === "deliver-or-held")
    ? (await ctx.waitDelivered(marker, { timeoutMs: held.length || json?.outcome === "retained" ? 3000 : waitFor })).turns
    : ctx.deliveries(marker).turns;
  const seen = { json, delivered: delivered.length, held: held.map((h) => ({ outboxId: h.outboxId, state: h.deliveryState })), writes: writes.length };
  const isHeld = (reasons) => (json ? json.outcome === "retained" && json.sent === false && (!reasons || reasons.includes(json.reason)) && json.outboxIds?.length > 0 : held.length > 0)
    && writes.length === 0 && delivered.length === 0;

  switch (expect.type) {
    case "deliver":
      verdict.check(`${mode}: ${name}: delivered once`, delivered.length === 1, seen);
      break;
    case "merge": {
      const merged = delivered.some((t) => t.parts.some((p) => p.text.includes(entered.draft)));
      const input = await ctx.readComposer().catch(() => "");
      verdict.check(`${mode}: ${name}: delivered once, and the draft not lost (merged and submitted, the default)`, delivered.length === 1 && (merged || input.includes(entered.draft)), { ...seen, merged, input });
      break;
    }
    case "refuse":
      verdict.check(`${mode}: ${name}: refused before input (${expect.reasons ? expect.reasons.join(" or ") : "any reason"}), nothing written or delivered`,
        writes.length === 0 && delivered.length === 0 && (!json || (json.sent === false && (!expect.reasons || expect.reasons.includes(json.reason)))), seen);
      break;
    case "copy-then-deliver":
      verdict.check(`${mode}: ${name}: copy mode left through the seat's address, then delivered once`, delivered.length === 1 && !(await ctx.inMode()), seen);
      break;
    case "held":
      verdict.check(`${mode}: ${name}: held (${expect.reasons ? expect.reasons.join(" or ") : "any reason"}), retained, no write, not delivered`, isHeld(expect.reasons), seen);
      if (held.length) verdict.check(`${mode}: ${name}: readable with rig seat held-messages`, true, null);
      else if (json?.outcome === "retained") verdict.check(`${mode}: ${name}: readable with rig seat held-messages`, false, seen);
      break;
    case "deliver-or-held":
      verdict.check(`${mode}: ${name}: delivered once, or held (${expect.reasons.join(" or ")}) with no write`, delivered.length === 1 || isHeld(expect.reasons), seen);
      break;
    default:
      verdict.info(`${mode}: ${name}: not stated by the expected matrix; recorded`, seen);
  }
  return held.map((h) => h.outboxId).concat(json?.outcome === "retained" ? json.outboxIds ?? [] : []);
}

function modeCase(mode) {
  return {
    id: `D18-${mode}`,
    title: `typing guard ${mode}: every state × every sender`,
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ when: "DLV-D18-[^ ]*-busy-", delayMs: 20_000, say: "the slow turn is done" }, { say: "ack {{marker}}" }] }),
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
      const retired = [];
      const heldMarkers = [];
      for (const state of STATES) {
        for (const sender of SENDERS) {
          const marker = ctx.mark(`${state.replace("_", "")}${sender === "automatic" ? "auto" : sender === "deliberate" ? "send" : "urgent"}`);
          const expect = expectFor(mode, state, sender);
          let outboxIds = [];
          try {
            const entered = await enterState(ctx, state, marker.split("-").at(-1));
            const { since, json } = await attempt(ctx, sender, marker);
            outboxIds = await judge(ctx, { mode, state, sender, marker, since, json, expect, entered });
            await leaveState(ctx, state, entered);
          } catch (error) {
            if (!error.notRun) throw error;
            notRun.push(`${state} · ${sender}: ${error.message}`);
            verdict.info(`${mode}: ${state} · ${sender}: NOT RUN`, error.message);
            await ctx.personKeys("Escape").catch(() => {});
            if (await ctx.inMode().catch(() => false)) await ctx.leaveCopyMode();
            await ctx.settle({ timeoutMs: 30_000, optional: true });
          }
          await clearResidue(ctx, `${mode}: ${state} · ${sender}`, empty);
          for (const id of new Set(outboxIds)) {
            heldMarkers.push(marker);
            const r = await ctx.retireHeld(id);
            retired.push({ id, ...r });
          }
        }
      }
      verdict.info("held messages retired after judging (retiring frees quota and delivers nothing)", retired);
      // Never replayed: neither retiring, nor leaving the states, nor changing the mode delivers a held message.
      if (mode !== "off") await ctx.setGuard("off");
      await ctx.settle({ timeoutMs: 20_000 });
      await ctx.sleep(10_000);
      const replayed = heldMarkers.filter((m) => ctx.deliveries(m).turns.length > 0);
      verdict.check(`${mode}: no held message was ever replayed (after retiring, leaving each state and switching to off)`, replayed.length === 0, replayed);
      // A combination that couldn't run leaves the cell NOT RUN, unless a judged one already failed.
      if (notRun.length && verdict.result !== "FAIL") verdict.skip(`combinations not run: ${notRun.join("; ")}`);
    },
  };
}

export const CASES = MODES.map(modeCase);
