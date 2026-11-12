import { expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";

it.runIf(process.platform === "win32").each(["none", "up", "status"] as const)("native restore service gate precedes seat effects (service failure: %s)", async fail => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "owned-service-restore-")));
  const db = createFullTestDb();
  try {
    const dir = path.join(root, "服务 & %literal% ' compose"); fs.mkdirSync(dir);
    const composeFile = path.join(dir, "compose.yaml"); fs.writeFileSync(composeFile, "services: {}\n");
    const calls = path.join(root, "calls.jsonl"), receiver = path.join(root, "docker-receiver.cjs");
    fs.writeFileSync(receiver, `const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if((${JSON.stringify(fail)}==='up'&&a.includes('up'))||(${JSON.stringify(fail)}==='status'&&a.includes('--format'))){console.error('owned compose step failed');process.exit(7);}if(a.includes('--format'))console.log('[{"Service":"db","State":"running","Health":"healthy"}]');`);
    const run = promisify(execFile);
    const adapter = new ComposeServicesAdapter(async () => { throw Error("No shell fallback"); },
      async args => (await run(process.execPath, [receiver, ...args], { windowsHide: true, timeout: 5000 })).stdout);
    const tmux = mockTmuxAdapter(), t = createTestApp(db, { tmux });
    const service = new ServiceOrchestrator({ rigRepo: t.rigRepo, composeAdapter: adapter });
    // Same dependency seam startup supplies; all terminal effects remain mocked.
    Object.assign(t.restoreOrchestrator, { serviceOrchestrator: service });
    const rig = t.rigRepo.createRig("native-service-restore");
    t.rigRepo.addNode(rig.id, "terminal", { runtime: "terminal", cwd: root });
    t.rigRepo.setServicesRecord(rig.id, { kind: "compose", rigRoot: dir, composeFile,
      projectName: "owned-restore", specJson: JSON.stringify({ kind: "compose", composeFile }), latestReceiptJson: null });
    const snapshot = t.snapshotCapture.captureSnapshot(rig.id, "manual");
    const original = JSON.stringify(snapshot.data);
    const launch = t.nodeLauncher.launchNode.bind(t.nodeLauncher);
    const start = vi.spyOn(t.nodeLauncher, "launchNode").mockImplementation(async (...args) => {
      const completed = fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(completed).toHaveLength(2);
      expect(completed[0].slice(-2)).toEqual(["up", "-d"]);
      expect(completed[1].slice(-3)).toEqual(["ps", "--format", "json"]);
      return launch(...args);
    });
    const result = await t.restoreOrchestrator.restore(snapshot.id, { freshLogicalIds: ["terminal"] });
    const actualCalls = fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const prefix = ["docker", "compose", "-f", composeFile, "-p", "owned-restore"];
    expect(actualCalls[0]).toEqual([...prefix, "up", "-d"]);
    if (fail !== "none") {
      expect(result).toMatchObject({ ok: false, code: "service_boot_failed" });
      expect(start).not.toHaveBeenCalled();
      expect(actualCalls).toHaveLength(fail === "up" ? 1 : 2);
      expect(t.rigRepo.getServicesRecord(rig.id)?.latestReceiptJson).toBeNull();
    } else {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(actualCalls[1]).toEqual([...prefix, "ps", "--format", "json"]);
      expect(start).toHaveBeenCalled();
      expect(JSON.parse(t.rigRepo.getServicesRecord(rig.id)!.latestReceiptJson!)).toMatchObject({ composeFile, services: [{ name: "db", status: "running", health: "healthy" }] });
    }
    expect(JSON.stringify(t.snapshotRepo.getSnapshot(snapshot.id)!.data)).toBe(original);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);
