// D12: managed compaction followed by a restore, on a real Claude Code seat (expected.yaml's D12, Quality's). Each step of
// a manual `rig compact` is judged by what reached the stand-in and what OpenRig recorded: the preparation prompt, the
// map the seat writes, /compact (only to an idle seat, once), the restore request after compaction, the restored seat
// reading its map, and the refocus delivered with the restore.
//
// The stand-in plays the model. It writes the map with Claude's own file tool (its path and marker taken from the
// preparation prompt), answers /compact's summary request, and reads the map that the compacted /compact names when the
// restore request asks.
//
// Arms: A (an empty input box throughout, with F's refocus check), B in both modes (a person's draft at the preparation,
// at /compact, at the restore), C (an unreadable input box), D (a permission prompt during preparation, #3144) and E
// (no usage sample, #3144). Each cell names its mode. W (Quality's hard wall, 22:39Z): rig compact --skip-map at Claude's
// native "Context limit reached" screen, with no current usage reading.
//
// Every rig compact --state read is kept verbatim in the cell's compact-state-reads.jsonl, and every reading of the seat
// (its usage projection and activity) a case takes in seat-readings.jsonl.
//
// Compaction replaces the conversation's history, so each step is found by its own words in the request that carried it,
// never by a turn that survives in a later history. The stand-in can't exercise real summarisation or a model-authored
// map's quality: those are NOT RUN, never passed.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NotRun } from "../harness/case-context.mjs";
import { seatNode } from "../harness/world.mjs";

const MAP_RULE = String.raw`restore map to "(?<tmp>[^"]+\.tmp)"[\s\S]*Completion marker: (?<marker><!-- openrig-compaction-complete \{[^\n]*?\} -->)`;

/** Each step's own words, so a step is counted once per request that delivered it. */
const STEP = {
  prep: "Write this attempt's complete restore map",
  summary: "Respond with TEXT ONLY",
  compact: "<command-name>/compact</command-name>",
  boundary: "OpenRig post-compaction turn boundary",
  restore: "Please respond to this normal user message now by restoring",
  audit: "Now audit your compaction restore",
};
const ORDER = ["preparing", "compact-sent", "restore-sent", "audit-sent"];

const markersFor = (id) => ({ prep: `DLV-${id}-prep`, compact: `DLV-${id}-compact`, restore: `DLV-${id}-restore`, audit: `DLV-${id}-audit` });

/** The stand-in's script for a compaction: each step's words pick the reply to it.
 *  `gate`: "map" holds the reply after the map is written (the preparation turn stays running), "summary" holds the
 *  summary (compaction stays running). `approval`: the preparation first runs a command that needs approval. */
function script(m, { gate = null, approval = false } = {}) {
  const writeMap = { name: "Write", input: { file_path: "{{when:tmp}}",
    content: `# Restore map (stand-in) ${m.prep}\n\nThe stand-in model wrote this map for D12.\n\n{{when:marker}}\n` } };
  return { rules: [
    // Claude's own summary request for /compact (it ends a tool-result turn as often as a user one).
    { on: "any", when: STEP.summary, ...(gate === "summary" ? { gate: "summary" } : {}),
      say: `<summary>The stand-in's summary for D12 ${m.compact}: wait for OpenRig's restore request.</summary>` },
    // The preparation turn: write the map (its marker last) with Claude's own file tool; under `approval`, first a
    // command Claude asks the person to approve.
    ...(approval ? [
      { when: `${m.prep}[\\s\\S]*${MAP_RULE}`, times: 1, tool: { name: "Bash", input: { command: "sh -c 'echo D12-approved'", description: "D12: a harmless command that needs approval (D05's)" } } },
      { on: "tool_result", within: "history", when: MAP_RULE, times: 1, tool: writeMap },
    ] : [
      { when: `${m.prep}[\\s\\S]*${MAP_RULE}`, times: 1, tool: writeMap },
    ]),
    { on: "tool_result", when: "File created successfully at: [^\\n]*RESTORE-MAP\\.md\\.tmp", times: 1, ...(gate === "map" ? { gate: "map" } : {}), say: `map written ${m.prep}` },
    { when: STEP.boundary, say: "ready for the restore request" },
    // The restore request names no map path, but the compacted history's /compact does ("Restore from this attempt's
    // map: <path>"): read that map, as the summary told the model to.
    { when: `^(?=[\\s\\S]*${STEP.restore})[\\s\\S]*?Restore from this attempt's map: (?<map>/[^\\s"'<>]*RESTORE-MAP\\.md)`, within: "history", times: 1,
      tool: { name: "Read", input: { file_path: "{{when:map}}" } } },
    { on: "tool_result", when: "openrig-compaction-complete", say: `restored from the map ${m.restore}` },
    { when: STEP.audit, say: `audit done ${m.audit}` },
    { say: "ack {{marker}}" },
  ] };
}

