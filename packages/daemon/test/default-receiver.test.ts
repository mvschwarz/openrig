import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { describeDefaultReceiver, KERNEL_OPERATOR_SESSION, resolveDefaultReceiver } from "../src/domain/default-receiver.js";
import { effectiveInboundDestination, INHERIT_INBOUND_DESTINATION, LEGACY_INBOUND_DESTINATION, loadConfig, saveConfig, configPathFor } from "../src/domain/gateway/slack/config.js";
import { readFileSync, writeFileSync } from "node:fs";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { settingsBrowser } from "../src/domain/user-settings/settings-browser.js";

const closes: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const close of closes.splice(0)) close(); });

function db(seats: Array<[string, "running" | "exited"]> = []): Database.Database {
  const home = mkdtempSync(join(tmpdir(), "default-receiver-"));
  const d = new Database(join(home, "q.sqlite"));
  migrate(d, ALL_MIGRATIONS);
  d.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'kernel')").run();
  seats.forEach(([session, status], i) => {
    d.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, 'r', ?)").run(`n${i}`, `pod.m${i}`);
    d.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run(`n${i}`, session, status);
  });
  closes.push(() => { d.close(); rmSync(home, { recursive: true, force: true }); });
  return d;
}

describe("the default receiving agent", () => {
  it("is the chosen agent first, even with a kernel operator here, with its own seat's state", () => {
    const d = db([[KERNEL_OPERATOR_SESSION, "running"], ["front-lead@team", "exited"]]);
    expect(resolveDefaultReceiver(d, () => "front-lead@team")).toEqual({ session: "front-lead@team", source: "setting", state: "stopped" });
    expect(resolveDefaultReceiver(d, () => "nobody-yet@team")).toEqual({ session: "nobody-yet@team", source: "setting", state: "missing" });
  });

  it("is the kernel operator when none is chosen, running or stopped: a stopped one stays the receiver", () => {
    expect(resolveDefaultReceiver(db([[KERNEL_OPERATOR_SESSION, "running"]]), () => null))
      .toEqual({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", state: "running" });
    expect(resolveDefaultReceiver(db([[KERNEL_OPERATOR_SESSION, "exited"], ["other@team", "running"]]), () => null))
      .toEqual({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", state: "stopped" });
  });

  it("is none with no chosen agent and no kernel operator, and never whichever seat happens to be running", () => {
    expect(resolveDefaultReceiver(db([["other@team", "running"]]), () => null)).toEqual({ session: null, source: "none", state: "missing" });
  });

  it("reads unknown, not none, when the seats can't be read", () => {
    const d = db();
    vi.spyOn(d, "prepare").mockImplementation(() => { throw new Error("unreadable"); });
    expect(resolveDefaultReceiver(d, () => null)).toEqual({ session: null, source: "none", state: "unknown" });
    expect(resolveDefaultReceiver(d, () => "front-lead@team")).toEqual({ session: "front-lead@team", source: "setting", state: "unknown" });
  });

  it("takes the chosen agent from agents.operator_session, and ignores a person's address there", () => {
    const d = db([[KERNEL_OPERATOR_SESSION, "running"]]);
    vi.stubEnv("OPENRIG_AGENTS_OPERATOR_SESSION", "front-lead@team");
    expect(resolveDefaultReceiver(d)).toMatchObject({ session: "front-lead@team", source: "setting" });
    vi.stubEnv("OPENRIG_AGENTS_OPERATOR_SESSION", "alex@external");
    expect(resolveDefaultReceiver(d)).toMatchObject({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator" });
  });

  it("is described with where it came from and what its state means for an answer", () => {
    expect(describeDefaultReceiver({ session: "front-lead@team", source: "setting", state: "stopped" }))
      .toBe("front-lead@team, chosen in agents.operator_session; stopped: answers wait for it, and nothing is decided meanwhile.");
    expect(describeDefaultReceiver({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", state: "running" }))
      .toBe(`${KERNEL_OPERATOR_SESSION}, the kernel operator, since agents.operator_session is unset; running: it reads answers now.`);
    expect(describeDefaultReceiver({ session: null, source: "none", state: "missing" }))
      .toContain("No receiving agent on this host: set one with rig config set agents.operator_session <seat>");
  });
});

describe("Slack's unrouted destination", () => {
  it("keeps a saved destination as chosen, the kernel operator's address included, and inherits only when none is saved", () => {
    expect(effectiveInboundDestination({ inboundDestination: "triage@team" }, "front-lead@team")).toEqual({ destination: "triage@team", from: "config" });
    // Compatibility control: a saved operator-agent@kernel may have been a person's choice, so it isn't repointed.
    expect(effectiveInboundDestination({ inboundDestination: LEGACY_INBOUND_DESTINATION }, "front-lead@team"))
      .toEqual({ destination: LEGACY_INBOUND_DESTINATION, from: "config" });
    expect(effectiveInboundDestination({ inboundDestination: INHERIT_INBOUND_DESTINATION }, "front-lead@team"))
      .toEqual({ destination: "front-lead@team", from: "receiving-agent" });
    expect(effectiveInboundDestination({ inboundDestination: INHERIT_INBOUND_DESTINATION }, null))
      .toEqual({ destination: LEGACY_INBOUND_DESTINATION, from: "default" });
  });

  it("reads a file without a destination as inherited, never writes the inherit choice, and keeps a saved one", () => {
    const home = mkdtempSync(join(tmpdir(), "default-receiver-slack-"));
    closes.push(() => rmSync(home, { recursive: true, force: true }));
    expect(loadConfig(home).inboundDestination).toBe(INHERIT_INBOUND_DESTINATION);
    saveConfig({ ...loadConfig(home), channel: "C123" }, home);
    expect(JSON.parse(readFileSync(configPathFor(home), "utf8"))).not.toHaveProperty("inboundDestination");
    expect(loadConfig(home).inboundDestination).toBe(INHERIT_INBOUND_DESTINATION);
    writeFileSync(configPathFor(home), JSON.stringify({ ...JSON.parse(readFileSync(configPathFor(home), "utf8")), inboundDestination: LEGACY_INBOUND_DESTINATION }));
    expect(loadConfig(home).inboundDestination).toBe(LEGACY_INBOUND_DESTINATION);
    saveConfig(loadConfig(home), home);
    expect(JSON.parse(readFileSync(configPathFor(home), "utf8")).inboundDestination).toBe(LEGACY_INBOUND_DESTINATION);
  });
});

describe("the settings view", () => {
  it("shows the receiving agent beside the settings, and Slack's unchosen destination points to it", () => {
    const home = mkdtempSync(join(tmpdir(), "default-receiver-browser-"));
    closes.push(() => rmSync(home, { recursive: true, force: true }));
    const store = new SettingsStore(join(home, "config.json"));
    const view = settingsBrowser(store, null, home, { session: "front-lead@team", source: "setting", state: "running" });
    expect(view.entries.find((entry) => entry.key === "agents.default_receiver")).toMatchObject({
      group: "general", value: "front-lead@team", visibility: "shown",
      application: "front-lead@team, chosen in agents.operator_session; running: it reads answers now.",
    });
    expect(view.entries.find((entry) => entry.key === "slack.inboundDestination")?.application)
      .toBe("Not chosen: when the connector starts, unrouted messages go to the default receiving agent (Agents & runtime).");
    expect(settingsBrowser(store, null, home).entries.some((entry) => entry.key === "agents.default_receiver")).toBe(false);
  });
});
