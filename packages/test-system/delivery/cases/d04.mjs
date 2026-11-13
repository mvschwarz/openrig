// D04's footer variants: an idle draft-aware seat with an empty input box, and Claude Code's auto-update failure footer
// under it, in the width-clipped form ('… npm i -g @anthropic-ai/claude-c…') at 80x24 and in its full wording at 200x50,
// where it fits on one line. Judged by expected.yaml's D04: with an empty input box the seat is not held, and a send
// delivers once, whatever the footer says.
//
// The footer is Claude's own. Its updater, normally switched off in a cell, is switched on and pointed at the stand-in
// as its npm registry, which offers a newer version whose tarball it doesn't serve. The install then fails, and Claude
// draws its footer. The install's global prefix is inside the cell's home and the cell has no network, but the cell
// isn't a filesystem boundary: see the README's "Claude's updater in D04-footer". Codex draws no such footer: its cell
// is the "footer: none" variant at 80x24.
//
// Each arm establishes its own state at the attempt (the size, the footer's form and an empty input box, all read from
// the frame it sends from). An arm whose state isn't established is NOT RUN on its own and doesn't replace an earlier
// arm's result.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotRun } from "../harness/case-context.mjs";
import { deliveredOnce } from "./s2.mjs";

const PACKAGE = "@anthropic-ai/claude-code";
const NEWER = "2.1.999";
const FOOTER = /Auto-update failed/;

/** The screen's rows that hold the footer, as drawn. */
const footerRows = (screen) => screen.split("\n").filter((row) => FOOTER.test(row)).map((row) => row.trimEnd());
const clippedForm = (rows) => rows.some((row) => /npm i -g @anthropic-ai\/claude-c/.test(row) && !row.includes(PACKAGE) && row.endsWith("…"));
const fullForm = (rows) => rows.some((row) => row.includes(`npm i -g ${PACKAGE}`));

const ARMS = {
  claude: [
    { label: "80x24, clipped footer", size: [80, 24], footer: clippedForm, footerText: "the width-clipped form ('… npm i -g @anthropic-ai/claude-c…')" },
    { label: "200x50, full footer", size: [200, 50], footer: fullForm, footerText: `the full wording ('npm i -g ${PACKAGE}')` },
  ],
  codex: [{ label: "80x24, no footer", size: [80, 24], footer: (rows) => rows.length === 0, footerText: "no footer" }],
};

/** One arm: its state established on the frame it sends from, then a send to the empty input box, judged. Returns why
 *  the arm is NOT RUN, or null when it ran. */
export async function runArm(ctx, arm, empty) {
  const { verdict } = ctx;
  const size = await ctx.resize(...arm.size);
  await ctx.settle({ timeoutMs: 20_000 });
  // What an earlier arm left in the input box (OpenRig's text pasted without its Enter) is cleared, as a person would.
  const before = await ctx.readComposer().catch(() => null);
  if (before !== null && before.trim() !== empty.trim()) {
    await ctx.eraseDraft(Buffer.byteLength(before) + 400);
    await ctx.settle({ timeoutMs: 20_000, optional: true });
    verdict.info(`${arm.label}: an earlier arm's residue in the input box, cleared before this arm`, before);
  }
  const frame = await ctx.observe();
  const rows = footerRows(frame.screen);
  const input = ctx.composerOf(frame.screen);
  verdict.info(`${arm.label}: the footer as drawn at the attempt`, rows);
  if (size !== arm.size.join("x")) return `the window didn't take the size ${arm.size.join("x")} (tmux reports ${size})`;
  if (!arm.footer(rows)) return `the footer at the attempt isn't ${arm.footerText}`;
  if (input === null || input.trim() !== empty.trim()) return `the input box wasn't empty at the attempt (${JSON.stringify(input)})`;
  verdict.info(`${arm.label}: state at the attempt`, { size, footer: arm.footerText, input });

  const marker = ctx.mark("footer");
  const body = `Delivery check ${marker}: draft-aware, empty input, ${arm.label}.`;
  const since = ctx.nowNs();
  const sent = await ctx.send(body);
  const json = sent.json;
  if (!json) return `the send gave no JSON result (exit ${sent.exit}): ${String(sent.stderr || sent.stdout || "").slice(0, 300)}`;
  const delivered = json.ok === true && json.sent !== false && json.outcome !== "retained";
  verdict.check(`${arm.label}: not held, and sent (an empty input box is not a draft, whatever the footer says)`, sent.exit === 0 && delivered,
    { exit: sent.exit, json, stderr: sent.stderr?.slice(0, 300) });
  if (delivered) {
    await deliveredOnce(ctx, marker, body, { label: arm.label });
    const pastes = ctx.paneWrites(since).filter((w) => w.argv[0] === "paste-buffer" && w.argv.some((a) => a.startsWith("openrig_")));
    verdict.check(`${arm.label}: OpenRig pasted once`, pastes.length === 1, pastes);
    return null;
  }
  // Not delivered. Say which way: held before any write, or written and left in the input box without its Enter.
  const writes = ctx.paneWrites(since);
  verdict.info(`${arm.label}: what OpenRig wrote to the pane for it`, writes);
  if (writes.length > 0) verdict.info(`${arm.label}: the input box afterwards (OpenRig's text left in it, not submitted)`, await ctx.readComposer().catch(() => null));
  if (json.outcome === "retained") {
    for (const id of json.outboxIds ?? []) {
      const r = await ctx.retireHeld(id);
      verdict.check(`${arm.label}: the held message retired, so nothing delivers it later`, r.exit === 0 && r.state === "retired", r);
    }
  }
  await ctx.sleep(3000);
  verdict.check(`${arm.label}: nothing reached the model for it`, ctx.deliveries(marker).turns.length === 0, ctx.deliveries(marker).turns.map((t) => t.seq));
  return null;
}

export const CASES = [
  {
    id: "D04-footer",
    title: "an empty input box under Claude's auto-update failure footer, clipped at 80x24 and in full at 200x50 (draft-aware)",
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

      if (ctx.kind === "claude") {
        const seen = await ctx.waitScreenAny([FOOTER], { timeoutMs: 120_000 });
        const registry = ctx.requests().filter((r) => r.method !== "POST").map((r) => ({ seq: r.seq, method: r.method, path: r.path, served: r.served }));
        let record = null;
        try { record = JSON.parse(readFileSync(join(ctx.cell.home, ".claude", ".last-update-result.json"), "utf8")); } catch { record = null; }
        verdict.info("Claude's updater's requests to the stand-in", registry);
        verdict.info("Claude's own record of its update attempt", record);
        if (!seen) throw new NotRun("Claude didn't draw its auto-update failure footer, so this variant's program state never arose");
        await ctx.settle({ timeoutMs: 20_000 });
      }

      const notRun = [];
      for (const arm of ARMS[ctx.kind]) {
        const short = await runArm(ctx, arm, empty);
        verdict.info(`${arm.label}: arm ${short ? "NOT RUN" : "run"}`, short);
        if (short) notRun.push(`${arm.label}: ${short}`);
      }
      // An arm that couldn't run leaves the cell NOT RUN, unless an arm that ran already failed.
      if (notRun.length && verdict.result !== "FAIL") verdict.skip(`arms not run: ${notRun.join("; ")}`);
    },
  },
];