/** Requests whose last turn carries `text`: one per delivery, whatever later histories keep. */
const arrivals = (ctx, text) => ctx.requests().filter((r) => r.turn?.parts?.some((p) => (p.text ?? "").includes(text)));
const steps = (ctx) => Object.fromEntries(Object.entries(STEP).map(([k, text]) => [k, arrivals(ctx, text).map((r) => r.seq)]));
const turnText = (r) => (r?.turn?.parts ?? []).map((p) => p.text ?? "").join("\n");
/** OpenRig's own writes to the pane: its pastes and the keys it sent. */
const openrigWrites = (ctx, since) => ctx.paneWrites(since).filter((w) => (w.argv[0] === "paste-buffer" && w.argv.some((a) => a.startsWith("openrig_"))) || w.argv[0] === "send-keys");

async function compactState(ctx) {
  const at = new Date().toISOString();
  const out = await ctx.cell.rig(["compact", ctx.cell.session, "--state", "--json"], { allowFail: true });
  appendFileSync(join(ctx.cell.logs, "compact-state-reads.jsonl"), `${JSON.stringify({ at, exit: out.exit, stdout: out.stdout, stderr: out.stderr ?? "" })}\n`);
  try { return JSON.parse(out.stdout); } catch { return { raw: out.stdout.slice(0, 400), exit: out.exit }; }
}
const stageOf = (s) => s?.state?.stage ?? s?.stage ?? null;

/** Wait until `done(state)` or the time runs out, recording each distinct stage seen. */
async function follow(ctx, stages, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await compactState(ctx);
    const stage = stageOf(state);
    if (stage && stages.at(-1) !== stage) stages.push(stage);
    if (done(state)) return state;
    await ctx.sleep(2000);
  }
  return state;
}

/** Start a manual `rig compact`: its promise (the command's own JSON result) and when it started. */
function trigger(ctx) {
  const since = ctx.nowNs();
  const run = ctx.cell.rig(["compact", ctx.cell.session, "--json"], { allowFail: true, timeout: 240_000 }).then((out) => {
    try { return { exit: out.exit, json: JSON.parse(out.stdout) }; } catch { return { exit: out.exit, json: null, raw: out.stdout.slice(0, 600), stderr: out.stderr?.slice(0, 400) }; }
  });
  return { since, run };
}

async function setUp(ctx, m, { guard = "off" } = {}) {
  for (const [key, value] of [["pre_compact_instruction", m.prep], ["compact_instruction", m.compact], ["message_inline", `Restore check ${m.restore}.`],
    ["post_restore_audit_instruction", `Audit check ${m.audit}.`]]) {
    await ctx.cell.rig(["config", "set", `policies.claude_compaction.${key}`, value]);
  }
  if (guard !== "off") await ctx.setGuard(guard);
  ctx.verdict.info("mode", guard === "off" ? "default (typing guard off, transport.draft_delivery deliver)" : `typing guard ${guard}`);
  await ctx.settle();
}

/** Claude's PreCompact hook writes its restore packet under /tmp/claude-compaction-restore: a seat's spec can't set
 *  OPENRIG_COMPACTION_OUT_ROOT (OPENRIG_ is reserved), so it lands outside the cell. Only this cell's own packet, the
 *  directory its marker names, is removed afterwards, and its path is recorded. */
function packet(ctx) {
  const markerPath = join(ctx.cell.env.OPENRIG_HOME, "compaction", "restore-pending", `${ctx.cell.session}.json`);
  const pending = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : null;
  ctx.verdict.info("the restore-pending marker (the PreCompact and bridge hooks)", pending);
  const dir = typeof pending?.outputDir === "string" ? pending.outputDir : null;
  if (dir && dir.startsWith("/tmp/claude-compaction-restore/") && pending.sessionId && dir.includes(pending.sessionId)) {
    rmSync(dir, { recursive: true, force: true });
    ctx.verdict.info("the restore packet outside the cell (/tmp), removed after the cell", dir);
  }
}

