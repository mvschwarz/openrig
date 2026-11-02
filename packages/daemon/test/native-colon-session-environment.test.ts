import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

function fixture(valid = true, drift = false) {
  const name = "owned:logical", binding = bindNativeSessionName(name), calls: string[][] = [];
  let cursorReads = 0;
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, {
    tmpName: () => "unused", bufferName: () => "unused", writeFile: async () => {}, unlink: async () => {},
    privateConfig: async () => ({ path: "C:/owned/private.conf", dispose: async () => {} }),
  }, async argv => {
    calls.push(argv); const command = argv[1] === "-t" ? argv[3] : argv[1];
    if (command === "has-session") return "";
    if (command === "show-options") return (valid ? binding.marker : "wrong") + "\n";
    if (command === "show-environment" && argv.includes("-g")) return "";
    if (command === "list-windows") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical); return "2|owned|1|1\n"; }
    if (command === "list-panes") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical + ":2"); return `${binding.physical}|%1|0|C:/owned|80|24|1\n`; }
    if (command === "display-message") {
      expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical + ":");
      if (argv.at(-1)?.includes("cursor_x")) return `${drift && cursorReads++ > 0 ? 2 : 1}|2|80|24\n`;
      if (argv.at(-1) === "#{pane_in_mode}") return "0\n";
      return argv.at(-1) === "#{pane_pid}" ? "1234\n" : "owned-runtime\n";
    }
    if (command === "capture-pane") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical + ":"); return "owned capture\n"; }
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
it("looks up windows and indexed panes without splitting the logical session name", async () => {
  const f = fixture();
  expect(await f.adapter.listSessionWindows(f.name)).toMatchObject([{ index: 2 }]);
  expect(await f.adapter.listSessionPanes(f.name, false, 2)).toHaveLength(1);
  expect(f.calls.flat()).not.toContain("=owned");
});
it("reads metadata and captures from the bound session's current pane", async () => {
  const f = fixture();
  expect(await f.adapter.getSessionPanePid(f.name)).toBe(1234);
  expect(await f.adapter.getSessionPaneCommand(f.name)).toBe("owned-runtime");
  expect(await f.adapter.captureSessionContent(f.name, 40, { escapeSequences: true, joinWrappedLines: true })).toBe("owned capture\n");
  expect(await f.adapter.captureSessionScreen(f.name, { escapeSequences: true })).toBe("owned capture\n");
  expect(f.calls.filter(argv => argv.includes("capture-pane"))[0]).toEqual(["tmux", "capture-pane", "-p", "-e", "-J", "-t", "=" + bindNativeSessionName(f.name).physical + ":", "-S", "-40"]);
  expect(f.calls.flat()).not.toContain("=owned:");
});
it("keeps metadata and capture unknown after a binding-marker mismatch", async () => {
  const f = fixture(false);
  expect(await f.adapter.getSessionPanePid(f.name)).toBeNull(); expect(await f.adapter.getSessionPaneCommand(f.name)).toBeNull();
  expect(await f.adapter.captureSessionContent(f.name)).toBeNull(); expect(await f.adapter.captureSessionScreen(f.name)).toBeNull();
  expect(f.calls.some(argv => argv.includes("display-message") || argv.includes("capture-pane"))).toBe(false);
});
it("reads a stable composer snapshot without treating a colon as target syntax", async () => {
  const f = fixture();
  expect(await f.adapter.captureSessionComposerSnapshot(f.name)).toEqual({ screen: "owned capture\n", cursor: { x: 1, y: 2, width: 80, height: 24 }, inMode: false });
  expect(f.calls.flat()).not.toContain("=owned:");
  expect(await fixture(false).adapter.captureSessionComposerSnapshot(f.name)).toBeNull();
});
it("returns unknown if the named-session cursor changes during capture", async () => {
  const f = fixture(true, true);
  expect(await f.adapter.captureSessionComposerSnapshot(f.name)).toBeNull();
});
it("does not fall back to the name prefix when its marker is wrong", async () => {
  const f = fixture(false);
  await expect(f.adapter.getSessionEnv(f.name, "OWNED_VALUE")).rejects.toThrow();
  await expect(f.adapter.setSessionEnv(f.name, "OWNED_VALUE", "synthetic")).rejects.toThrow();
  expect(f.calls.some(argv => argv.includes("source-file") || argv.includes("set-environment"))).toBe(false);
});
