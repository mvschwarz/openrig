import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { addHumanFragment, humansDir, projectionPath } from "../src/domain/gateway/human-registry.js";
import {
  participantsPath, participantsView, readParticipantsFile, removeParticipantEntry, resolveDefaultPerson, updateParticipantsFile,
} from "../src/domain/gateway/participants.js";
import { projectHumans } from "../src/domain/gateway/human-registry.js";

// The participant side file: organizations, groups, readable policy, shared channels and the default person live in
// gateway/participants.yaml, never in a person's fragment, so a v0.7.0 daemon (which refuses a fragment with any key it
// doesn't know) still loads every person after a rollback.

const V070_FRAGMENT_KEYS = ["address", "class", "connectorBindings", "displayName", "entityId", "prefs"];
const addPerson = (home: string, entityId: string, handle: string) => {
  const added = addHumanFragment({
    entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
    connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: `vault://slack/${entityId}`, role: "primary", handle }],
    prefs: { deliveryClass: "B" },
  }, home);
  expect(added.ok, added.ok ? "" : added.error).toBe(true);
};
const ORG_POLICY = "Answer Acme's customers within a working day. Never promise a date.";

describe("the participant side file", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "participants-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const organize = () => updateParticipantsFile((file) => {
    file.organizations.acme = { name: "Acme", policy: ORG_POLICY };
    file.groups.support = { organization: "acme", name: "Support", policy: "Support answers billing questions." };
    file.participants.sarah = { kind: "person", organization: "acme", groups: ["support"], policy: "Sarah approves refunds." };
    file.participants["acme-customers"] = {
      kind: "shared-channel", displayName: "Acme customers", organization: "acme", groups: ["support"],
      channel: { connector: "slack", connectorRef: "primary", secretsRef: "vault://slack/bot", channelId: "C0ACME" },
    };
    file.default = "sarah";
    return file;
  }, home);

  it("registers people and a shared channel with organization, groups, policy and a default, and lists and shows them", () => {
    addPerson(home, "mike", "UMIKE");
    addPerson(home, "sarah", "USARAH");
    expect(organize()).toMatchObject({ ok: true, warnings: [] });

    const view = participantsView(home);
    if (!view.ok) throw new Error(view.error);
    // Sorted by id, people and channels together.
    expect(view.participants.map((p) => [p.id, p.kind, p.address, p.default])).toEqual([
      ["acme-customers", "shared-channel", "acme-customers@external", false],
      ["mike", "person", "mike@external", false],
      ["sarah", "person", "sarah@external", true],
    ]);
    const sarah = view.participants.find((p) => p.id === "sarah")!;
    expect(sarah).toMatchObject({ organization: { id: "acme", name: "Acme" }, groups: [{ id: "support", name: "Support" }] });
    // Policy is text, outermost first, each part saying where it came from.
    expect(sarah.policy).toEqual([
      { source: "organization acme (Acme)", text: ORG_POLICY },
      { source: "group support (Support)", text: "Support answers billing questions." },
      { source: "participant", text: "Sarah approves refunds." },
    ]);
    expect(view.participants.find((p) => p.id === "acme-customers")).toMatchObject({ channel: { connector: "slack", channelId: "C0ACME" } });
  });

  it("never touches a person's fragment or the generated projection: both stay byte-identical, with v0.7.0's keys only", () => {
    addPerson(home, "mike", "UMIKE");
    addPerson(home, "sarah", "USARAH");
    const fragmentsBefore = readdirSync(humansDir(home)).filter((f) => f.endsWith(".yaml")).map((f) => readFileSync(join(humansDir(home), f), "utf8"));
    const projectionBefore = readFileSync(projectionPath(home), "utf8");
    expect(organize().ok).toBe(true);
    expect(readdirSync(humansDir(home)).filter((f) => f.endsWith(".yaml")).map((f) => readFileSync(join(humansDir(home), f), "utf8"))).toEqual(fragmentsBefore);
    expect(readFileSync(projectionPath(home), "utf8")).toBe(projectionBefore);
    for (const body of fragmentsBefore) expect(Object.keys(parseYaml(body) as object).sort()).toEqual(V070_FRAGMENT_KEYS);
    // The new facts are all in the side file, outside the fragment folder.
    expect(participantsPath(home)).toBe(join(home, "gateway", "participants.yaml"));
  });

  it("picks the default: the chosen person, else the only person, else none with the reason, never the first of several", () => {
    addPerson(home, "mike", "UMIKE");
    const people = () => { const p = projectHumans(home); if (!p.ok) throw new Error(p.error); return p.entities; };
    expect(resolveDefaultPerson(people(), home)).toMatchObject({ source: "only-person", person: { entityId: "mike" } });
    addPerson(home, "sarah", "USARAH");
    const none = resolveDefaultPerson(people(), home);
    expect(none).toMatchObject({ source: "none", person: null });
    expect(none.source === "none" && none.reason).toContain("rig gateway default");
    expect(updateParticipantsFile((file) => ({ ...file, default: "sarah" }), home).ok).toBe(true);
    expect(resolveDefaultPerson(people(), home)).toMatchObject({ source: "chosen", person: { entityId: "sarah" } });
  });

  it("refuses a shared channel as the default, a channel that takes a person's id, an unknown group, and an unknown key", () => {
    addPerson(home, "mike", "UMIKE");
    expect(organize()).toMatchObject({ ok: false });
    addPerson(home, "sarah", "USARAH");
    expect(organize().ok).toBe(true);
    const refuse = (change: Parameters<typeof updateParticipantsFile>[0]) => {
      const result = updateParticipantsFile(change, home);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.error;
    };
    expect(refuse((file) => ({ ...file, default: "acme-customers" }))).toContain("shared channel");
    expect(refuse((file) => { file.participants.mike = { kind: "shared-channel", displayName: "x", channel: { connector: "slack", connectorRef: "p", secretsRef: "v", channelId: "C1" } }; return file; }))
      .toContain("already a person's id");
    expect(refuse((file) => { file.participants.mike = { kind: "person", groups: ["nope"] }; return file; })).toContain("isn't a known group");
    expect(refuse((file) => ({ ...file, role: "admin" } as never))).toContain('unknown key "role"');
  });

  it("a person removed by hand leaves a warning, not a broken file; the rest still reads", () => {
    addPerson(home, "mike", "UMIKE");
    addPerson(home, "sarah", "USARAH");
    expect(organize().ok).toBe(true);
    unlinkSync(join(humansDir(home), "sarah.yaml"));
    const read = readParticipantsFile(home, new Set(["mike"]));
    if (!read.ok) throw new Error(read.error);
    expect(read.file.default).toBeUndefined();
    expect(read.file.participants.sarah).toBeUndefined();
    expect(read.file.participants["acme-customers"]).toBeDefined();
    expect(read.warnings).toHaveLength(2);
  });

  it("an unreadable side file still lists every person and says why the rest is missing; the person registry keeps working", () => {
    addPerson(home, "mike", "UMIKE");
    addPerson(home, "sarah", "USARAH");
    writeFileSync(participantsPath(home), "version: 1\norganizations: [not, a, mapping]\n");
    const view = participantsView(home);
    if (!view.ok) throw new Error(view.error);
    expect(view.participants.map((p) => p.id)).toEqual(["mike", "sarah"]);
    expect(view.sideFile.error).toContain("organizations must be a mapping");
    expect(view.default).toMatchObject({ source: "none" });
    expect(projectHumans(home).ok).toBe(true);
  });

  it("refuses a person who'd take a shared channel's id, before any write: the channel, the default and the file stay intact", () => {
    addPerson(home, "mike", "UMIKE");
    addPerson(home, "sarah", "USARAH");
    expect(organize().ok).toBe(true);
    const sideBefore = readFileSync(participantsPath(home), "utf8");
    const peopleBefore = readdirSync(humansDir(home)).sort();
    const added = addHumanFragment({
      entityId: "acme-customers", class: "human", displayName: "Someone", address: "acme-customers@external",
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "vault://slack/someone", role: "primary", handle: "USOMEONE" }],
      prefs: { deliveryClass: "B" },
    }, home);
    expect(added.ok).toBe(false);
    expect(added.ok ? "" : added.error).toContain('already the shared channel "Acme customers"');
    expect(readdirSync(humansDir(home)).sort()).toEqual(peopleBefore);
    expect(readFileSync(participantsPath(home), "utf8")).toBe(sideBefore);
    const view = participantsView(home);
    if (!view.ok) throw new Error(view.error);
    expect(view.sideFile.error).toBeUndefined();
    expect(view.default).toMatchObject({ source: "chosen", person: { entityId: "sarah" } });
    expect(view.participants.find((p) => p.id === "acme-customers")?.kind).toBe("shared-channel");
  });

  it("removing a person's entry never removes a shared channel with that id", () => {
    addPerson(home, "mike", "UMIKE");
    addPerson(home, "sarah", "USARAH");
    expect(organize().ok).toBe(true);
    expect(removeParticipantEntry("acme-customers", home, { kind: "person" }).ok).toBe(true);
    const read = readParticipantsFile(home, new Set(["mike", "sarah"]));
    if (!read.ok) throw new Error(read.error);
    expect(read.file.participants["acme-customers"]?.kind).toBe("shared-channel");
    expect(read.file.default).toBe("sarah");
  });
});
