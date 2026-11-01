import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHerdrSocketPath } from "../src/domain/terminal/herdr-transport.js";

describe("Herdr endpoint resolution", () => {
  const home = path.resolve("daemon-home");
  const config = path.resolve("custom-config");
  const socket = path.resolve("private-socket", "herdr.sock");
  const base = path.join(config, "herdr");

  it.each([
    [undefined, undefined, "herdr.sock"],
    ["prod", undefined, "sessions/prod/herdr.sock"],
    ["default", undefined, "herdr.sock"],
    ["prod", "stage", "sessions/stage/herdr.sock"],
    ["prod", "default", "herdr.sock"],
  ])("config home with configured %s and requested %s", (configured, requested, suffix) => {
    expect(resolveHerdrSocketPath({ HOME: home, XDG_CONFIG_HOME: config, HERDR_SESSION: configured }, requested))
      .toBe(path.join(base, suffix!));
  });

  it("uses HOME/.config when the config home is absent", () => {
    expect(resolveHerdrSocketPath({ HOME: home }, "prod"))
      .toBe(path.join(home, ".config", "herdr", "sessions", "prod", "herdr.sock"));
  });

  it.each(["", "relative-config"])("honors a set config home even when it is not absolute (%s)", xdg => {
    expect(resolveHerdrSocketPath({ HOME: home, XDG_CONFIG_HOME: xdg }, "prod"))
      .toBe(path.join(path.resolve(xdg), "herdr", "sessions", "prod", "herdr.sock"));
  });

  it("keeps an explicit socket for no selection or its declared session only", () => {
    const env = { HOME: home, XDG_CONFIG_HOME: config, HERDR_SOCKET_PATH: socket, HERDR_SESSION: "prod" };
    expect(resolveHerdrSocketPath(env)).toBe(socket);
    expect(resolveHerdrSocketPath(env, "prod")).toBe(socket);
    expect(resolveHerdrSocketPath(env, "stage")).toBe(path.join(base, "sessions", "stage", "herdr.sock"));
    expect(resolveHerdrSocketPath(env, "default")).toBe(path.join(base, "herdr.sock"));
    expect(resolveHerdrSocketPath({ ...env, HERDR_SESSION: "default" }, "default")).toBe(socket);
  });

  it("does not infer an arbitrary socket's session from its directory or apply it to a requested name", () => {
    const env = { HOME: home, XDG_CONFIG_HOME: config, HERDR_SOCKET_PATH: socket };
    expect(resolveHerdrSocketPath(env)).toBe(socket);
    expect(resolveHerdrSocketPath(env, "prod")).toBe(path.join(base, "sessions", "prod", "herdr.sock"));
    expect(resolveHerdrSocketPath(env, "default")).toBe(path.join(base, "herdr.sock"));
  });
});