/** The whole sequence from a trigger to the audit; returns what it saw. */
async function sequence(ctx, label, { timeoutMs = 300_000 } = {}) {
  const stages = [];
  const t = trigger(ctx);
  const sent = await follow(ctx, stages, (s) => /compact-sent|restore-sent|audit-sent|skipped|failed/.test(String(stageOf(s))), 200_000);
  const result = await t.run;
  ctx.verdict.info(`${label}: rig compact's own result`, result);
  const prep = sent?.preparation ?? sent?.state?.preparation ?? null;
  const done = await follow(ctx, stages, (s) => stageOf(s) === "audit-sent" && arrivals(ctx, STEP.audit).length > 0, timeoutMs);
  await ctx.sleep(4000);
  ctx.verdict.info(`${label}: the compaction stages rig compact --state showed, in order`, stages);
  return { stages, prep, result, done, since: t.since };
}

/** Each step exactly once, in order (A's no_loss and no_dup). */
function judgeOnce(ctx, label, count) {
  const { verdict } = ctx;
  verdict.info(`${label}: the requests that carried each step`, count);
  const once = ["prep", "summary", "compact", "boundary", "restore", "audit"];
  verdict.check(`${label}: no step was delivered twice (no_dup)`, once.every((k) => count[k].length <= 1), count);
  verdict.check(`${label}: no step was lost (no_loss)`, once.every((k) => count[k].length === 1), count);
  verdict.check(`${label}: in order: the preparation, the summary (/compact), the restore request, the audit`,
    count.prep[0] < count.summary[0] && count.summary[0] < count.restore[0] && count.restore[0] < count.audit[0], count);
}

/** Current-state polling may miss transient stages; observed stages must advance and end at audit-sent. */
function judgeStages(ctx, label, stages) {
  const seen = stages.filter((s) => ORDER.includes(s));
  ctx.verdict.check(`${label}: rig compact --state samples advance in order (${ORDER.join(" → ")}) and end at audit-sent`,
    seen.at(-1) === "audit-sent" && seen.every((s, i) => i === 0 || ORDER.indexOf(s) > ORDER.indexOf(seen[i - 1])), stages);
}

async function draftIn(ctx, draft) {
  await ctx.typeDraft(draft);
  if (!(await ctx.waitScreen(draft, { timeoutMs: 10_000 }))) throw new NotRun("the person's draft never showed in the input box");
}

const DRAFT = "PERSONDRAFT-d12 half typed by a person";

function armA() {
  const id = "D12-A";
  const m = markersFor(id);
  return {
    id, title: "managed compaction followed by a restore, empty input box at every step (manual rig compact), and the refocus after it",
    programs: ["claude"], script: () => script(m),
    async run(ctx) {
      const { verdict } = ctx;
      await setUp(ctx, m);
      const input = await ctx.readComposer();
      verdict.check("A: the input box is empty before the compaction", input.trim() === "", input);
      const seen = await sequence(ctx, "A");
      if (!seen.prep?.mapPath) throw new NotRun(`no preparation with a map path was recorded (${JSON.stringify(seen.result).slice(0, 300)})`);
      const map = existsSync(seen.prep.mapPath) ? readFileSync(seen.prep.mapPath, "utf8") : null;
      verdict.check("A: the restore map is written, its marker last", map !== null && map.trimEnd().endsWith(seen.prep.marker ?? "\u0000"), { mapPath: seen.prep.mapPath, tail: map?.slice(-200) ?? null });
      const count = steps(ctx);
      judgeOnce(ctx, "A", count);
      verdict.check("A: /compact went once: one summary request, and one /compact in the compacted history", count.summary.length === 1 && count.compact.length === 1, count);
      const readBack = ctx.requests().filter((r) => r.seq > (count.restore[0] ?? Infinity) && r.turn?.kind === "tool_result"
        && r.turn.parts?.some((p) => (p.text ?? "").includes(seen.prep.marker ?? "\u0000")));
      verdict.check("A: the restored seat read its map (a tool result after the restore request carries the map's marker)", readBack.length >= 1, readBack.map((r) => r.seq));
      judgeStages(ctx, "A", seen.stages);
      // F: the refocus delivered with the restore request names current work, or says FALLBACK; this cell has no current work.
      const restoreReq = ctx.requests().find((r) => r.seq === count.restore[0]);
      const body = JSON.stringify(restoreReq?.body ?? {});
      const refocus = body.match(/REFOCUS \([^)]*\)[\s\S]{0,4000}/)?.[0] ?? null;
      verdict.check("F: the refocus was delivered with the restore request", refocus !== null && /## WORK TRACE/.test(refocus), refocus?.slice(0, 600) ?? null);
      if (refocus) verdict.check("F: with no current work in this cell, the work trace says FALLBACK, never a current baton", /FALLBACK/.test(refocus) && !/current typed baton:/.test(refocus),
        refocus.slice(refocus.indexOf("## WORK TRACE"), refocus.indexOf("## WORK TRACE") + 500));
      packet(ctx);
      verdict.info("not judged here: the summary's quality and the map's content are the stand-in's, not a model's", null);
    },
  };
}

