import { describe, it, expect } from "vitest";
import { herdrAppClient } from "../src/commands/terminal.js";

const inApp = { HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/run/core.sock", HERDR_APP_HOME: "/apps/h" };
const deps = (env: NodeJS.ProcessEnv, socket = true) => ({
  env, socketExists: (p: string) => socket && p === "/apps/h/herdr-app.sock",
}) as Parameters<typeof herdrAppClient>[1];

describe("rig terminal open: when herdr-app is the target", () => {
  it("--provider herdr-app uses herdr-app's home", () => {
    expect(herdrAppClient({ provider: "herdr-app" }, deps(inApp))).toEqual({ appHome: "/apps/h" });
    expect(herdrAppClient({ provider: "herdr-app", appHome: "/x" }, deps({}))).toEqual({ appHome: "/x" });
  });

  it("with neither --provider nor --window: a herdr-app terminal whose window socket exists", () => {
    expect(herdrAppClient({}, deps(inApp))).toEqual({ appHome: "/apps/h" });
    expect(herdrAppClient({}, deps({ HERDR_APP_HOME: "/apps/h" }))).toBeNull();
    expect(herdrAppClient({}, deps(inApp, false))).toBeNull(); // markers alone invent no endpoint
  });

  it("--window and other named providers keep their meaning", () => {
    expect(herdrAppClient({ window: true }, deps(inApp))).toBeNull();
    expect(herdrAppClient({ provider: "herdr" }, deps(inApp))).toBeNull();
    expect(herdrAppClient({ provider: "cmux" }, deps(inApp))).toBeNull();
  });
});
