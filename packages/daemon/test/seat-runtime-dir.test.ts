// #2030: the runtime directory a seat gets on Linux, and which of a seat's own values win over it.
import { describe, expect, it } from "vitest";
import { NO_SESSION_BUS, addSeatRuntimeDir, seatRuntimeDir } from "../src/domain/seat-runtime-dir.js";

describe("seatRuntimeDir", () => {
  it.each([
    ["linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000"],
    ["linux", {}, undefined],
    ["linux", { XDG_RUNTIME_DIR: "" }, undefined],
    ["linux", { XDG_RUNTIME_DIR: "run/user/1000" }, undefined],
    ["darwin", { XDG_RUNTIME_DIR: "/run/user/1000" }, undefined],
  ] as const)("on %s with %j hands seats %s", (platform, env, expected) => {
    expect(seatRuntimeDir(env, platform)).toBe(expected);
  });
});

describe("addSeatRuntimeDir", () => {
  it.each([
    ["nothing of its own", {}, { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS }],
    ["its own runtime directory", { XDG_RUNTIME_DIR: "/seat" }, { XDG_RUNTIME_DIR: "/seat" }],
    ["its own empty runtime directory", { XDG_RUNTIME_DIR: "" }, { XDG_RUNTIME_DIR: "" }],
    // libdbus reads an empty address as unset, so it would find the bus in the added directory.
    ["an empty bus address", { DBUS_SESSION_BUS_ADDRESS: "" }, { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS }],
    ["its own bus address", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" },
      { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" }],
    ["both of its own", { XDG_RUNTIME_DIR: "/seat", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" },
      { XDG_RUNTIME_DIR: "/seat", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" }],
  ] as const)("a seat with %s keeps it", (_label, seat, expected) => {
    const env: Record<string, string | undefined> = { PATH: "/bin", ...seat };
    addSeatRuntimeDir(env, "/run/user/1000");
    expect(env).toEqual({ PATH: "/bin", ...expected });
  });

  it("adds nothing when there's no runtime directory to hand on", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    addSeatRuntimeDir(env, undefined);
    expect(env).toEqual({ PATH: "/bin" });
  });
});