/** B at the preparation: a draft in the input box when rig compact starts. */
function armBPrep(mode) {
  const id = `D12-B${mode === "guard" ? "g" : "d"}-prep`;
  const m = markersFor(id);
  return {
    id, title: `a person's draft at the preparation paste (${mode === "guard" ? "B-guard: typing guard draft-aware" : "B-default: guard off"})`,
    programs: ["claude"], script: () => script(m),
    async run(ctx) {
      const { verdict } = ctx;
      await setUp(ctx, m, { guard: mode === "guard" ? "draft-aware" : "off" });
      await withUsage(ctx, "B");
      await draftIn(ctx, DRAFT);
      if (mode === "guard") {
        const t = trigger(ctx);
        const r = await t.run;
        verdict.info("B-guard: rig compact's own result with the draft present", r);
        await ctx.sleep(3000);
        verdict.check("B-guard: the preparation held before any write: nothing pasted or typed", openrigWrites(ctx, t.since).length === 0, openrigWrites(ctx, t.since));
        verdict.check("B-guard: no preparation reached the model", arrivals(ctx, STEP.prep).length === 0, arrivals(ctx, STEP.prep).map((x) => x.seq));
        verdict.check("B-guard: the manual rig compact names that it stopped to preserve the input box", /preserv/i.test(JSON.stringify(r)), r);
        const input = await ctx.readComposer();
        verdict.check("B-guard: the draft is intact, nothing appended", input.trim() === DRAFT, input);
        await ctx.eraseDraft(DRAFT.length + 4);
        await ctx.settle();
        const seen = await sequence(ctx, "B-guard, after the draft cleared");
        const count = steps(ctx);
        judgeOnce(ctx, "B-guard: once the draft cleared, the sequence", count);
        judgeStages(ctx, "B-guard", seen.stages);
      } else {
        const seen = await sequence(ctx, "B-default");
        const count = steps(ctx);
        const prepTurn = ctx.requests().find((r) => r.seq === count.prep[0]);
        verdict.info("B-default: the exact submitted bytes of the joined preparation turn", { seq: prepTurn?.seq ?? null, text: turnText(prepTurn) });
        verdict.check("B-default: no loss: the person's draft survives intact in the submitted turn or the input box", turnText(prepTurn).includes(DRAFT)
          || (await ctx.readComposer().catch(() => "")).includes(DRAFT), { inTurn: turnText(prepTurn).includes(DRAFT) });
        judgeOnce(ctx, "B-default", count);
        judgeStages(ctx, "B-default", seen.stages);
      }
      packet(ctx);
    },
  };
}

