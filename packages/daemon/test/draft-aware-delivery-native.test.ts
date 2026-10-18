import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { inspectComposerInput } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";

const run = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const composer = fileURLToPath(new URL("./fixtures/draft-composer.mjs", import.meta.url));

// The YAML stub runner cannot script editable input or its policy step yet.
// This private tmux fixture exercises the real cursor/capture/paste/Enter path;
// provider-specific renderings remain parser fixtures, not a live-model claim.
describe.skipIf(process.platform === "win32")("native draft-aware terminal delivery", () => {
  it.each(["claude", "codex"])("%s input: protects drafts at paste and Enter while preserving delivery and siblings", async runtime => {
    const scratch = mkdtempSync(join(tmpdir(), "draft-"));
    const socket = join(scratch, "s");
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_TMPDIR;
    const tmux = async (args: string[]) => (await run("tmux", ["-S", socket, ...args], { env })).stdout;
    const state = (node = "a") => JSON.parse(readFileSync(join(scratch, `${node}.json`), "utf8")) as { input: string; submissions: string[] };
    const waitInput = async (input: string, node = "a") => vi.waitFor(() => expect(state(node).input).toBe(input), { timeout: 5000, interval: 25 });
    const db = new Database(":memory:");
    let transport: SessionTransport | undefined;
    try {
      const panes: Record<string, string> = {};
      for (const [node, session] of [["a", "worker@test"], ["b", "sibling@test"]]) {
        const command = [process.execPath, composer, runtime, join(scratch, `${node}.json`)].map(shellQuote).join(" ");
        panes[node!] = (await tmux(["-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-x", "120", "-y", "40", "-s", session!, command])).trim();
        await waitInput("", node);
      }
      migrate(db, ALL_MIGRATIONS);
      db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
        INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal'),('b','rig','sibling','terminal');
        INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');
        INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
      for (const [node, session] of [["a", "worker@test"], ["b", "sibling@test"]]) {
        db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)").run(`binding-${node}`, node, session, panes[node!]);
      }
      let at = Date.now();
      const hooks: { load?: () => Promise<void>; beforeEnter?: () => Promise<void> } = {};
      const adapter = new TmuxAdapter(async () => { throw new Error("Native fixture requires argv execution"); }, undefined, async args => {
        const output = await tmux(args.slice(1));
        if (args[1] === "load-buffer") await hooks.load?.();
        return output;
      });
      const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); adapter.deliveryGuard = guard;
      transport = new SessionTransport({ db, tmuxAdapter: adapter, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
        now: () => new Date(at), sleep: async ms => { if (ms === 200) await hooks.beforeEnter?.(); await pause(ms); } });
      const send = (id: string, text: string) => transport!.send("worker@test", text, { deliveryId: id, actorSession: "sender@test", verify: true });
      await guard.set("a", { mode: "draft-aware" }, "human@test", "native fixture");
      await vi.waitFor(async () => expect(inspectComposerInput(await adapter.captureComposerSnapshot(panes.a!)).state).toBe("empty"), { timeout: 5000 });

      // A real human input arriving while the payload buffer is prepared must
      // still be visible, with no automatic bytes or Enter in the input loop.
      hooks.load = async () => {
        hooks.load = undefined;
        await tmux(["send-keys", "-t", panes.a!, "-l", "unfinished human draft"]);
        await waitInput("unfinished human draft");
      };
      expect(await send("deferred", "one\nmessage")).toMatchObject({ outcome: "retained", delivery: { state: "held" } });
      expect(state()).toEqual({ input: "unfinished human draft", submissions: [] });
      await tmux(["send-keys", "-t", panes.a!, "C-u"]); await waitInput("");
      expect(await send("deferred", "one\nmessage")).toMatchObject({ outcome: "retained", reason: "draft_input_busy" });
      expect(state().submissions).toEqual([]);
      expect(await send("fresh", "one\nmessage")).toMatchObject({ ok: true, sent: true, delivery: { state: "complete" } });
      await vi.waitFor(() => expect(state().submissions).toEqual(["one\nmessage"]));

      hooks.beforeEnter = async () => {
        hooks.beforeEnter = undefined;
        await tmux(["send-keys", "-t", panes.a!, "-l", " plus a human draft"]);
        await waitInput("second message plus a human draft");
      };
      expect(await send("late", "second message")).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed", delivery: { state: "indeterminate" } });
      expect(state()).toEqual({ input: "second message plus a human draft", submissions: ["one\nmessage"] });
      await send("late", "second message"); expect(state().submissions).toHaveLength(1);
      await tmux(["send-keys", "-t", panes.a!, "C-u"]); await waitInput("");

      await tmux(["copy-mode", "-t", panes.a!]);
      expect(await send("copy-mode", "held during copy")).toMatchObject({ outcome: "retained", delivery: { reason: "draft_input_unknown" } });
      await tmux(["send-keys", "-t", panes.a!, "-X", "cancel"]);
      await guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
      expect(await send("inbox", "stay in the inbox")).toMatchObject({ outcome: "retained", reason: "typing_guard_enabled" });
      expect(await transport.send("sibling@test", "sibling delivery", { verify: true })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(state("b").submissions).toEqual(["sibling delivery"]));
      expect(state().submissions).toEqual(["one\nmessage"]);

      await adapter.humanInput("worker@test", async () => {
        expect(await adapter.sendText("worker@test", "direct human message")).toEqual({ ok: true });
        await waitInput("direct human message");
        expect(await adapter.sendKeys("worker@test", ["Enter"])).toEqual({ ok: true });
      });
      await vi.waitFor(() => expect(state().submissions).toEqual(["one\nmessage", "direct human message"]));
      await guard.set("a", { mode: "draft-aware" }, "human@test", "protect literal input");
      await tmux(["send-keys", "-t", panes.a!, "-l", "Ask Codex to do anything"]);
      await waitInput("Ask Codex to do anything");
      await tmux(["send-keys", "-t", panes.a!, "C-a"]);
      await vi.waitFor(async () => expect((await adapter.captureComposerSnapshot(panes.a!))?.cursor.x).toBe(2));
      expect(await send("literal-placeholder", "automatic message")).toMatchObject({ outcome: "retained", delivery: { reason: "draft_input_busy" } });
      expect(state()).toEqual({ input: "Ask Codex to do anything", submissions: ["one\nmessage", "direct human message"] });

      // The native capture must retain dim styling, both for an empty input and
      // for an autocomplete suffix after the text owned by the delivery lease.
      await tmux(["send-keys", "-t", panes.a!, "C-u", "C-t"]); await waitInput("");
      await vi.waitFor(async () => {
        const snapshot = await adapter.captureComposerSnapshot(panes.a!);
        expect(snapshot?.screen).toContain("suggested follow-up");
        expect(inspectComposerInput(snapshot).state).toBe("empty");
      });
      expect(await send("ghost", "owned delivery")).toMatchObject({ ok: true, delivery: { state: "complete" } });
      await vi.waitFor(() => expect(state().submissions).toEqual(["one\nmessage", "direct human message", "owned delivery"]));

      const framedDraft = "intro\n────────────────────\n❯ \n────────────────────\n? for shortcuts\n────────────────────\n❯ ";
      await tmux(["send-keys", "-t", panes.a!, "C-t"]);
      expect(await adapter.humanInput("worker@test", () => adapter.sendText("worker@test", framedDraft))).toEqual({ ok: true });
      await waitInput(framedDraft);
      await vi.waitFor(async () => expect(inspectComposerInput(await adapter.captureComposerSnapshot(panes.a!)).state).toBe("text"));
      expect(await send("nested-prompt", "automatic message")).toMatchObject({ outcome: "retained", delivery: { reason: "draft_input_busy" } });
      expect(state()).toEqual({ input: framedDraft, submissions: ["one\nmessage", "direct human message", "owned delivery"] });
    } finally {
      await transport?.guardedDelivery?.stop();
      await tmux(["kill-server"]).catch(() => {});
      db.close(); rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
