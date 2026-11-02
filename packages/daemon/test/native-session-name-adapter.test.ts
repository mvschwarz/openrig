import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

function fixture(present = false, confirmed = true) {
  const logical = "owned|logical", binding = bindNativeSessionName(logical), calls: string[][] = [];
  let marker = "";
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined, async argv => {
    calls.push(argv);
    if (argv[1] === "has-session") { if (!present) throw Object.assign(new Error("absent"), { code: 1, stdout: "", stderr: "" }); return ""; }
    if (argv[1] === "new-session") { expect(argv[argv.indexOf("-s") + 1]).toBe(binding.physical); present = true; return confirmed ? "$7 123\n" : "unconfirmed\n"; }
    if (argv[1] === "if-shell") { expect(argv.join(" ")).toContain("#{session_id},$7"); expect(argv.join(" ")).toContain("#{session_created},123"); marker = binding.marker!; return ""; }
    if (argv[1] === "show-options") return marker + "\n";
    if (argv[1] === "list-panes") return `${binding.physical}|%1|0|C:/owned|80|24|1\n`;
    throw new Error("Unexpected fixture command: " + argv[1]);
  }, [], "psmux");
  return { adapter, logical, binding, calls };
}

it("maps new probe creation and installs its binding only after a confirmed receipt", async () => {
  const f = fixture(); expect(await f.adapter.createProbeSession(f.logical)).toEqual({ ok: true });
  expect(await f.adapter.probeSession(f.logical)).toEqual({ state: "present" });
});
it("refuses an occupied physical name without creating or binding over it", async () => {
  const f = fixture(true); expect(await f.adapter.createProbeSession(f.logical)).toMatchObject({ ok: false, code: "duplicate_session" });
  expect(f.calls.map(argv => argv[1])).toEqual(["has-session"]);
});
it("refuses a logical lookup without an observed matching marker", async () => {
  const f = fixture(true); await expect(f.adapter.probeSession(f.logical)).rejects.toThrow("no matching logical identity marker");
  expect(f.calls.map(argv => argv[1])).toEqual(["show-options"]);
});
it("retains an unconfirmed creation without writing identity metadata", async () => {
  const f = fixture(false, false); expect(await f.adapter.createProbeSession(f.logical)).toMatchObject({ ok: false });
  expect(f.calls.some(argv => argv[1] === "if-shell")).toBe(false);
});