/** B at /compact or at the restore: the stand-in holds the step before it on a gate while the person types, then lets it end. */
function armBLater(mode, at) {
  const id = `D12-B${mode === "guard" ? "g" : "d"}-${at}`;
  const m = markersFor(id);
  const gate = at === "compact" ? "map" : "summary";
  return {
    id, title: `a person's draft at ${at === "compact" ? "/compact" : "the restore prompt"} (${mode === "guard" ? "B-guard: typing guard draft-aware" : "B-default: guard off"})`,
    programs: ["claude"], script: () => script(m, { gate }),
    async run(ctx) {
      const { verdict } = ctx;
      await setUp(ctx, m, { guard: mode === "guard" ? "draft-aware" : "off" });
      await withUsage(ctx, "B");
      const stages = [];
      const t = trigger(ctx);
      // The step before is running and held: the map written (for /compact) or the summary asked for (for the restore).
      const before = at === "compact" ? "File created successfully at" : STEP.summary;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && arrivals(ctx, before).length === 0) await ctx.sleep(500);
      if (!arrivals(ctx, before).length) { ctx.cell.standIn.release(gate); throw new NotRun(`the step before ${at} never reached the stand-in`); }
      await draftIn(ctx, DRAFT);
      const typedAt = ctx.nowNs();
      ctx.cell.standIn.release(gate);
      if (mode === "guard" && at === "compact") {
        const r = await t.run;
        verdict.info("B-guard: rig compact's own result with the draft present at /compact", r);
        await ctx.sleep(3000);
        verdict.check("B-guard: /compact held before any write: nothing pasted or typed after the draft", openrigWrites(ctx, typedAt).length === 0, openrigWrites(ctx, typedAt));
        verdict.check("B-guard: no /compact ran (no summary request)", arrivals(ctx, STEP.summary).length === 0, arrivals(ctx, STEP.summary).map((x) => x.seq));
        verdict.check("B-guard: the manual rig compact names that it stopped to preserve the input box", /preserv/i.test(JSON.stringify(r)), r);
        const input = await ctx.readComposer().catch(() => null);
        verdict.check("B-guard: the draft is intact, nothing appended", input !== null && input.trim() === DRAFT, input);
        await ctx.eraseDraft(DRAFT.length + 4);
        await ctx.settle();
        const again = await sequence(ctx, "B-guard, after the draft cleared");
        verdict.check("B-guard: once the draft cleared, /compact went exactly once", steps(ctx).summary.length === 1 && steps(ctx).compact.length === 1, steps(ctx));
        judgeStages(ctx, "B-guard", again.stages);
      } else if (mode === "guard") {
        // The restore steps are owed: they hold while the draft is present, then proceed exactly once.
        await t.run;
        await ctx.sleep(45_000);
        const held = await compactState(ctx);
        verdict.info("B-guard: the compaction state while the draft is present", held);
        verdict.check("B-guard: no restore step was written while the draft was present", openrigWrites(ctx, typedAt).length === 0, openrigWrites(ctx, typedAt));
        verdict.check("B-guard: no turn boundary or restore request reached the model while the draft was present",
          arrivals(ctx, STEP.boundary).length === 0 && arrivals(ctx, STEP.restore).length === 0, steps(ctx));
        const input = await ctx.readComposer().catch(() => null);
        verdict.check("B-guard: the draft is intact, nothing appended", input !== null && input.trim() === DRAFT, input);
        await ctx.eraseDraft(DRAFT.length + 4);
        await follow(ctx, stages, () => arrivals(ctx, STEP.audit).length > 0, 300_000);
        await ctx.sleep(4000);
        const count = steps(ctx);
        verdict.check("B-guard: once the draft cleared, the turn boundary, the restore request and the audit each went exactly once",
          count.boundary.length === 1 && count.restore.length === 1 && count.audit.length === 1, count);
      } else {
        // B-default: the step joins the draft. Judged on no loss, exactly once and truthful state.
        await t.run.catch(() => null);
        await follow(ctx, stages, () => arrivals(ctx, STEP.audit).length > 0, 300_000);
        await ctx.sleep(4000);
        const count = steps(ctx);
        const joined = ctx.requests().filter((r) => turnText(r).includes(DRAFT));
        verdict.info("B-default: the exact submitted bytes of each turn carrying the draft", joined.map((r) => ({ seq: r.seq, text: turnText(r) })));
        verdict.check("B-default: no loss: the person's draft survives intact in a submitted turn or the input box",
          joined.length > 0 || (await ctx.readComposer().catch(() => "")).includes(DRAFT), { turns: joined.map((r) => r.seq) });
        verdict.check("B-default: no step was delivered twice", Object.values(count).every((s) => s.length <= 1), count);
        if (at === "restore") verdict.check("B-default: after the summary, one boundary, one restore request and one audit request arrived",
          count.boundary.length === 1 && count.restore.length === 1 && count.audit.length === 1, count);
        verdict.info("B-default: the compaction state at the end", { state: await compactState(ctx), stages });
        verdict.info("B-default: the turn boundary, restore and audit prompts' text as they reached the model",
          ["boundary", "restore", "audit"].flatMap((k) => count[k].map((seq) => ({ step: k, seq, text: turnText(ctx.requests().find((r) => r.seq === seq)) }))));
        if (at === "compact") {
          // A /compact pasted after a draft is a prompt, not the command: compaction mustn't then read as done.
          const ran = count.summary.length === 1;
          verdict.info("B-default: whether the joined /compact ran as /compact (a summary request)", ran);
          if (!ran) verdict.check("B-default: truthful state: a /compact that didn't run isn't read as compacted or restored",
            !stages.some((s) => s === "restore-sent" || s === "audit-sent"), stages);
        }
      }
      packet(ctx);
    },
  };
}

/** C: an unreadable input box. The cell can't produce one on this OpenRig: NOT RUN, with why. */
function armC(mode) {
  const id = `D12-C${mode === "guard" ? "g" : "d"}`;
  return {
    id, title: `an unreadable or unknown input box (${mode === "guard" ? "C-guard" : "C-default"})`, programs: ["claude"], script: () => ({ rules: [] }),
    async run() {
      throw new NotRun("this cell can't produce an unreadable Claude input box on this OpenRig: the clipped and full auto-update footers read as empty since #3016, and copy mode is D08's own state, which OpenRig leaves or holds by mode rather than reading as unknown");
    },
  };
}

