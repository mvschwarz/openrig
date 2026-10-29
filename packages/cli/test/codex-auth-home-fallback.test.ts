import { expect, it } from "vitest";
import { userInfo } from "node:os";
import path from "node:path";
import { resolveCodexHome } from "../src/lib/codex-auth.js";

// The mocked OS-account branch tests live beside the canonical daemon source.
// This boundary checks the CLI's real re-export without reading any auth file.
it("the CLI auth export resolves an empty or absent HOME under the actual OS account", () => {
  const expected = path.join(userInfo().homedir, ".codex");
  expect(resolveCodexHome({}).codexHome).toBe(expected);
  expect(resolveCodexHome({ HOME: "" }).codexHome).toBe(expected);
  expect(path.isAbsolute(expected)).toBe(true);
});
it("the CLI auth export retains explicit home selection", () => {
  expect(resolveCodexHome({ HOME: "synthetic-relative-home" }).codexHome).toBe(path.join("synthetic-relative-home", ".codex"));
  expect(resolveCodexHome({ HOME: "", CODEX_HOME: "synthetic-explicit-codex" }).codexHome).toBe("synthetic-explicit-codex");
});
