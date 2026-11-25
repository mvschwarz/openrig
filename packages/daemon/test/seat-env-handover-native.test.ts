import { describe, it, expect, afterAll, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// A one-off `rig up --env` value reaches the first pane and stays with it. This launches a seat through
// the real NodeLauncher and hands it over through the real SeatHandoverService, on an ISOLATED tmux
// server (per-run -L socket, torn down by session name, never kill-server), and reads what each
// pane's shell actually has in its environment. It runs wherever tmux does (Linux and macOS).

const pexec = promisify(execFile);
const SOCK = `openrig-seatenv-${process.pid}`;
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
delete cleanEnv.TMUX;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  return (await pexec("sh", ["-c", safe], { env: cleanEnv })).stdout;
};
const tmux = (a: string) => exec(`tmux ${a}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const available = (() => { try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" }); return true; } catch { return false; } })();

const SEAT = "dev-impl@envhandover-rig";
const scratch = mkdtempSync(path.join(tmpdir(), "seatenv-"));
afterAll(async () => {
  await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});

/** What the pane's shell has exported right now: the shell writes it out, so no /proc is needed. */
async function paneEnviron(tag: string): Promise<Record<string, string>> {
  const file = path.join(scratch, `${tag}.env`);
  const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
  await tmux(`send-keys -t ${q(pane)} -l -- ${q(`env > ${q(file)}.part && mv ${q(file)}.part ${q(file)}`)}`);
  await tmux(`send-keys -t ${q(pane)} Enter`);
  for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100);
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("a one-off --env value stays with the first launch (real tmux)", () => {
  it.runIf(available)("hands over changed and removed declarations without losing the pane, fork source or unrelated environment", async () => {
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
    const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("envhandover-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: scratch, env: { SHARED: "from-spec", MEMBER_ONLY: "m" } });
    rigRepo.setRigEnv(rig.id, { RIG_ONLY: "r", REMOVED: "old" });

    // The first launch through NodeLauncher: a one-off over a declared name, a one-off-only name, and
    // HOME, which OpenRig sets for the seat.
    const adapter = new TmuxAdapter(exec);
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: adapter, sessionEnv: { HOME: "/openrig/home" } });
    const launched = await launcher.launchNode(rig.id, "dev.impl", {
      sessionName: SEAT, cwd: scratch,
      env: { SHARED: "one-off-wins", ONLY_THIS_LAUNCH: "debug", HOME: "/one-off/home" },
    });
    expect(launched.ok).toBe(true);
    await sleep(300);
    const currentPane = async () => (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
    const pane = await currentPane();
    const allowGracefulExit = async () => {
      await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
      await tmux(`send-keys -t ${q(pane)} Enter`);
      await sleep(200);
    };
    await allowGracefulExit();

    // The first pane was started with the one-offs.
    expect(await paneEnviron("first")).toMatchObject({ SHARED: "one-off-wins", ONLY_THIS_LAUNCH: "debug", HOME: "/one-off/home", MEMBER_ONLY: "m", RIG_ONLY: "r" });
    // The session no longer carries them: the spec's value, OpenRig's value, and nothing for the one-off-only name.
    expect(await adapter.getSessionEnv(SEAT, "SHARED")).toBe("from-spec");
    expect(await adapter.getSessionEnv(SEAT, "HOME")).toBe("/openrig/home");
    expect(await adapter.getSessionEnv(SEAT, "ONLY_THIS_LAUNCH")).toBeUndefined();

    const incumbent = sessionRegistry.getSessionsForRig(rig.id)[0]!;
    sessionRegistry.updateStartupStatus(incumbent.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
    sessionRegistry.updateResumeToken(incumbent.id, "codex_id", "synthetic-parent", "scrape");
    await tmux(`set-environment -g REMOVED ordinary-global`);
    await tmux(`set-environment -g ONLY_THIS_LAUNCH unrelated-global`);
    await adapter.setSessionEnv(SEAT, "AMBIENT", "keep");
    await adapter.setSessionEnv(SEAT, "ONLY_THIS_LAUNCH", "stale-one-off");
    const previousMarker = await adapter.getSessionEnv(SEAT, "OPENRIG_SEAT_ENV_KEYS");
    await adapter.setSessionEnv(SEAT, "OPENRIG_SEAT_ENV_KEYS", `${previousMarker},ONLY_THIS_LAUNCH`);
    rigRepo.setRigEnv(rig.id, { RIG_ONLY: "changed" });

    const forkedFrom: string[] = [];
    const runtime = {
      runtime: "codex",
      async launchHarness(_binding: unknown, opts: { forkSource?: { value: string } }) {
        forkedFrom.push(opts.forkSource?.value ?? "missing");
        return { ok: true, resumeToken: `synthetic-next-${forkedFrom.length}`, resumeType: "codex_id" };
      },
      async checkReady() { return { ready: true }; },
    };
    const service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: adapter, runtimeAdapters: { codex: runtime as never },
      sessionEnv: { HOME: "/openrig/home" },
      predecessorRecapResolver: () => ({ recap: [], recordPath: path.join(scratch, "none.jsonl") }),
      readinessTimeoutMs: 3000, sleep,
    });

    const handover = async (tag: string, warning?: string) => {
      const result = await service.handover({ seatRef: SEAT, reason: "context ~85%", source: `fork:${SEAT}`, operator: "orch@seat" });
      expect(result.ok).toBe(true);
      if (warning) expect(result).toMatchObject({ result: { warnings: expect.arrayContaining([expect.stringContaining(warning)]) } });
      expect(await currentPane()).toBe(pane);
      return paneEnviron(tag);
    };
    const checkInherited = (env: Record<string, string>) => {
      expect(env).toMatchObject({ HOME: "/openrig/home", AMBIENT: "keep", ONLY_THIS_LAUNCH: "unrelated-global" });
      expect(env.REMOVED).toBe("ordinary-global");
    };
    for (const tag of ["successor", "repeat"]) {
      const env = await handover(tag);
      checkInherited(env);
      expect(env).toMatchObject({ SHARED: "from-spec", MEMBER_ONLY: "m", RIG_ONLY: "changed" });
      expect(await adapter.getSessionEnv(SEAT, "RIG_ONLY")).toBe("changed");
      expect(await adapter.getSessionEnv(SEAT, "OPENRIG_SEAT_ENV_KEYS")).toBe("RIG_ONLY,SHARED,MEMBER_ONLY");
      await allowGracefulExit();
    }
    rigRepo.setRigEnv(rig.id, null);
    db.prepare("UPDATE nodes SET env_json = NULL WHERE id = ?").run(node.id);
    const unset = adapter.unsetSessionEnv.bind(adapter);
    let retireeWasDead = false;
    const writeFailure = vi.spyOn(adapter, "unsetSessionEnv").mockImplementation(async (target, key, options) => {
      if (key === "MEMBER_ONLY") {
        retireeWasDead = await adapter.isPaneDead(pane);
        throw new Error("fixture session environment write failed");
      }
      return unset(target, key, options);
    });
    const partial = await handover("partial", "MEMBER_ONLY");
    expect(retireeWasDead).toBe(true);
    expect(partial.MEMBER_ONLY).toBe("m");
    expect(await adapter.getSessionEnv(SEAT, "OPENRIG_SEAT_ENV_KEYS")).toBe("MEMBER_ONLY");
    writeFailure.mockRestore();
    await allowGracefulExit();
    const empty = await handover("empty");
    checkInherited(empty);
    expect(empty).not.toHaveProperty("RIG_ONLY");
    expect(empty).not.toHaveProperty("MEMBER_ONLY");
    expect(await adapter.getSessionEnv(SEAT, "OPENRIG_SEAT_ENV_KEYS")).toBe("");
    await allowGracefulExit();
    rigRepo.setRigEnv(rig.id, { REMOVED: "declared-again" });
    expect((await handover("readded")).REMOVED).toBe("declared-again");
    expect(await adapter.getSessionEnv(SEAT, "REMOVED")).toBe("declared-again");
    await tmux(`send-keys -t ${q(pane)} -l -- exit`);
    await tmux(`send-keys -t ${q(pane)} Enter`);
    await expect.poll(() => adapter.isPaneDead(pane)).toBe(true);
    expect(await adapter.respawnPane(pane, "/bin/sh")).toMatchObject({ ok: true });
    expect((await paneEnviron("bare-restart")).REMOVED).toBe("declared-again");
    expect(forkedFrom).toEqual(["synthetic-parent", "synthetic-next-1", "synthetic-next-2", "synthetic-next-3", "synthetic-next-4"]);
    db.close();
  }, 60_000);
});
