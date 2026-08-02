import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/grammar.js";

describe("safe-core grammar (FR-1, §4.B)", () => {
  it("parses :section jump for the three launch sections", () => {
    expect(parseCommand(":topology")).toEqual({ type: "jump", section: "topology" });
    expect(parseCommand(":specs")).toEqual({ type: "jump", section: "specs" });
    expect(parseCommand(":needs")).toEqual({ type: "jump", section: "needs" });
  });

  it("names the unknown section, never a silent no-op", () => {
    const r = parseCommand(":bogus");
    expect(r.type).toBe("error");
    if (r.type === "error") expect(r.message).toMatch(/unknown section ":bogus"/);
  });

  it("parses /text filter; bare / clears", () => {
    expect(parseCommand("/driver")).toEqual({ type: "filter", text: "driver" });
    expect(parseCommand("/")).toEqual({ type: "filter", text: "" });
  });

  it("drives rig-spec views and content scrolling through the command path", () => {
    expect(parseCommand("tab topology")).toEqual({ type: "tab", tab: "topology" });
    expect(parseCommand("tab configuration")).toEqual({ type: "tab", tab: "configuration" });
    expect(parseCommand("tab yaml")).toEqual({ type: "tab", tab: "yaml" });
    expect(parseCommand("scroll down")).toEqual({ type: "content-scroll", delta: 10 });
    expect(parseCommand("scroll up")).toEqual({ type: "content-scroll", delta: -10 });
  });

  it("parses <resource> <name> drill for known resource kinds", () => {
    expect(parseCommand("rig openrig-build")).toEqual({ type: "drill", resource: "rig", name: "openrig-build" });
    expect(parseCommand("agent dev50.driver")).toEqual({ type: "drill", resource: "agent", name: "dev50.driver" });
    expect(parseCommand("host vm-host")).toEqual({ type: "drill", resource: "host", name: "vm-host" });
    expect(parseCommand("spec driver-agent")).toEqual({ type: "drill", resource: "spec", name: "driver-agent" });
  });

  it("parses cross-nav verbs", () => {
    expect(parseCommand("spec-of dev50.driver")).toEqual({ type: "cross", kind: "spec-of", name: "dev50.driver" });
    expect(parseCommand("running driver-agent")).toEqual({ type: "cross", kind: "running", name: "driver-agent" });
  });

  it("names the unknown command with the offending token", () => {
    const r = parseCommand("frobnicate xyz");
    expect(r.type).toBe("error");
    if (r.type === "error") expect(r.message).toMatch(/unknown command "frobnicate"/);
  });

  it("names a drill missing its target", () => {
    const r = parseCommand("agent");
    expect(r.type).toBe("error");
    if (r.type === "error") expect(r.message).toMatch(/agent/);
  });

  it("treats empty input as an explicit typed no-op", () => {
    expect(parseCommand("")).toEqual({ type: "noop" });
    expect(parseCommand("   ")).toEqual({ type: "noop" });
  });
});