/** D (#3144): a permission prompt during a manual attempt's preparation. The attempt waits; the person answers. */
function armD() {
  const id = "D12-D";
  const m = markersFor(id);
  return {
    id, title: "a permission prompt during a manual attempt's preparation (#3144): the attempt waits, the person answers, it continues once",
    programs: ["claude"], script: () => script(m, { approval: true }),
    async run(ctx) {
      const { verdict } = ctx;
      await setUp(ctx, m);
      const stages = [];
      const t = trigger(ctx);
      const prompt = await ctx.waitScreenAny([/Do you want to proceed\?/, /Would you like to run the following command\?/], { timeoutMs: 90_000 });
      if (!prompt) throw new NotRun("the preparation's command never raised a permission prompt");
      const promptAt = ctx.nowNs();
      await ctx.sleep(12_000);
      const waiting = await compactState(ctx);
      verdict.info("D: the compaction state at the permission prompt", waiting);
      const awaiting = waiting?.preparation?.awaitingInput ?? waiting?.state?.preparation?.awaitingInput ?? null;
      verdict.check("D: the manual attempt waits at the prompt (awaitingInput, still armed), not disarmed", awaiting?.current === true && !/skipped|failed/.test(String(stageOf(waiting))), awaiting);
      verdict.check("D: nothing was typed into the dialog", openrigWrites(ctx, promptAt).length === 0, openrigWrites(ctx, promptAt));
      // The person answers the prompt, as an operator would.
      await ctx.personKeys("Enter");
      const done = await follow(ctx, stages, () => arrivals(ctx, STEP.audit).length > 0, 300_000);
      await ctx.sleep(4000);
      verdict.info("D: rig compact's own result", await t.run);
      verdict.info("D: the stages after the answer", { stages, done: stageOf(done) });
      const count = steps(ctx);
      verdict.check("D: afterwards one /compact, one restore request and one audit request arrived",
        count.summary.length === 1 && count.restore.length === 1 && count.audit.length === 1, count);
      packet(ctx);
    },
  };
}

/** OpenRig's own reading of the seat from `rig ps --nodes --full`: the usage projection rig compact reads (the same
 *  session and generation guards) and its activity. Each read is kept beside the cell's frames. */
async function seatReading(ctx) {
  const at = new Date().toISOString();
  const row = await seatNode(ctx.cell);
  const reading = { at, contextUsage: row?.contextUsage ?? null, agentActivity: row?.agentActivity ?? null, needsAttention: row?.needsAttention ?? null };
  appendFileSync(join(ctx.cell.logs, "seat-readings.jsonl"), `${JSON.stringify({ ...reading, row })}\n`);
  return reading;
}
const usageKnown = (r) => r?.contextUsage?.availability === "known";

/** Wait for OpenRig's first usage reading of the seat, as a running seat has: the context monitor polls every 30 s, and
 *  a cell can reach its trigger before the first poll. Published 0.7.15 refuses a manual request without one
 *  (no_usage_data), so a control for a step after the trigger needs it. NOT RUN if none arrives. */
async function withUsage(ctx, label) {
  const deadline = Date.now() + 90_000;
  let read = await seatReading(ctx);
  while (Date.now() < deadline && !usageKnown(read)) { await ctx.sleep(3000); read = await seatReading(ctx); }
  ctx.verdict.info(`${label}: OpenRig's usage reading before the trigger`, read.contextUsage);
  if (!usageKnown(read)) throw new NotRun("OpenRig had no usage reading of the seat within 90 s, so the trigger would meet no_usage_data where that refuses");
}

/** Remove the seat's usage sidecar and wait for the context monitor's next poll to read it missing, so the projection
 *  rig compact reads holds no reading. Returns the reads; the last one is the projection at the trigger. */
async function withoutUsage(ctx, label) {
  const sample = join(ctx.cell.env.OPENRIG_HOME, "state", "context-usage", `${ctx.cell.session}.json`);
  const reads = [await seatReading(ctx)];
  rmSync(sample, { force: true });
  // The monitor persists the sidecar's reading every 30 s; until its next poll the row keeps the last one.
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline && usageKnown(reads.at(-1))) { await ctx.sleep(3000); reads.push(await seatReading(ctx)); }
  ctx.verdict.info(`${label}: OpenRig's usage projection before and after the sidecar was removed`, { sidecar: sample, sidecarAbsent: !existsSync(sample),
    reads: reads.map((r) => ({ at: r.at, availability: r.contextUsage?.availability ?? null, reason: r.contextUsage?.reason ?? null,
      usedPercentage: r.contextUsage?.usedPercentage ?? null, sampledAt: r.contextUsage?.sampledAt ?? null, fresh: r.contextUsage?.fresh ?? null })) });
  return reads;
}

