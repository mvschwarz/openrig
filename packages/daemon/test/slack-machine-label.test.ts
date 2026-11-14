import { describe, expect, it } from "vitest";
import { selfMachineLabel } from "../src/domain/gateway/slack/slack-subsystem.js";

describe("selfMachineLabel (Slack sender-line machine label)", () => {
  it("prefers the operator's display name over the generated id", () => {
    expect(selfMachineLabel("uni-pc", "host-4a409197")).toBe("uni-pc");
  });

  it("keeps a display name with spaces (rig host rename's own example)", () => {
    expect(selfMachineLabel("Mac mini 2", "host-4a409197")).toBe("Mac mini 2");
  });

  it("falls back to the self-host id when no display name is set", () => {
    expect(selfMachineLabel("", "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(null, "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(undefined, "host-4a409197")).toBe("host-4a409197");
  });

  it("falls back to the self-host id for reserved/default display tokens", () => {
    // host.name DEFAULTS to "localhost" on a machine nobody named; the default
    // must never render as the machine a post came from.
    expect(selfMachineLabel("localhost", "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel("local", "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel("  localhost  ", "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel("LOCALHOST", "host-4a409197")).toBe("host-4a409197");
  });

  it("shows the display name even before boot resolved an id, and omits the label when neither exists", () => {
    expect(selfMachineLabel("uni-pc", null)).toBe("uni-pc");
    expect(selfMachineLabel("", null)).toBeNull();
    expect(selfMachineLabel("localhost", null)).toBeNull();
  });

  it("returns the id unchanged when the display name already seeded it", () => {
    expect(selfMachineLabel("uni-pc", "uni-pc")).toBe("uni-pc");
  });
});
