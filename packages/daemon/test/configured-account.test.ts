import { expect, it } from "vitest";
import { configuredAccount } from "../src/domain/configured-account.js";

it("distinguishes a custom account home from the default login without exposing paths", () => {
  expect(configuredAccount("claude-code", true, null, null)).toBe("login");
  expect(configuredAccount("claude-code", true, null, "/private/home")).toBeNull();
  expect(configuredAccount("claude-code", true, JSON.stringify({ label: "team", tokenFile: "/private/token" }), "/private/home")).toBe("team");
  expect(configuredAccount("claude-code", false, null, null)).toBeNull();
  expect(configuredAccount("codex", true, null, null)).toBeNull();
});
