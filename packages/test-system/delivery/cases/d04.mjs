// D04's footer variants at 80x24: an idle draft-aware seat with an empty input box, and Claude Code's auto-update
// failure footer under it, in the width-clipped form ('… npm i -g @anthropic-ai/claude-c…') and then in full. Judged by
// expected.yaml's D04: with an empty input box the seat is not held, and a send delivers once, whatever the footer says.
//
// The footer is Claude's own. Its updater, normally switched off in a cell, is switched on and pointed at the stand-in
// as its npm registry, which offers a newer version whose tarball it doesn't serve. The install then fails, and Claude
// draws its footer. The install's global prefix is inside the cell's home, and the cell has no network, so nothing is
// installed or fetched from anywhere else. Codex draws no such footer: its cell is the "footer: none" variant at 80x24.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotRun } from "../harness/case-context.mjs";
import { deliveredOnce } from "./s2.mjs";

const PACKAGE = "@anthropic-ai/claude-code";
const NEWER = "2.1.999";
const FOOTER = /Auto-update failed/;

/** The screen's rows that hold the footer, as drawn. */
const footerRows = (screen) => screen.split("\n").filter((row) => FOOTER.test(row)).map((row) => row.trimEnd());

/** A send to an idle seat with an empty input box: delivered once, never held, never pasted twice. `empty` is the input
 *  box as read at the cell's start (Codex shows a placeholder there). */
async function emptyInputSend(ctx, label, empty) {
  const { verdict } = ctx;
  const input = await ctx.readComposer();
  verdict.check(`${label}: the input box is empty before the send`, input.trim() === empty.trim(), { input, empty });
  const marker = ctx.mark("footer");
  const body = `Delivery check ${marker}: draft-aware, empty input, ${label}.`;
  const since = ctx.nowNs();
  const sent = await ctx.send(body);
  const json = sent.json;
  verdict.check(`${label}: not held, and sent (an empty input box is not a draft, whatever the footer says)`,
    sent.exit === 0 && json?.ok === true && json?.sent !== false && json?.outcome !== "retained", { exit: sent.exit, json, stderr: sent.stderr?.slice(0, 300) });
  if (sent.exit === 0 && json?.ok === true && json?.outcome !== "retained") {
    await deliveredOnce(ctx, marker, body, { label });
    const pastes = ctx.paneWrites(since).filter((w) => w.argv[0] === "paste-buffer" && w.argv.some((a) => a.startsWith("openrig_")));
    verdict.check(`${label}: OpenRig pasted once`, pastes.length === 1, pastes);
    return;
  }
  // Not delivered. Say which way: held before any write, or written and left in the input box without its Enter.
  const writes = ctx.paneWrites(since);
  verdict.info(`${label}: what OpenRig wrote to the pane for it`, writes);
  if (writes.length > 0) verdict.info(`${label}: the input box afterwards (OpenRig's text left in it, not submitted)`, await ctx.readComposer().catch(() => null));
  for (const id of json?.outboxIds ?? []) verdict.info(`${label}: the held message retired, so nothing delivers it later`, await ctx.retireHeld(id));
  await ctx.sleep(3000);
  verdict.check(`${label}: nothing reached the model for it`, ctx.deliveries(marker).turns.length === 0, ctx.deliveries(marker).turns.map((t) => t.seq));
}

export const CASES = [
  {
    id: "D04-footer",
    title: "an empty input box at 80x24 under Claude's clipped auto-update failure footer, then in full (draft-aware)",
    programs: ["claude", "codex"],
    script: () => ({ rules: [{ say: "got it" }], registry: { [PACKAGE]: NEWER } }),
    claudeEnv: (url, { home }) => ({ DISABLE_AUTOUPDATER: null, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null,
      NPM_CONFIG_REGISTRY: url, NPM_CONFIG_PREFIX: join(home, ".npm-global") }),
    async run(ctx) {
      const { verdict } = ctx;
      await ctx.setGuard("draft-aware");
      await ctx.setDraftDelivery("refuse");
      const size = await ctx.resize(80, 24);
      if (size !== "80x24") throw new NotRun(`the window didn't take the size 80x24 (tmux reports ${size})`);
      await ctx.settle({ timeoutMs: 20_000 });
      const empty = await ctx.readComposer();
      verdict.info("the empty input box at the cell's start", empty);

      if (ctx.kind === "codex") {
        const frame = await ctx.observe();
        verdict.check("footer: none (Codex draws no auto-update failure footer)", footerRows(frame.screen).length === 0, frame.screen.split("\n").slice(-4));
        await emptyInputSend(ctx, "80x24, no footer", empty);
        return;
      }

      const seen = await ctx.waitScreenAny([FOOTER], { timeoutMs: 120_000 });
      const registry = ctx.requests().filter((r) => r.method !== "POST").map((r) => ({ seq: r.seq, method: r.method, path: r.path, served: r.served }));
      let record = null;
      try { record = JSON.parse(readFileSync(join(ctx.cell.home, ".claude", ".last-update-result.json"), "utf8")); } catch { record = null; }
      verdict.info("Claude's updater's requests to the stand-in", registry);
      verdict.info("Claude's own record of its update attempt", record);
      if (!seen) throw new NotRun("Claude didn't draw its auto-update failure footer, so this variant's program state never arose");
      await ctx.settle({ timeoutMs: 20_000 });
      const clipped = footerRows((await ctx.observe()).screen);
      verdict.info("the footer at 80x24, as drawn", clipped);
      if (!clipped.some((row) => /npm i -g @anthropic-ai\/claude-c/.test(row) && !row.includes(PACKAGE) && row.endsWith("…"))) {
        throw new NotRun("the footer at 80x24 isn't the width-clipped form ('… npm i -g @anthropic-ai/claude-c…')");
      }
      await emptyInputSend(ctx, "80x24, clipped footer", empty);

      // The full wording, in a window wide enough for all of it. The clipped arm's result stands if this one can't run.
      const wide = await ctx.resize(200, 50);
      await ctx.settle({ timeoutMs: 20_000 });
      const full = footerRows((await ctx.observe()).screen);
      verdict.info(`the footer at ${wide}, as drawn`, full);
      if (wide !== "200x50" || !full.some((row) => row.includes(`npm i -g ${PACKAGE}`))) {
        verdict.info("full-wording arm not run: the footer's full wording wasn't on screen at 200x50", null);
        return;
      }
      await emptyInputSend(ctx, "200x50, full footer", empty);
    },
  },
];
