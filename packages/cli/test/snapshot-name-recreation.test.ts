import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "../../daemon/test/helpers/test-app.js";
import { DaemonClient } from "../src/client.js";
import { snapshotCommand } from "../src/commands/snapshot.js";
import { restoreCommand } from "../src/commands/restore.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

it("#3474: down then recreate preserves manual and auto-pre-down snapshots by name and restores their original identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-recreation-"));
  const db = createFullTestDb();
  const live = new Set<string>();
  const tmux = mockTmuxAdapter();
  vi.mocked(tmux.createSession).mockImplementation(async (name) => { live.add(name); return { ok: true }; });
  vi.mocked(tmux.killSession).mockImplementation(async (name) => { live.delete(name); return { ok: true }; });
  vi.mocked(tmux.hasSession).mockImplementation(async (name) => live.has(name));
  tmux.probeSession = async (name) => live.has(name) ? { state: "present" } : { state: "absent" };
  const fixture = createTestApp(db, {
    tmux,
    podInstantiatorFsOps: { exists: fs.existsSync, readFile: (file) => fs.readFileSync(file, "utf8") },
  });
  const client = new DaemonClient("http://fixture", {
    fetchImpl: async (input, init) => fixture.app.fetch(new Request(input, init)),
    sessionName: "",
  });
  const lifecycleDeps: LifecycleDeps = {
    spawn() { throw new Error("Fixture daemon is already running"); },
    fetch: async () => ({ ok: true }), kill: () => true,
    readFile: () => JSON.stringify({ pid: 1, port: 1, db: "fixture", startedAt: "2026-11-18T00:00:00Z" }),
    writeFile() {}, removeFile() {}, exists: (file) => file === STATE_FILE,
    mkdirp() {}, openForAppend: () => 1, isProcessAlive: () => true,
  };
  const deps = { lifecycleDeps, clientFactory: () => client };
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = async (command: Command, args: string[]) => {
    const program = new Command().exitOverride().addCommand(command);
    await program.parseAsync(["node", "rig", ...args]);
  };
  try {
    const spec = path.join(root, "rig.yaml");
    fs.writeFileSync(spec, `version: "0.2"
name: snapshot-lab
pods:
  - id: lab
    label: Lab
    members:
      - {id: shell, runtime: terminal, agent_ref: "builtin:terminal", profile: none, cwd: ${JSON.stringify(root)}}
`);
    const first = await fixture.bootstrapOrchestrator.bootstrap({ mode: "apply", sourceRef: spec });
    expect(first.status, JSON.stringify(first)).toBe("completed");
    if (!first.rigId) throw new Error("No rig id from bootstrap");
    await run(snapshotCommand(deps), ["snapshot", "snapshot-lab"]);
    const manual = fixture.snapshotRepo.listSnapshots(first.rigId)[0];
    if (!manual) throw new Error("No manual snapshot");
    const down = await client.post("/api/down", { rigId: first.rigId, snapshot: true });
    expect(down.status).toBe(200);
    const preDown = fixture.snapshotRepo.listSnapshots(first.rigId).find((snapshot) => snapshot.kind === "auto-pre-down");
    if (!preDown) throw new Error("No auto-pre-down snapshot");
    const second = await fixture.bootstrapOrchestrator.bootstrap({ mode: "apply", sourceRef: spec });
    expect(second.status, JSON.stringify(second)).toBe("completed");
    expect(second.rigId).not.toBe(first.rigId);
    expect(db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(first.rigId))
      .toMatchObject({ archived_at: expect.any(String) });

    await run(snapshotCommand(deps), ["snapshot", "list", "snapshot-lab"]);
    const listed = output.join("\n");
    expect(listed).toContain(manual.id);
    expect(listed).toContain(preDown.id);
    expect(listed.indexOf(preDown.id)).toBeLessThan(listed.lastIndexOf(manual.id));
    await client.post("/api/down", { rigId: second.rigId, snapshot: true });
    const restored = vi.spyOn(fixture.restoreOrchestrator, "restore");
    await run(restoreCommand(deps), ["restore", manual.id, "--rig", "snapshot-lab"]);
    expect(restored).toHaveBeenCalledWith(manual.id, expect.anything());
    const result = await restored.mock.results[0]?.value;
    expect(result).toMatchObject({ ok: true, result: { rigResult: "fully_restored" } });
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
