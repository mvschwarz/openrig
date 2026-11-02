import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

function fixture(valid = true) {
  const name = "owned:logical", binding = bindNativeSessionName(name), calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, {
    tmpName: () => "unused", bufferName: () => "unused", writeFile: async () => {}, unlink: async () => {},
    privateConfig: async () => ({ path: "C:/owned/private.conf", dispose: async () => {} }),
  }, async argv => {
    calls.push(argv); const command = argv[1] === "-t" ? argv[3] : argv[1];
    if (command === "has-session") return "";
    if (command === "show-options") return (valid ? binding.marker : "wrong") + "\n";
    if (command === "show-environment" && argv.includes("-g")) return "";
    if (command === "show-environment") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical); return "OWNED_VALUE=literal\n"; }
    if (["source-file", "set-environment"].includes(command!)) { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical); return ""; }
    throw new Error("Unexpected command: " + command);
  }, [], "psmux");
  return { name, adapter, calls };
}
it("reads and changes only the fully bound colon-bearing session", async () => {
  const f = fixture();
  expect(await f.adapter.getSessionEnv(f.name, "OWNED_VALUE")).toBe("literal");
  await f.adapter.setSessionEnv(f.name, "OWNED_VALUE", "synthetic"); await f.adapter.unsetSessionEnv(f.name, "OWNED_VALUE");
  expect(f.calls.flat()).not.toContain("=owned");
});
it("does not fall back to the name prefix when its marker is wrong", async () => {
  const f = fixture(false);
  await expect(f.adapter.getSessionEnv(f.name, "OWNED_VALUE")).rejects.toThrow();
  await expect(f.adapter.setSessionEnv(f.name, "OWNED_VALUE", "synthetic")).rejects.toThrow();
  expect(f.calls.some(argv => argv.includes("source-file") || argv.includes("set-environment"))).toBe(false);
});
