import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// Seat interruption levels, end to end: a private scenario daemon, real tmux and SQLite, two stub seats, and only the
// shipped `rig` CLI. The YAML scenario runner has no bound verb to set a seat's level, mark a send urgent, create or park
// a queue row, and no surface for held messages, so this drives the harness directly (as the edge-repair journey does).
// What the person sees at each level: an input is typed into the seat's pane, or held and readable with
// `rig seat held-messages`. A stub seat draws no input box, so input a middle level lets through then goes to draft
// protection, which holds what it can't read: that shows as "admitted" (held with draft protection's reason), never as
// held by the level. The unit tests show admitted input typing where the input box can be read. A stub proves OpenRig's
// own plumbing, not how Claude Code or Codex behave.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const agentDir = resolve(here, "../../test-system/scenarios/agents/worker");
const worker = "dev-worker@levels";
const peer = "dev-peer@levels";

describe("seat interruption levels with stub seats", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;

  async function cli(args: string[], as?: string) {
    const env = as ? { ...daemon!.readEnv, OPENRIG_SESSION_NAME: as } : daemon!.readEnv;
    const result = await runRig([...args, "--json"], env, rigBin, 120_000);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout);
  }
  const pane = async () => JSON.stringify(await cli(["capture", worker, "--lines", "400"]));
  const held = async () => (await cli(["seat", "held-messages", worker])).items as Array<{ body: string; delivery?: { reason?: string } }>;
  // Typed; held by the level; or let through by the level and held by draft protection ("admitted"): whichever the seat
  // shows first. Neither within the bound is a failure, never a guess.
  async function landed(marker: string): Promise<"typed" | "held" | "admitted"> {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      if ((await pane()).includes(marker)) return "typed";
      const item = (await held()).find((h) => h.body.includes(marker));
      if (item) return item.delivery?.reason ? "admitted" : "held";
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${marker} neither typed nor held within 20 s`);
  }

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    cpSync(agentDir, join(scaffold.root, "worker-agent"), { recursive: true });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    const member = (id: string) => {
      const cwd = join(scaffold!.root, id);
      mkdirSync(cwd);
      return { id, agent_ref: "local:worker-agent", profile: "default", runtime: "stub", cwd };
    };
    const specPath = join(scaffold.root, "levels.yaml");
    writeFileSync(specPath, stringify({ version: "0.2", name: "levels",
      pods: [{ id: "dev", label: "Dev", members: [member("worker"), member("peer")], edges: [] }], edges: [] }));
    await cli(["up", specPath, "--yes"]);
  }, 180_000);

  afterAll(async () => {
    try { if (daemon) await runRig(["down", "levels", "--json", "--force"], daemon.readEnv, rigBin, 60_000); } catch { /* best effort */ }
    if (daemon) await daemon.stop(); // also removes the scaffold
    else scaffold?.cleanup();
  }, 120_000);

  it.each([
    ["off", { create: "typed", urgentRow: "typed", agent: "typed", urgentSend: "typed", parkWake: "typed" }],
    ["openrig-urgent", { create: "held", urgentRow: "admitted", agent: "held", urgentSend: "admitted", parkWake: "admitted" }],
    ["urgent-only", { create: "held", urgentRow: "admitted", agent: "held", urgentSend: "admitted", parkWake: "held" }],
    ["hold", { create: "held", urgentRow: "held", agent: "held", urgentSend: "held", parkWake: "held" }],
  ] as const)("at %s: a peer's create nudge, an urgent queue row, a peer's send, an urgent send and a park-timer wake", async (level, expected) => {
    // A row the worker will park on a timer, created and parked before the level changes what types.
    const parkRow = (await cli(["queue", "create", "--destination", worker, "--body", `park-${level}`], peer)).qitemId as string;
    await cli(["seat", "set-typing-guard", worker, "--mode", level, "--reason", "scenario"], worker);
    await cli(["queue", "update", parkRow, "--state", "blocked", "--blocked-on", "external:vendor", "--wake-after", "2s"], worker);
    // One input at a time, each read back before the next, so a send never queues behind another's delivery.
    const create = (await cli(["queue", "create", "--destination", worker, "--body", `ask-${level}`], peer)).qitemId as string;
    const seenCreate = await landed(create);
    const urgentRow = (await cli(["queue", "create", "--destination", worker, "--body", `outage-${level}`, "--priority", "urgent"], peer)).qitemId as string;
    const seenUrgentRow = await landed(urgentRow);
    await cli(["send", worker, `send-${level}-marker`], peer);
    const seenAgent = await landed(`send-${level}-marker`);
    const urgent = await cli(["send", worker, `urgent-${level}-marker`, "--urgent"], peer);
    expect(urgent.urgent).toEqual({ by: peer });
    const seenUrgentSend = await landed(`urgent-${level}-marker`);
    const seenPark = await landed(`Wake timer fired for parked qitem ${parkRow}`);
    const seen = { create: seenCreate, urgentRow: seenUrgentRow, agent: seenAgent, urgentSend: seenUrgentSend, parkWake: seenPark };
    // Close the parked row so its timer stops before the next level.
    await cli(["queue", "update", parkRow, "--state", "done", "--closure-reason", "no-follow-on"], worker);
    expect(seen).toEqual(expected);
    if (expected.urgentSend === "typed") expect(await pane()).toContain(`Urgent (marked by ${peer}):`);
    if (expected.urgentSend === "admitted") expect((await held()).find((h) => h.body.includes(`urgent-${level}-marker`))?.body).toContain(`Urgent (marked by ${peer}):`);
  }, 180_000);

  it("a queue row whose wake the seat holds lands, reads as held, and isn't listed as undelivered", async () => {
    await cli(["seat", "set-typing-guard", worker, "--mode", "urgent-only", "--reason", "scenario"], worker);
    const row = (await cli(["queue", "create", "--destination", worker, "--body", "held-custody"], peer)).qitemId as string;
    expect(await landed(row)).toBe("held");
    const shown = await cli(["queue", "show", row]);
    const item = shown.item ?? shown;
    expect(item.state).toBe("pending");
    expect(item.lastNudgeResult).toBe("retained:typing_guard");
    expect(item.waiting?.nextBackstop).toMatchObject({ held: true, mechanism: "held by the seat's typing guard" });
    expect(JSON.stringify(await cli(["queue", "undelivered"]))).not.toContain(row);
    // Back to always interrupt: new input types, and nothing held is replayed.
    await cli(["seat", "set-typing-guard", worker, "--mode", "off", "--reason", "scenario"], worker);
    await cli(["send", worker, "after-the-switch"], peer);
    expect(await landed("after-the-switch")).toBe("typed");
    expect(await pane()).not.toContain("held-custody");
  }, 120_000);
});
