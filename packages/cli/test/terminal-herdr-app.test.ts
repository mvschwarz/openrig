import { describe, it, expect } from "vitest";
import { herdrAppClient, terminalCommand } from "../src/commands/terminal.js";

const inApp = { HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/run/core.sock", HERDR_APP_HOME: "/apps/h" };
const deps = (env: NodeJS.ProcessEnv, socket = true) => ({
  env, socketExists: (p: string) => socket && p === "/apps/h/herdr-app.sock",
}) as Parameters<typeof herdrAppClient>[1];

describe("rig terminal open: when herdr-app is the target", () => {
  it("open --help states which command reuses herdr-app and which asks for a desktop window", () => {
    const open = terminalCommand().commands.find((c) => c.name() === "open")!;
    const help = open.helpInformation();
    expect(help).toContain("--provider herdr-app opens in the herdr-app window you run it in");
    expect(help).toContain("--provider herdr-app opens a Rig view in the herdr-app window you run it in");
    expect(help).toContain("plain rig terminal open <view> does the same while that window is answering");
    expect(help).toContain("--window always asks for a new desktop window");
  });

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
