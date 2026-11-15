import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addHumanFragment } from "@openrig/daemon/gateway-human-registry";
import { startDaemon } from "../src/daemon-lifecycle.js";
import { daemonCommand } from "../src/commands/daemon.js";

vi.mock("../src/daemon-lifecycle.js", async (original) => {
  const actual = await original<typeof import("../src/daemon-lifecycle.js")>();
  return { ...actual, getDaemonStatus: vi.fn(async () => ({ state: "stopped" })), startDaemon: vi.fn(async () => ({ port: 7433, pid: 4242, host: "127.0.0.1" })) };
});
vi.mock("../src/system-preflight.js", () => ({ SystemPreflight: class { run = async () => ({ ready: true, checks: [] }); }, quietPreflightExec: async () => "" }));

const OFFER = [
  "No person is registered yet, so OpenRig's questions to a person, such as another machine asking to pair, can't reach anyone.",
  "If you're setting OpenRig up for someone, offer to register them now. Ask the name to use, and only on their yes run:",
  '  rig gateway human add <id> --display-name "<name>" --delivery-class B --default',
];

let home: string;
let logs: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "daemon-start-person-offer-"));
  vi.stubEnv("OPENRIG_HOME", home);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); process.exitCode = undefined; });

const start = () => daemonCommand({} as never).parseAsync(["start"], { from: "user" });

it("with nobody registered, daemon start ends with the offer to register the person, and registers no one", async () => {
  await start();
  expect(startDaemon).toHaveBeenCalled();
  expect(logs).toEqual(["Daemon started on port 7433 (pid 4242)", ...OFFER]);
  expect(process.exitCode).toBeUndefined();
  const { participantsView } = await import("@openrig/daemon/gateway-human-registry");
  const view = participantsView(home);
  expect(view.ok && view.participants).toEqual([]);
});

it("with a person registered, daemon start makes no offer", async () => {
  expect(addHumanFragment({ entityId: "ada", class: "human", displayName: "Ada", address: "ada@external", connectorBindings: [], prefs: { deliveryClass: "B" } }, home).ok).toBe(true);
  await start();
  expect(logs).toEqual(["Daemon started on port 7433 (pid 4242)"]);
});

it("an unreadable registry is not read as nobody registered: no offer, and the start still succeeds", async () => {
  mkdirSync(join(home, "gateway", "humans"), { recursive: true });
  writeFileSync(join(home, "gateway", "humans", "ada.yaml"), "entityId: [unclosed\n");
  await start();
  expect(logs).toEqual(["Daemon started on port 7433 (pid 4242)"]);
  expect(process.exitCode).toBeUndefined();
});
