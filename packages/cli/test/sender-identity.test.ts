import { afterEach, describe, expect, it, vi } from "vitest";
import { senderIdentityHeaders } from "../src/client.js";
import { resolveSenderSession, TMUX_IDENTITY_TIMEOUT_MS } from "../src/sender-identity.js";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), execFileSync }));

afterEach(() => vi.unstubAllEnvs());

describe("managed sender identity recovery", () => {
  it("uses reconciled pane metadata when the live process missed the seat env", () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    vi.stubEnv("TMUX_PANE", "%149");
    const read = (pane: string, option: string) => {
      expect(pane).toBe("%149");
      expect(option).toBe("@rigged_session_name");
      return "producer-lead@studio";
    };
    expect(resolveSenderSession(read)).toBe("producer-lead@studio");
    expect(senderIdentityHeaders(undefined, undefined, read)).toEqual({
      "X-OpenRig-Session": "producer-lead@studio",
    });
  });

  it("keeps the process seat env authoritative over pane metadata", () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "dev-coder@studio");
    vi.stubEnv("TMUX_PANE", "%149");
    expect(resolveSenderSession(() => "producer-lead@studio")).toBe("dev-coder@studio");
  });

  it("bounds the tmux read, and a read that times out leaves the seat unresolved", () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    vi.stubEnv("TMUX_PANE", "%149");
    // The reader catches what the call throws, so the options are checked here, not inside the mock.
    execFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("spawnSync tmux ETIMEDOUT"), { code: "ETIMEDOUT" });
    });
    expect(resolveSenderSession()).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0]![2]).toMatchObject({ timeout: TMUX_IDENTITY_TIMEOUT_MS });
    expect(TMUX_IDENTITY_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it("stays unresolved when neither env nor managed pane metadata exists", () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    vi.stubEnv("TMUX_PANE", "%404");
    expect(resolveSenderSession(() => undefined)).toBeUndefined();
  });
});
