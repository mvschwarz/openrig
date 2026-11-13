import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { describeDefaultReceiver, KERNEL_OPERATOR_SESSION, permissionDeciderFor, resolveDefaultReceiver } from "../src/domain/default-receiver.js";
import { readReceivingAgentSetting } from "../src/domain/queue-owner.js";
import { effectiveInboundDestination, inboundDestinationNote, INHERIT_INBOUND_DESTINATION, LEGACY_INBOUND_DESTINATION, loadConfig, saveConfig, configPathFor } from "../src/domain/gateway/slack/config.js";
import { readFileSync, writeFileSync } from "node:fs";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { settingsBrowser } from "../src/domain/user-settings/settings-browser.js";

const closes: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const close of closes.splice(0)) close(); });

function db(seats: Array<[string, string]> = []): Database.Database {
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
    expect(resolveDefaultReceiver(d, () => "front-lead@team")).toEqual({ session: "front-lead@team", source: "setting", state: "stopped", recorded: "exited" });
    expect(resolveDefaultReceiver(d, () => "nobody-yet@team")).toEqual({ session: "nobody-yet@team", source: "setting", state: "missing" });
  });

  it("is the kernel operator when none is chosen, running or stopped: a stopped one stays the receiver", () => {
    expect(resolveDefaultReceiver(db([[KERNEL_OPERATOR_SESSION, "running"]]), () => null))
      .toEqual({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", state: "running", recorded: "running" });
    expect(resolveDefaultReceiver(db([[KERNEL_OPERATOR_SESSION, "exited"], ["other@team", "running"]]), () => null))
      .toEqual({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", state: "stopped", recorded: "exited" });
  });

  it("is none with no chosen agent and no kernel operator, and never whichever seat happens to be running", () => {
    expect(resolveDefaultReceiver(db([["other@team", "running"]]), () => null)).toEqual({ session: null, source: "none", state: "missing" });
  });

  it("keeps idle and unknown apart from stopped, from the seat's newest recorded session", () => {
    expect(resolveDefaultReceiver(db([["front-lead@team", "idle"]]), () => "front-lead@team")).toMatchObject({ state: "idle", recorded: "idle" });
    expect(resolveDefaultReceiver(db([["front-lead@team", "unknown"]]), () => "front-lead@team")).toMatchObject({ state: "unknown", recorded: "unknown" });
    // An older occupant's running row doesn't make a newer superseded one read running.
    expect(resolveDefaultReceiver(db([["front-lead@team", "running"], ["front-lead@team", "superseded"]]), () => "front-lead@team"))
      .toMatchObject({ state: "stopped", recorded: "superseded" });
  });

  it("reads unknown, not none, when the seats can't be read", () => {
    const d = db();
    vi.spyOn(d, "prepare").mockImplementation(() => { throw new Error("unreadable"); });
    expect(resolveDefaultReceiver(d, () => null)).toEqual({ session: null, source: "none", state: "unknown" });
    expect(resolveDefaultReceiver(d, () => "front-lead@team")).toEqual({ session: "front-lead@team", source: "setting", state: "unknown" });
  });

  it("takes the chosen agent from agents.operator_session; a person's address there is ignored, and the fallback says so", () => {
    const d = db([[KERNEL_OPERATOR_SESSION, "running"]]);
    vi.stubEnv("OPENRIG_AGENTS_OPERATOR_SESSION", "front-lead@team");
    expect(resolveDefaultReceiver(d)).toMatchObject({ session: "front-lead@team", source: "setting" });
    expect(resolveDefaultReceiver(d).note).toBeUndefined();
    vi.stubEnv("OPENRIG_AGENTS_OPERATOR_SESSION", "alex@external");
    const fallback = resolveDefaultReceiver(d);
    expect(fallback).toMatchObject({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator",
      note: 'agents.operator_session is "alex@external", which isn\'t an agent\'s session, so it\'s ignored' });
    expect(describeDefaultReceiver(fallback)).toBe(`agents.operator_session is "alex@external", which isn't an agent's session, so it's ignored. ${KERNEL_OPERATOR_SESSION}, the kernel operator, used instead; its session is recorded as running.`);
  });

  it("an unreadable agents.operator_session is reported, never read as unset", () => {
    const d = db([[KERNEL_OPERATOR_SESSION, "running"]]);
    const unreadable = { session: null, problem: "agents.operator_session couldn't be read (bad file)" };
    expect(resolveDefaultReceiver(d, () => unreadable)).toMatchObject({ session: KERNEL_OPERATOR_SESSION, note: unreadable.problem });
    expect(resolveDefaultReceiver(db(), () => unreadable)).toEqual({ session: null, source: "none", state: "missing", note: unreadable.problem });
    vi.spyOn(SettingsStore.prototype, "resolveOne").mockImplementation(() => { throw new Error("config unreadable"); });
    try {
      expect(readReceivingAgentSetting()).toEqual({ session: null, problem: "agents.operator_session couldn't be read (config unreadable)" });
    } finally { vi.restoreAllMocks(); }
  });

  it("is described with where it came from and what its state means for an answer", () => {
    expect(describeDefaultReceiver({ session: "front-lead@team", source: "setting", state: "stopped", recorded: "exited" }))
      .toBe("front-lead@team, chosen in agents.operator_session; its session is recorded as exited: answers wait for it, and nothing is decided meanwhile.");
    // What's recorded, never a claim that it's reading now.
    expect(describeDefaultReceiver({ session: KERNEL_OPERATOR_SESSION, source: "kernel-operator", state: "running", recorded: "running" }))
      .toBe(`${KERNEL_OPERATOR_SESSION}, the kernel operator, since agents.operator_session is unset; its session is recorded as running.`);
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

  it("an inherited destination with no receiver says the kernel address is kept for compatibility; a saved one says nothing", () => {
    expect(inboundDestinationNote({ destination: LEGACY_INBOUND_DESTINATION, from: "default" }, { session: null, source: "none", state: "missing" }))
      .toBe(`No receiving agent on this host: set one with rig config set agents.operator_session <seat>, or start the kernel (${KERNEL_OPERATOR_SESSION}). Unrouted messages go to ${LEGACY_INBOUND_DESTINATION} for compatibility, as before.`);
    expect(inboundDestinationNote({ destination: LEGACY_INBOUND_DESTINATION, from: "default" }, { session: null, source: "none", state: "unknown" }))
      .toContain("OpenRig couldn't tell whether this host has a receiving agent");
    expect(inboundDestinationNote({ destination: "front-lead@team", from: "receiving-agent" }, { session: "front-lead@team", source: "setting", state: "idle", recorded: "idle" }))
      .toBe("front-lead@team, chosen in agents.operator_session; its session is recorded as idle.");
    expect(inboundDestinationNote({ destination: LEGACY_INBOUND_DESTINATION, from: "config" }, null)).toBeUndefined();
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
    const view = settingsBrowser(store, null, home, { session: "front-lead@team", source: "setting", state: "running", recorded: "running" });
    expect(view.entries.find((entry) => entry.key === "agents.default_receiver")).toMatchObject({
      group: "general", value: "front-lead@team", visibility: "shown",
      application: "front-lead@team, chosen in agents.operator_session; its session is recorded as running.",
    });
    expect(view.entries.find((entry) => entry.key === "slack.inboundDestination")?.application)
      .toBe("Not chosen: when the connector starts, unrouted messages go to the default receiving agent (Agents & runtime).");
    expect(settingsBrowser(store, null, home).entries.some((entry) => entry.key === "agents.default_receiver")).toBe(false);
  });

  it("withholds the receiving agent's description when the setting holds unsafe text; with no receiver, Slack's line says where unrouted messages go", () => {
    const home = mkdtempSync(join(tmpdir(), "default-receiver-browser-"));
    closes.push(() => rmSync(home, { recursive: true, force: true }));
    const store = new SettingsStore(join(home, "config.json"));
    const unsafe = "token=synthetic-example-value";
    store.set("agents.operator_session", unsafe);
    const view = settingsBrowser(store, null, home, { session: null, source: "none", state: "missing",
      note: `agents.operator_session is "${unsafe}", which isn't an agent's session, so it's ignored` });
    const row = view.entries.find((entry) => entry.key === "agents.default_receiver")!;
    expect(row.application).toBe("Withheld: agents.operator_session holds credential-bearing or unsafe text, so the receiving agent isn't described here. Inspect it at its source.");
    expect(JSON.stringify(view)).not.toContain("synthetic-example-value");
    expect(view.entries.find((entry) => entry.key === "slack.inboundDestination")?.application)
      .toBe(`Not chosen: this host has no receiving agent (Agents & runtime), so when the connector starts, unrouted messages go to ${LEGACY_INBOUND_DESTINATION} for compatibility, as before.`);
    // A receiver that couldn't be read, or none resolved for this view, is unknown, not absent.
    const unknown = `Not chosen: OpenRig couldn't tell whether this host has a receiving agent (Agents & runtime). If it still can't when the connector starts, unrouted messages go to ${LEGACY_INBOUND_DESTINATION} for compatibility, as before.`;
    for (const receiver of [{ session: null, source: "none" as const, state: "unknown" as const }, null]) {
      expect(settingsBrowser(store, null, home, receiver).entries.find((entry) => entry.key === "slack.inboundDestination")?.application).toBe(unknown);
    }
  });
});

describe("who decides a runner's answered permission request", () => {
  it("is the receiving agent, never the requesting seat itself; then the kernel operator when it isn't the requester; else nobody", () => {
    const both = db([[KERNEL_OPERATOR_SESSION, "running"], ["lead@team", "running"]]);
    expect(permissionDeciderFor(both, "runner@team", () => "lead@team")?.session).toBe("lead@team");
    // The chosen agent is the blocked requester: the kernel operator decides instead.
    expect(permissionDeciderFor(both, "lead@team", () => "lead@team")?.session).toBe(KERNEL_OPERATOR_SESSION);
    // No agent chosen: the kernel operator, unless it's the requester.
    expect(permissionDeciderFor(both, "runner@team", () => null)?.session).toBe(KERNEL_OPERATOR_SESSION);
    expect(permissionDeciderFor(both, KERNEL_OPERATOR_SESSION, () => null)).toBeNull();
    // A stopped kernel operator stays responsible; a host without one has nobody, and OpenRig's default applies.
    expect(permissionDeciderFor(db([[KERNEL_OPERATOR_SESSION, "exited"]]), "runner@team", () => null)).toMatchObject({ session: KERNEL_OPERATOR_SESSION, state: "stopped" });
    expect(permissionDeciderFor(db([]), "runner@team", () => null)).toBeNull();
    expect(permissionDeciderFor(db([]), "lead@team", () => "lead@team")).toBeNull();
    // A chosen seat this host doesn't have can't decide: the kernel operator, when here, else nobody.
    expect(permissionDeciderFor(db([]), "runner@team", () => "ghost@team")).toBeNull();
    expect(permissionDeciderFor(both, "runner@team", () => "ghost@team")).toMatchObject({ session: KERNEL_OPERATOR_SESSION, note: "ghost@team, the receiving agent, isn't on this host" });
    // A setting that's set but ignored keeps its note when the kernel operator decides: it never reads as unset.
    const ignored = { session: null, problem: 'agents.operator_session is "alex@external", which isn\'t an agent\'s session, so it\'s ignored' };
    const kernelDecides = permissionDeciderFor(both, "runner@team", () => ignored)!;
    expect(kernelDecides).toMatchObject({ session: KERNEL_OPERATOR_SESSION, note: ignored.problem });
    expect(describeDefaultReceiver(kernelDecides)).not.toContain("unset");
  });
});
