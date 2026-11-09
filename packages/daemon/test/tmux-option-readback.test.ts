import { describe, expect, it } from "vitest";
import { decodeTmux34Option } from "../src/adapters/tmux.js";

describe("tmux 3.4 option readback", () => {
  it.each([
    ["echo \\$VALUE", "echo $VALUE"],
    ["echo \\\\$VALUE", "echo \\$VALUE"],
    ["echo '\\${VALUE}'", "echo '${VALUE}'"],
    ["echo \\$1 \\$? \\$", "echo \\$1 \\$? \\$"],
  ])("decodes %j to %j on a 3.4 server", (input, expected) => {
    expect(decodeTmux34Option(input, "3.4\n")).toBe(expected);
  });

  it.each(["3.5a", "3.3a", "", "unknown"])("leaves readback unchanged for %j", version => {
    expect(decodeTmux34Option("echo \\$VALUE", version)).toBe("echo \\$VALUE");
  });
});
