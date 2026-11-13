import { afterEach, describe, expect, it, vi } from "vitest";
import { senderIdentityHeaders } from "../src/client.js";
import { resolveSenderSession } from "../src/sender-identity.js";

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

  it("stays unresolved when neither env nor managed pane metadata exists", () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    vi.stubEnv("TMUX_PANE", "%404");
    expect(resolveSenderSession(() => undefined)).toBeUndefined();
  });
});
