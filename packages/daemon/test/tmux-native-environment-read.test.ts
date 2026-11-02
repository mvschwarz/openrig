import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

for (const backend of ["psmux", "tmux"] as const) {
it.each(["", "line", "trailing\r", "line\n", "line\r\n", "first\nVALUE=second\n", "日本語🙂\n\n"])(`reads a ${backend} selected value exactly (%j)`, async value => {
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined, async argv => {
    const key = argv.at(-1)!;
    if (key.startsWith("OPENRIG_SELECTOR_PROBE_")) throw new Error("unknown variable: " + key);
    return "VALUE=" + value + "\n";
  }, [], backend);
  expect(await adapter.getSessionEnv("owned", "VALUE")).toBe(value);
});
}

it("refuses an unqualified whole-environment response instead of truncating a value", async () => {
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined,
    async () => "VALUE=synthetic-first\nOTHER=synthetic-private\n", [], "psmux");
  await expect(adapter.getSessionEnv("owned", "VALUE")).rejects.toThrow("Cannot read the session's launch environment.");
});

it("matches native selected and removed response keys using Windows environment spelling", async () => {
  let output = "Mixed_Name=synthetic exact value\n";
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined, async () => output, [], "psmux");
  expect(await adapter.getSessionEnv("owned", "mixed_name")).toBe("synthetic exact value");
  output = "-Mixed_Name\n";
  expect(await adapter.getSessionEnv("owned", "mixed_name")).toBeUndefined();
});
