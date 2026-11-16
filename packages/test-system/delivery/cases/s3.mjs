// Dialogs: a permission prompt (D05) and another native dialog (D06), on both programs. Their expected result is
// expected.yaml's `later.D05_D06`: an ordinary send refuses before any input (target_needs_input / selection_prompt),
// and nothing is typed into the dialog. A dialog that never opens leaves the cell NOT RUN, never PASS.

// Each program's own wording for the dialog, exactly: a looser pattern can match the message or the command text
// before the dialog has drawn.
import { NotRun } from "../harness/case-context.mjs";

const APPROVAL = [/Do you want to proceed\?/, /Would you like to run the following command\?/];
const PICKER = [/Select model/i, /Select Model and Effort/];

/** The dialog's own rows: from its title line to the bottom of the screen, where both programs draw it. */
function dialogRegion(screen, pattern) {
  const rows = (screen ?? "").split("\n");
  const start = rows.findIndex((row) => pattern.test(row));
  return start < 0 ? null : rows.slice(start).join("\n").trimEnd();
}

/** The contract's refusal of an ordinary send at a dialog, exactly: refused, not sent, `target_needs_input`. */
export function isRefusal(json) {
  return json?.ok === false && json?.sent === false && json?.reason === "target_needs_input";
}

/** An ordinary send while a dialog is up: refused before any input, nothing typed, the dialog unchanged, no turn. */
async function sendIntoDialog(ctx, label, dialogPattern) {
  const { verdict } = ctx;
  await ctx.settle({ timeoutMs: 15_000 });
  const before = dialogRegion((await ctx.observe()).screen, dialogPattern);
  if (before === null) throw new NotRun("the dialog wasn't on screen when the send was about to go");
  const marker = ctx.mark(label);
  const since = ctx.nowNs();
  const sent = await ctx.send(`Delivery check ${marker}: an ordinary message while a dialog is open.`);
  const sentAt = performance.now();
  // The contract's refusal, exactly: anything else (an unreadable result, another failure) proves nothing either way.
  const refused = isRefusal(sent.json);
  if (!refused && sent.json?.ok !== true) throw new NotRun(`the send failed for another reason, so the refusal is unproven: ${JSON.stringify(sent.json ?? sent.stdout ?? sent.stderr).slice(0, 300)}`);
  verdict.check("the ordinary send was refused before any input (target_needs_input)", refused, { exit: sent.exit, json: sent.json });
  verdict.info("the activity reason beside the refusal", sent.json?.activity?.reason ?? null);
  await ctx.sleep(3000);
  verdict.check("nothing was typed into the pane for it", ctx.paneWrites(since).length === 0, ctx.paneWrites(since));
  const after = dialogRegion((await ctx.observe({ after: sentAt + 3000 })).screen, dialogPattern);
  verdict.check("the dialog is still open", after !== null, null);
  verdict.check("the dialog is unchanged (no option chosen or moved)", after === before, after === before ? { region: after } : { before, after, screenAfter: ctx.screen.last()?.screen });
  verdict.check("the message didn't reach the model", ctx.deliveries(marker).turns.length === 0, ctx.deliveries(marker).turns.map((t) => t.seq));
  return marker;
}

/** After the dialog is gone: an explicit resend delivers once (the pending item reconciled, not replayed). */
async function resendOnce(ctx, marker) {
  const body = `Delivery check ${ctx.mark("resend")}: the explicit resend of ${marker} after the dialog closed.`;
  const sent = await ctx.send(body);
  ctx.verdict.check("the explicit resend was accepted", sent.exit === 0 && sent.json?.ok === true, { exit: sent.exit, json: sent.json });
  const seen = await ctx.waitDelivered(marker);
  await ctx.sleep(2000);
  ctx.verdict.check("the refused message reached the model once, through the resend only", ctx.deliveries(marker).turns.length === 1, ctx.deliveries(marker).turns.map((t) => t.seq));
  return seen;
}

export const CASES = [
  {
    id: "D05",
    title: "permission prompt",
    programs: ["claude", "codex"],
    script: (kind) => ({ rules: [
      { when: "DLV-D05-ask", times: 1, tool: kind === "claude"
        ? { name: "Bash", input: { command: "sh -c 'echo D05-approved'", description: "A harmless command that needs approval" } }
        : { name: "exec_command", input: { cmd: "echo D05-approved", sandbox_permissions: "require_escalated", justification: "Delivery suite D05: approve a harmless echo" } } },
      { on: "tool_result", say: "tool round done" },
      { say: "ack {{marker}}" },
    ] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      const ask = ctx.mark("ask");
      await ctx.send(`Delivery check ${ask}: please run the harmless command.`);
      const dialog = await ctx.waitScreenAny(APPROVAL, { timeoutMs: 45_000 });
      await ctx.settle({ timeoutMs: 15_000 });
      if (!dialog) { verdict.skip("no approval prompt appeared, so the case's precondition is unproven"); return; }
      verdict.info("the approval prompt on screen", { pattern: dialog.pattern });
      const pending = await sendIntoDialog(ctx, "pending", new RegExp(dialog.pattern.slice(1, dialog.pattern.lastIndexOf("/")), "i"));
      verdict.check("no tool result reached the model while the prompt was open", !ctx.requests().some((r) => r.turn?.kind === "tool_result"), null);

      // The intentional approval, through its own control path, judged apart from the refused send.
      const approve = await ctx.cell.rig(["send", ctx.cell.session, ctx.kind === "claude" ? "1" : "y", "--dangerously-interact",
        "--reason", "delivery suite D05: approve the harmless test command", "--json"], { allowFail: true });
      verdict.info("the intentional approval's own result", approve.stdout.trim().slice(0, 600));
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !ctx.requests().some((r) => r.turn?.kind === "tool_result")) await ctx.sleep(250);
      const result = ctx.requests().find((r) => r.turn?.kind === "tool_result");
      verdict.check("approved on purpose: the tool ran and its result came back", /D05-approved/.test(result?.turn.parts.map((p) => p.text).join("\n") ?? ""),
        result?.turn.parts.map((p) => p.text.slice(0, 200)));
      await ctx.settle({ timeoutMs: 30_000 });
      await resendOnce(ctx, pending);
    },
  },
  {
    id: "D06",
    title: "other dialog (the model picker)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "ack {{marker}}" }] }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.settle();
      await ctx.typeDraft("/model");
      await ctx.sleep(500);
      await ctx.personKeys("Enter");
      const dialog = await ctx.waitScreenAny(PICKER, { timeoutMs: 15_000 });
      if (!dialog) { verdict.skip("the model picker didn't open, so the case's precondition is unproven"); return; }
      verdict.info("the dialog on screen", { pattern: dialog.pattern });
      const pending = await sendIntoDialog(ctx, "pending", new RegExp(dialog.pattern.slice(1, dialog.pattern.lastIndexOf("/")), "i"));
      // Leave through the dialog's ordinary exit, as a person would.
      await ctx.personKeys("Escape");
      await ctx.settle({ timeoutMs: 15_000 });
      const closed = await ctx.observe();
      verdict.check("the dialog closed through its own exit", !PICKER.some((p) => p.test(closed.screen)), null);
      await resendOnce(ctx, pending);
    },
  },
];
