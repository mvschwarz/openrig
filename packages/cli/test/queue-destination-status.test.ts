import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../../daemon/src/startup.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import * as fanout from "../../daemon/src/domain/hosts/fanout-contract.js";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";

describe("queue create destination status is advice beside a durable row", () => {
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  let deps: QueueDeps;
  let rosterRoot: string;
  const readSetting = SettingsStore.prototype.resolveOne;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  const saved = { kernel: process.env.OPENRIG_NO_KERNEL, sender: process.env.OPENRIG_SESSION_NAME, exit: process.exitCode };

  beforeAll(async () => {
    rosterRoot = mkdtempSync(join(tmpdir(), "status-roster-"));
    mkdirSync(join(rosterRoot, "rosters"));
    mkdirSync(join(rosterRoot, "topology"));
    writeFileSync(join(rosterRoot, "rosters", "fixture.json"), JSON.stringify({ version: 1, id: "fixture", name: "fixture",
      purpose: "fixture", updated_at: "2026-11-13", curator: { seat: "sender@status-source", host: "fixture-host" },
      members: [{ seat: "reader@status-hosted", host: "fixture-host", hosted: true, capabilities: [], engagement: [], use_when: "fixture", why: "fixture" }] }));
    process.env.OPENRIG_NO_KERNEL = "1";
    process.env.OPENRIG_SESSION_NAME = "sender@status-source";
    daemon = await createDaemon({ cmuxFactory: async () => {
      throw Object.assign(new Error("no fixture socket"), { code: "ENOENT" });
    }, tmuxExec: async () => "" });
    const source = daemon.deps.rigRepo.createRig("status-source");
    daemon.deps.rigRepo.addNode(source.id, "sender", { runtime: null });
    const archived = daemon.deps.rigRepo.createRig("status-archived");
    daemon.deps.rigRepo.addNode(archived.id, "worker", { runtime: null });
    daemon.deps.rigRepo.archiveRig(archived.id);
    daemon.deps.rigRepo.createRig("status-hosted");
    daemon.deps.rigRepo.createRig("status-unknown");
    const client = { post: async (url: string, body: unknown) => {
      const response = await daemon.app.request(url, { method: "POST", headers: {
        "Content-Type": "application/json", "X-OpenRig-Session": "sender@status-source",
      }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    } };
    deps = { lifecycleDeps: { readFile: () => null, exists: () => false,
      fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
    clientFactory: () => client as unknown as ReturnType<QueueDeps["clientFactory"]> };
  });

  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(SettingsStore.prototype, "resolveOne").mockImplementation(function (this: SettingsStore, key, ...rest) {
      const resolved = readSetting.call(this, key, ...rest);
      return key === "workspace.root" ? { ...resolved, value: rosterRoot }
        : key === "topology.root" ? { ...resolved, value: join(rosterRoot, "topology") } : resolved;
    });
    vi.spyOn(fanout, "getSelfHostId").mockReturnValue("fixture-host");
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = saved.exit; });
  afterAll(() => {
    daemon.eventLoopMonitor.stop(); daemon.contextMonitor.stop(); daemon.deps.seatActivityService?.stop();
    daemon.db.close();
    rmSync(rosterRoot, { recursive: true, force: true });
    if (saved.kernel === undefined) delete process.env.OPENRIG_NO_KERNEL; else process.env.OPENRIG_NO_KERNEL = saved.kernel;
    if (saved.sender === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.sender;
  });

  it.each(["worker@new-team@host", "retired"])("quotes recorded successor %s and keeps the original destination", async owner => {
    const ledger = join(rosterRoot, "topology", "FORWARDING.md");
    writeFileSync(ledger, '| old address | new owner (or "retired") | date | decided by |\n| --- | --- | --- | --- |\n'
      + `| worker@status-archived | ${owner} | 2026-11-13 | operator |\n`);
    try {
      await queueCommand(deps).parseAsync(["create", "--destination", "worker@status-archived", "--body", "keep work", "--summary", "fixture", "--no-nudge", "--json"], { from: "user" });
      const output = JSON.parse(stdout.mock.calls.map(call => call.join(" ")).join("\n"));
      const row = output.created ?? output;
      expect(daemon.deps.queueRepo.getById(row.qitemId)?.destinationSession).toBe("worker@status-archived");
      expect(output.advisories[0].message).toContain(JSON.stringify(owner));
      expect(stderr.mock.calls.map(call => call.join(" ")).join("\n")).toContain("Recorded successor:");
    } finally { rmSync(ledger); }
  });

  it("an unreadable roster keeps absence unknown and still records the row", async () => {
    const broken = join(rosterRoot, "rosters", "broken.json");
    writeFileSync(broken, "{");
    try {
      await queueCommand(deps).parseAsync(["create", "--destination", "reader@unreadable-roster", "--body", "keep work", "--summary", "fixture", "--no-nudge", "--json"], { from: "user" });
      const output = JSON.parse(stdout.mock.calls.map(call => call.join(" ")).join("\n"));
      const row = output.created ?? output;
      expect(daemon.deps.queueRepo.getById(row.qitemId)?.destinationSession).toBe("reader@unreadable-roster");
      expect(output.advisories).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unknown" })]));
    } finally { rmSync(broken); }
  });

  for (const json of [false, true]) {
    it.each([
      ["worker@status-missing", "missing", "no live seat"],
      ["worker@status-archived", "archived", "archived"],
      ["reader@status-hosted", "hosted", "reads the queue"],
      ["worker@status-unknown", "unknown", "unknown"],
    ])("keeps %s and reports %s, json=" + json, async (destination, status, message) => {
      if (status === "hosted") expect(daemon.deps.queueRepo.isHostedMember(destination)).toBe(true);
      if (status === "unknown") vi.spyOn(daemon.deps.rigRepo, "findUnarchivedRigsByName")
        .mockImplementation(() => { throw new Error("fixture registry unavailable"); });
      await queueCommand(deps).parseAsync(["create", "--destination", destination, "--body", "keep this work",
        "--summary", "status fixture", "--no-nudge", ...(json ? ["--json"] : [])], { from: "user" });
      expect(process.exitCode, "status must not refuse the create").not.toBe(1);
      const output = JSON.parse(stdout.mock.calls.map(call => call.join(" ")).join("\n"));
      const row = output.created ?? output;
      expect(row.destinationSession).toBe(destination);
      expect(daemon.deps.queueRepo.getById(row.qitemId)).toMatchObject({ destinationSession: destination, body: "keep this work" });
      expect(output.advisories).toEqual(expect.arrayContaining([expect.objectContaining({ status, destinationSession: destination })]));
      expect(stderr.mock.calls.map(call => call.join(" ")).join("\n")).toContain(message);
      if (status === "missing" || status === "archived") expect(output.advisories[0].message).toContain("unrecorded");
    });
  }
});
