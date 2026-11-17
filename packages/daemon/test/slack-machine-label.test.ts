import { describe, expect, it } from "vitest";
import { selfMachineLabel } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const configured = (value: string) => ({ value, source: "file" as const });

describe("selfMachineLabel (Slack sender-line machine label)", () => {
  it("prefers the operator's display name over the generated id", () => {
    expect(selfMachineLabel(configured("uni-pc"), "host-4a409197")).toBe("uni-pc");
  });

  it("keeps a display name with spaces (rig host rename's own example)", () => {
    expect(selfMachineLabel(configured("Mac mini 2"), "host-4a409197")).toBe("Mac mini 2");
  });

  it("falls back to the self-host id when no display name is set", () => {
    expect(selfMachineLabel(configured(""), "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(configured("   "), "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(null, "host-4a409197")).toBe("host-4a409197");
    expect(selfMachineLabel(undefined, "host-4a409197")).toBe("host-4a409197");
  });

  it.each(["Local", "Kernel", "localhost", "Mac mini 2"])("shows the chosen name %s even when it looks reserved", (name) => {
    const setting = new SettingsStore().resolveOne("host.name", { host: { name } });
    expect(selfMachineLabel(setting, "host-4a409197")).toBe(name);
  });

  it("falls back for an unconfigured default, using its source rather than its spelling", () => {
    const setting = new SettingsStore().resolveOne("host.name", {});
    expect(setting.source).toBe("default");
    expect(selfMachineLabel(setting, "host-4a409197")).toBe("host-4a409197");
  });

  it("shows the display name even before boot resolved an id, and omits the label when neither exists", () => {
    expect(selfMachineLabel(configured("uni-pc"), null)).toBe("uni-pc");
    expect(selfMachineLabel(configured(""), null)).toBeNull();
    expect(selfMachineLabel({ value: "localhost", source: "default" }, null)).toBeNull();
  });

  it("returns the id unchanged when the display name already seeded it", () => {
    expect(selfMachineLabel(configured("uni-pc"), "uni-pc")).toBe("uni-pc");
  });
});