/** W (hard wall, Quality's): the seat at Claude's native "Context limit reached" screen, with no current usage reading,
 *  then rig compact --skip-map. The stand-in answers the seat's next request with the provider's real context-length
 *  error (a 400 invalid_request_error "prompt is too long: N tokens > M maximum"), and every request after it that still
 *  carries that history the same, as the API would, until compaction replaces it. Judged (a): /compact sent once and
 *  compaction happens, with truthful state; or (b): the attempt ends with a truthful named reason, never compact-sent
 *  when /compact wasn't. */
function armW() {
  const id = "D12-W";
  const m = markersFor(id);
  const work = `DLV-${id}-work`;
  const tooLong = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 212000 tokens > 200000 maximum" } } };
  const manual = "OpenRig manual compaction was requested for this seat";
  return {
    id, title: "W (hard wall): rig compact --skip-map at Claude's native 'Context limit reached' screen, with no current usage reading",
    programs: ["claude"],
    script: () => ({ rules: [
      { on: "any", when: STEP.summary, say: `<summary>The stand-in's summary for D12 ${m.compact}: wait for OpenRig's restore request.</summary>` },
      { when: STEP.boundary, say: "ready for the restore request" },
      { when: `^(?=[\\s\\S]*${STEP.restore})[\\s\\S]*?Restore from this attempt's map: (?<map>/[^\\s"'<>]*RESTORE-MAP\\.md)`, within: "history", times: 1,
        tool: { name: "Read", input: { file_path: "{{when:map}}" } } },
      { on: "tool_result", when: "openrig-compaction-complete", say: `restored from the map ${m.restore}` },
      { when: STEP.audit, say: `audit done ${m.audit}` },
      { when: STEP.restore, say: `restored without a map ${m.restore}` },
      // The wall: the request that reached it and every one after it with that history, until compaction.
      { on: "any", when: work, within: "history", error: tooLong },
      { say: "ack {{marker}}" },
    ] }),
    async run(ctx) {
      const { verdict } = ctx;
      await setUp(ctx, m);
      verdict.info("W: the provider's context-length error the stand-in answers at the wall", tooLong);
      await ctx.typeDraft(`Next task ${work}: carry on.`);
      await ctx.personKeys("Enter");
      const wall = await ctx.waitScreen("Context limit reached", { timeoutMs: 60_000 });
      if (!wall) {
        verdict.info("W: the screen after the error", ctx.screen.last()?.screen ?? null);
        throw new NotRun("the stand-in's prompt-too-long answer didn't bring Claude to its native 'Context limit reached' screen, and no simulated substitute is used");
      }
      await ctx.settle();
      verdict.info("W: the native wall screen", ctx.screen.last()?.screen ?? wall.screen);
      const reads = await withoutUsage(ctx, "W");
      const atTrigger = reads.at(-1);
      verdict.info("W: OpenRig's reading of the seat when rig compact --skip-map ran (usage projection and activity)", atTrigger);
      if (usageKnown(atTrigger)) throw new NotRun(`the seat still had a usage reading when rig compact would run (${JSON.stringify(atTrigger.contextUsage).slice(0, 300)}): the wall with no current reading couldn't be produced`);
      if (!/Context limit reached/.test(ctx.screen.last()?.screen ?? "")) throw new NotRun("the wall screen didn't stay on screen until the trigger");
      const before = arrivals(ctx, work).length;

      const stages = [], readings = [];
      const since = ctx.nowNs();
      const run = ctx.cell.rig(["compact", ctx.cell.session, "--skip-map", "--json"], { allowFail: true, timeout: 420_000 }).then((out) => {
        try { return { exit: out.exit, json: JSON.parse(out.stdout) }; } catch { return { exit: out.exit, json: null, raw: out.stdout.slice(0, 600), stderr: out.stderr?.slice(0, 400) }; }
      });
      let result = null;
      run.then((r) => { result = r; });
      const deadline = Date.now() + 480_000;
      let last = null;
      while (Date.now() < deadline) {
        last = await compactState(ctx);
        const stage = stageOf(last);
        if (stage && stages.at(-1) !== stage) stages.push(stage);
        readings.push(await seatReading(ctx));
        if (arrivals(ctx, STEP.audit).length > 0) break;
        if (result && /skipped|failed/.test(String(stage))) break;
        await ctx.sleep(2000);
      }
      await ctx.sleep(4000);
      result ??= await run;
      verdict.info("W: rig compact --skip-map's own result", result);
      verdict.info("W: the stages rig compact --state showed, in order (every read is in compact-state-reads.jsonl)", stages);
      verdict.info("W: the last rig compact --state read", last);
      verdict.info("W: whether OpenRig read the seat idle during the attempt (every read is in seat-readings.jsonl)",
        readings.map((r) => ({ at: r.at, activity: r.agentActivity, usage: r.contextUsage?.availability ?? null })));
      const count = steps(ctx);
      const preps = arrivals(ctx, manual);
      const walled = ctx.requests().filter((r) => r.action === "error").map((r) => r.seq);
      verdict.info("W: the requests that carried each step", { ...count, preparation: preps.map((r) => r.seq), wallRequests: walled, workBeforeTrigger: before });
      verdict.info("W: the preparation prompt's text as it went out", preps.map((r) => ({ seq: r.seq, text: turnText(r) })));
      verdict.info("W: OpenRig's writes to the pane after the trigger", openrigWrites(ctx, since));
      // Claude compacts on its own after a context-length error (the request right before its summary request is the
      // wall's); those summaries aren't OpenRig's /compact. /compact's own is any other, and the compacted history then
      // carries the /compact command.
      const errors = new Set(walled);
      const own = count.summary.filter((seq) => errors.has(seq - 1));
      const fromCompact = count.summary.filter((seq) => !errors.has(seq - 1));
      verdict.info("W: Claude's own compactions (a summary request right after a context-length error), not OpenRig's /compact", own);
      const ran = fromCompact.length >= 1 && count.compact.length >= 1;
      verdict.check("W: /compact went at most once (at most one summary request of its own and one /compact in the compacted history)",
        fromCompact.length <= 1 && count.compact.length <= 1, { fromCompact, own, compact: count.compact });
      verdict.check("W: never compact-sent unless /compact ran (its summary request reached the model)", !stages.includes("compact-sent") || ran, { stages, fromCompact, compact: count.compact });
      const reason = result?.json?.reason ?? last?.state?.reason ?? last?.reason ?? null;
      if (ran) {
        verdict.info("W: outcome (a): /compact ran", null);
        judgeStages(ctx, "W (a)", stages);
        verdict.check("W (a): /compact's compaction happened once and the restore followed: one summary of its own, one restore request",
          fromCompact.length === 1 && count.restore.length === 1 && count.audit.length === 1, { fromCompact, restore: count.restore, audit: count.audit });
      } else {
        verdict.info("W: outcome (b): /compact didn't run; the named reason", { reason, message: result?.json?.error ?? result?.json?.message ?? null });
        verdict.check("W (b): the attempt ended with a named reason, not a silent deadline", typeof reason === "string" && reason.length > 0
          && /skipped|failed/.test(String(stageOf(last))), { reason, stage: stageOf(last) });
      }
      packet(ctx);
    },
  };
}

