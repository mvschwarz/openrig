import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
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
const SPEC_SEAT = "dev-spec@envhandover-spec-rig";
const scratch = mkdtempSync(path.join(tmpdir(), "seatenv-"));
afterAll(async () => {
  await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
  await tmux(`kill-session -t ${q(SPEC_SEAT)}`).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});

/** What the pane's shell has exported right now: the shell writes it out, so no /proc is needed. */
async function paneEnviron(tag: string, seat = SEAT): Promise<Record<string, string>> {
  const file = path.join(scratch, `${tag}.env`);
  const pane = (await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim();
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

async function trapTerm(seat: string): Promise<string> {
  const pane = (await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim();
  await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
  await tmux(`send-keys -t ${q(pane)} Enter`);
  await sleep(200);
  return pane;
}

describe("a one-off --env value stays with the first launch (real tmux)", () => {
  it.runIf(available)("the first pane has it; a handover successor gets the spec's env and OpenRig's values even when session-env calls fail", async () => {
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
    const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("envhandover-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: scratch, env: { SHARED: "from-spec", MEMBER_ONLY: "m" } });
    rigRepo.setRigEnv(rig.id, { RIG_ONLY: "r" });

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
    const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
    await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
    await tmux(`send-keys -t ${q(pane)} Enter`);
    await sleep(200);

    // The first pane was started with the one-offs.
    expect(await paneEnviron("first")).toMatchObject({ SHARED: "one-off-wins", ONLY_THIS_LAUNCH: "debug", HOME: "/one-off/home", MEMBER_ONLY: "m", RIG_ONLY: "r" });
    // The session no longer carries them: the spec's value, OpenRig's value, and nothing for the one-off-only name.
    expect(await adapter.getSessionEnv(SEAT, "SHARED")).toBe("from-spec");
    expect(await adapter.getSessionEnv(SEAT, "HOME")).toBe("/openrig/home");
    expect(await adapter.getSessionEnv(SEAT, "ONLY_THIS_LAUNCH")).toBeUndefined();

    sessionRegistry.updateStartupStatus(sessionRegistry.getSessionsForRig(rig.id)[0]!.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
    // The handover gets a tmux adapter whose environment calls all fail: it must not need them.
    const environmentCalls = new Set(["getSessionEnv", "setSessionEnv", "unsetSessionEnv"]);
    const handoverTmux = new Proxy(adapter, {
      get(target, prop) {
        if (typeof prop === "string" && environmentCalls.has(prop)) return async () => { throw new Error("the handover read or wrote the session environment"); };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = {
      runtime: "codex",
      async launchHarness() { return { ok: true, resumeToken: "tok", resumeType: "codex_id" }; },
      async checkReady() { return { ready: true }; },
    };
    const service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: handoverTmux, runtimeAdapters: { codex: runtime as never },
      predecessorRecapResolver: () => ({ recap: [], recordPath: path.join(scratch, "none.jsonl") }),
      readinessTimeoutMs: 3000, sleep,
    });

    const result = await service.handover({ seatRef: SEAT, reason: "context ~85%", source: "fresh", operator: "orch@seat" });
    expect(result.ok).toBe(true);
    await sleep(300);

    // The successor shell has the spec's env and OpenRig's HOME; the one-off name and values are gone.
    const env = await paneEnviron("successor");
    expect(env).toMatchObject({ SHARED: "from-spec", MEMBER_ONLY: "m", RIG_ONLY: "r", HOME: "/openrig/home" });
    expect(env).not.toHaveProperty("ONLY_THIS_LAUNCH");
    expect(Object.values(env)).not.toContain("one-off-wins");
    expect(Object.values(env)).not.toContain("/one-off/home");
    db.close();
  }, 60_000);

  it.runIf(available)("in-place fork handover removes dropped spec keys, updates changed and added keys, preserves unrelated keys, and handles repeat/empty handovers", async () => {
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
    const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("envhandover-spec-rig");
    const node = rigRepo.addNode(rig.id, "dev.spec", {
      runtime: "claude-code", cwd: scratch,
      env: { SHARED: "from-spec-v1", DO_NOT_TRACK: "1" },
    });
    rigRepo.setRigEnv(rig.id, { RIG_ONLY: "r" });

    const adapter = new TmuxAdapter(exec);
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: adapter, sessionEnv: { HOME: "/openrig/home" } });
    const launched = await launcher.launchNode(rig.id, "dev.spec", { sessionName: SPEC_SEAT, cwd: scratch });
    expect(launched.ok).toBe(true);
    await sleep(300);
    const initialPane = await trapTerm(SPEC_SEAT);

    // Seed global fallback for DO_NOT_TRACK (to verify -r suppresses global fallback) and unrelated keys.
    await tmux(`set-environment -g DO_NOT_TRACK from-global`);
    await tmux(`set-environment -g UNRELATED_GLOBAL keep-global`);
    await tmux(`set-environment -t ${q(`=${SPEC_SEAT}`)} UNRELATED_SESSION keep-session`);

    expect(await paneEnviron("spec-first", SPEC_SEAT)).toMatchObject({
      SHARED: "from-spec-v1", DO_NOT_TRACK: "1", RIG_ONLY: "r", HOME: "/openrig/home",
    });

    const firstSession = sessionRegistry.getSessionsForRig(rig.id)[0]!;
    sessionRegistry.updateStartupStatus(firstSession.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
    sessionRegistry.updateResumeToken(firstSession.id, "claude_id", "conv-parent-1");

    // Fake claude binary for verifying ClaudeManagedLaunch forwards only the updated OPENRIG_SEAT_ENV_KEYS.
    const bin = path.join(scratch, "claude-bin");
    mkdirSync(bin, { recursive: true });
    const fakeClaude = path.join(bin, "claude");
    writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
printf '{"DO_NOT_TRACK":"%s","SHARED":"%s","ADDED_KEY":"%s"}' "\${DO_NOT_TRACK-absent}" "\${SHARED-absent}" "\${ADDED_KEY-absent}"
`);
    chmodSync(fakeClaude, 0o700);
    const managed = new ClaudeManagedLaunch(
      db,
      { PATH: `${bin}:/usr/bin:/bin`, HOME: "/openrig/home" },
      {},
      (session, key) => adapter.getSessionEnv(session, key),
    );

    let forkSeq = 1;
    const runtime = {
      runtime: "claude-code",
      async launchHarness() {
        forkSeq += 1;
        return { ok: true, resumeToken: `conv-fork-${forkSeq}`, resumeType: "claude_id" };
      },
      async checkReady() { return { ready: true }; },
    };
    const service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: adapter,
      sessionEnv: { HOME: "/openrig/home" },
      runtimeAdapters: { "claude-code": runtime as never },
      predecessorRecapResolver: () => ({ recap: [], recordPath: path.join(scratch, "none.jsonl") }),
      readinessTimeoutMs: 3000, sleep,
    });

    // Handover #1 (fork): drop DO_NOT_TRACK, change SHARED, add ADDED_KEY, keep RIG_ONLY.
    db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ SHARED: "from-spec-v2", ADDED_KEY: "added-1" }), node.id);
    const r1 = await service.handover({ seatRef: SPEC_SEAT, reason: "spec env updated", source: `fork:${SPEC_SEAT}`, operator: "orch@seat" });
    expect(r1.ok).toBe(true);
    if (!r1.ok || !("result" in r1)) throw new Error("expected fork handover #1 to succeed");
    expect(r1.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SPEC_SEAT, forkId: "captured" });
    await sleep(300);
    expect(await trapTerm(SPEC_SEAT)).toBe(initialPane);

    const env1 = await paneEnviron("spec-handover-1", SPEC_SEAT);
    expect(env1).toMatchObject({
      SHARED: "from-spec-v2", RIG_ONLY: "r", ADDED_KEY: "added-1",
      HOME: "/openrig/home", UNRELATED_SESSION: "keep-session", UNRELATED_GLOBAL: "keep-global",
    });
    expect(env1).not.toHaveProperty("DO_NOT_TRACK");
    expect((await adapter.getSessionEnv(SPEC_SEAT, "OPENRIG_SEAT_ENV_KEYS"))?.split(",").sort())
      .toEqual(["ADDED_KEY", "RIG_ONLY", "SHARED"]);

    // Managed Claude launch must not forward DO_NOT_TRACK even if present in a test env, because OPENRIG_SEAT_ENV_KEYS dropped it.
    const managedCmd1 = (await managed.prepare({ nodeId: node.id, session: SPEC_SEAT, pane: initialPane }, "auto")).command([]);
    const managedSeen1 = JSON.parse((await pexec("/bin/sh", ["-c", managedCmd1], {
      env: { PATH: "/usr/bin:/bin", DO_NOT_TRACK: "leaked", SHARED: "from-spec-v2", ADDED_KEY: "added-1" },
    })).stdout) as Record<string, string>;
    expect(managedSeen1).toEqual({ DO_NOT_TRACK: "absent", SHARED: "from-spec-v2", ADDED_KEY: "added-1" });

    // Handover #2 (repeat fork): drop ALL declared keys (empty declaration on rig and member).
    db.prepare("UPDATE nodes SET env_json = NULL WHERE id = ?").run(node.id);
    db.prepare("UPDATE rigs SET env_json = NULL WHERE id = ?").run(rig.id);
    const r2 = await service.handover({ seatRef: SPEC_SEAT, reason: "clear all seat env", source: `fork:${SPEC_SEAT}`, operator: "orch@seat" });
    expect(r2.ok).toBe(true);
    await sleep(300);
    expect(await trapTerm(SPEC_SEAT)).toBe(initialPane);

    const env2 = await paneEnviron("spec-handover-2", SPEC_SEAT);
    expect(env2).toMatchObject({ HOME: "/openrig/home", UNRELATED_SESSION: "keep-session", UNRELATED_GLOBAL: "keep-global" });
    expect(env2).not.toHaveProperty("DO_NOT_TRACK");
    expect(env2).not.toHaveProperty("SHARED");
    expect(env2).not.toHaveProperty("RIG_ONLY");
    expect(env2).not.toHaveProperty("ADDED_KEY");
    expect(env2).not.toHaveProperty("OPENRIG_SEAT_ENV_KEYS");
    expect(await adapter.getSessionEnv(SPEC_SEAT, "OPENRIG_SEAT_ENV_KEYS")).toBeUndefined();

    // Handover #3 (repeat fork): re-add a previously removed key (DO_NOT_TRACK) and verify -e overrides session -r.
    db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ DO_NOT_TRACK: "readded" }), node.id);
    const r3 = await service.handover({ seatRef: SPEC_SEAT, reason: "re-add seat env", source: `fork:${SPEC_SEAT}`, operator: "orch@seat" });
    expect(r3.ok).toBe(true);
    await sleep(300);
    expect(await trapTerm(SPEC_SEAT)).toBe(initialPane);

    const env3 = await paneEnviron("spec-handover-3", SPEC_SEAT);
    expect(env3).toMatchObject({ DO_NOT_TRACK: "readded", HOME: "/openrig/home", UNRELATED_SESSION: "keep-session", UNRELATED_GLOBAL: "keep-global" });
    expect(await adapter.getSessionEnv(SPEC_SEAT, "OPENRIG_SEAT_ENV_KEYS")).toBe("DO_NOT_TRACK");

    db.close();
  }, 60_000);
});
