import { describe, expect, it } from "vitest";
import { askBackRoute, RUNNER_CLOSE_WAITS, terminalAnswerMeaning } from "../src/domain/receiver-context.js";

describe("what a receiving agent reads to act on a person's answer", () => {
  it("names the person to ask back, and never the unattributed terminal actor", () => {
    const route = askBackRoute("sarah@external", "human@host", "request q-1");
    expect(route).toContain("ask them back with an ask to sarah@external that names request q-1: rig queue create --destination sarah@external");
    expect(route).toContain("A row to human@host names no person: it asks no one, waits on Steering and in the Feed, and OpenRig reports it as undeliverable, so don't ask them back there.");
  });

  it("with no registered person to ask back: says so once, keeps the request and the answer waiting, and names the ways through", () => {
    const route = askBackRoute(null, "human@host", "request q-1");
    expect(route).toContain("OpenRig can't resolve a registered person to ask back about request q-1: nobody registered matches, or the person registry couldn't be read (rig gateway human list shows which).");
    expect(route).toContain("Say so once, in this conversation, and keep the request and their answer waiting.");
    expect(route).toContain("repairing an unreadable registry, registering a person (rig gateway human add), or the request's own decision command");
    expect(route).not.toContain("rig queue create");
  });

  it("explains an unattributed terminal answer as the answer of whoever is at this machine, to act on without a confirmation", () => {
    expect(terminalAnswerMeaning("human@host")).toContain("human@host is how OpenRig records any answer typed at this machine's terminal or TUI");
    expect(terminalAnswerMeaning("human@host")).toContain("don't ask them to confirm it");
  });

  it("says a close without a decision permits nothing, and keeps the default permit to a request nobody answered", () => {
    expect(RUNNER_CLOSE_WAITS).toContain("Closing this item without deciding permits nothing");
    expect(RUNNER_CLOSE_WAITS).toContain("OpenRig's default permit applies only to a request nobody answered.");
  });
});