/** E (#3144): a manual request with no usage sample proceeds. */
function armE() {
  const id = "D12-E";
  const m = markersFor(id);
  return {
    id, title: "a manual request with no usage data (#3144): it proceeds, with no false refusal for missing usage",
    programs: ["claude"], script: () => script(m),
    async run(ctx) {
      const { verdict } = ctx;
      await setUp(ctx, m);
      // The sidecar alone isn't the reading: the daemon's row keeps the last sample until the monitor's next poll.
      const reads = await withoutUsage(ctx, "E");
      if (usageKnown(reads.at(-1))) throw new NotRun(`OpenRig still had a usage reading at the trigger (${JSON.stringify(reads.at(-1).contextUsage).slice(0, 300)})`);
      const seen = await sequence(ctx, "E");
      verdict.check("E: the manual request proceeded without usage data (no refusal for missing usage)",
        !/usage/i.test(String(seen.result?.json?.reason ?? seen.result?.json?.error ?? "")) && seen.stages.includes("compact-sent"), { result: seen.result, stages: seen.stages });
      const count = steps(ctx);
      verdict.check("E: one /compact, one restore request and one audit request arrived",
        count.summary.length === 1 && count.restore.length === 1 && count.audit.length === 1, count);
      packet(ctx);
    },
  };
}

export const CASES = [
  armA(),
  armBPrep("guard"), armBPrep("default"),
  armBLater("guard", "compact"), armBLater("default", "compact"),
  armBLater("guard", "restore"), armBLater("default", "restore"),
  armC("guard"), armC("default"),
  armD(), armE(), armW(),
];
