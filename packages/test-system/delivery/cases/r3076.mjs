// Issue #3076's late gap, made deterministic: a person types into an empty input box after OpenRig's draft-aware read
// found it empty, and before OpenRig's paste. The logging tmux types the draft at exactly that boundary (after the
// guard's final read, before paste-buffer runs) and waits until the draft is on screen before letting the paste go.
//
// Evidence level: the real TUI, with timing injected at the wrapper boundary. Not covered here, each a separate
// control: text already present before the read, broker input before or after the guard's final check, and a real
// plain `tmux attach` client typing.
//
import { NotRun } from "../harness/case-context.mjs";

// Two cases, each with its own verdict: the same gap for an ordinary `rig send` (the send control), and for an actual
// watchdog-originated notice (the automatic-notice leg). No version's outcome is assumed.

/** Judge the input box and the model after the injected draft met OpenRig's write. Contamination (OpenRig's text in
 *  the person's input, or submitted with it) is FAIL even with no Enter; a changed or lost draft is classified apart. */
async function judgeGap(ctx, { draft, marker, since }) {
  const { verdict } = ctx;
  const fired = await ctx.waitInjection();
  if (!fired) { verdict.skip("OpenRig made no paste to the seat's pane, so the gap was never reached"); return; }
  if (!fired.visible) { verdict.skip("the injected draft never showed on screen before the paste, so the precondition is unproven"); return; }
  verdict.info("the injected draft, typed after OpenRig's read and before its paste", {
    buffer: fired.buffer, target: fired.target, typedToVisibleMs: Math.round((fired.visibleNs - fired.typedNs) / 1e6),
    inputBeforeTyping: ctx.composerOf(fired.screenBeforeTyping), inputBeforePaste: ctx.composerOf(fired.screenBeforePaste) });
  await ctx.sleep(4000);
  await ctx.settle({ timeoutMs: 20_000 });
  // An unreadable input box is unknown, never empty: readComposer makes the cell NOT RUN instead.
  const after = await ctx.readComposer();
  verdict.info("the input box afterwards, exactly", { text: after, bytes: Buffer.byteLength(after) });
  // The input box must hold the draft and nothing else. A program can show a paste as a placeholder rather than its
  // text (Claude Code: "[Pasted text #1 +6 lines]"), so any residue counts, not only OpenRig's marker; the empty
  // box's own placeholder, as seen before the person typed, doesn't.
  const normal = (text) => (text ?? "").replaceAll("\u00a0", " ").trim();
  const residue = normal(normal(after).replace(draft, ""));
  const emptyBox = ctx.composerOf(fired.screenBeforeTyping);
  if (emptyBox === null) throw new NotRun("the empty input box wasn't readable before the person typed");
  const contaminated = residue.length > 0 && residue !== normal(emptyBox);
  verdict.check("contamination: nothing but the person's draft is in the input box", !contaminated, { after, residue });
  const merged = ctx.requests().filter((r) => r.body && JSON.stringify(r.body).includes(draft) && JSON.stringify(r.body).includes(marker));
  verdict.check("contamination: the draft and OpenRig's text never reached the model together", merged.length === 0, merged.map((r) => r.seq));
  verdict.check("the person's draft is in the input box, unchanged", normal(after).includes(draft), { draft, after });
  verdict.check("the person's draft never reached the model", !ctx.requests().some((r) => r.body && JSON.stringify(r.body).includes(draft)), null);
  const writes = ctx.paneWrites(since);
  verdict.info("OpenRig's writes to the pane from the arm on (paste and Enter evidence)", writes);
  verdict.info("Enter pressed by OpenRig after the paste", writes.some((w) => w.argv[0] === "send-keys" && w.argv.includes("Enter")));
  const listed = await ctx.heldMessages();
  verdict.info("held messages afterwards", JSON.stringify(listed).includes(marker) ? "OpenRig's text is held" : "not held");
  verdict.info("model requests carrying OpenRig's text", ctx.requests().filter((r) => r.body && JSON.stringify(r.body).includes(marker)).map((r) => ({ seq: r.seq, thread: r.request?.thread })));
}

async function prepare(ctx) {
  await ctx.setGuard("draft-aware");
  await ctx.setDraftDelivery("refuse");
  await ctx.settle();
  const input = await ctx.readComposer();
  ctx.verdict.info("the input box before the gap", { text: input });
}

export const CASES = [
  {
    id: "R3076-send",
    title: "#3076 late gap: a draft typed after the read, before an ordinary send's paste",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "got it" }] }),
    async run(ctx) {
      await prepare(ctx);
      const draft = `PERSONDRAFT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const marker = ctx.mark("send");
      const since = ctx.nowNs();
      ctx.armDraftInjection(draft);
      const sent = await ctx.send(`Delivery check ${marker}: a send meeting a late draft.`);
      ctx.verdict.info("the send's own result", { exit: sent.exit, json: sent.json, stdout: sent.stdout });
      ctx.verdict.info("OpenRig's own account of the paste", /pasted/i.test(sent.json?.error ?? "") ? "it says it pasted and didn't press Enter" : sent.json?.reason ?? null);
      await judgeGap(ctx, { draft, marker, since });
    },
  },
  {
    id: "R3076-notice",
    title: "#3076 late gap: a draft typed after the read, before a watchdog notice's paste",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "got it" }] }),
    async run(ctx) {
      await prepare(ctx);
      const draft = `PERSONDRAFT${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const marker = ctx.mark("notice");
      const since = ctx.nowNs();
      ctx.armDraftInjection(draft);
      const jobId = await ctx.registerReminder(`Reminder ${marker}: a watchdog notice meeting a late draft.`, 5);
      try {
        await judgeGap(ctx, { draft, marker, since });
      } finally {
        await ctx.stopWatchdog(jobId);
      }
    },
  },
];
