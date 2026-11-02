import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

function fixture(present = false, confirmed = true) {
  const logical = "owned|logical", binding = bindNativeSessionName(logical), calls: string[][] = [];
  let marker = "";
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined, async argv => {
    calls.push(argv);
    const command = argv[1] === "-t" ? argv[3] : argv[1];
    if (argv[1] === "has-session") { if (!present) throw Object.assign(new Error("absent"), { code: 1, stdout: "", stderr: "" }); return ""; }
    if (argv[1] === "new-session") { expect(argv[argv.indexOf("-s") + 1]).toBe(binding.physical); present = true; return confirmed ? "$7 123\n" : "unconfirmed\n"; }
    if (argv[1] === "if-shell") { expect(argv.join(" ")).toContain("#{session_id},$7"); expect(argv.join(" ")).toContain("#{session_created},123"); marker = binding.marker!; return ""; }
    if (argv[1] === "show-options") return marker + "\n";
    if (argv[1] === "list-panes") return `${binding.physical}|%1|0|C:/owned|80|24|1\n`;
    if (command === "display-message" && argv.includes("capture-pane")) {
      expect(argv.filter((value, index) => argv[index - 1] === "-t")).toEqual([`=${binding.physical}:`, `=${binding.physical}:`]);
      return argv.filter(value => value.startsWith("__openrig_capture_")).map(marker => marker + "\nowned content\n").join("");
    }
    if (command === "display-message") return "1234\n";
    if (command === "list-sessions") return argv.at(-1) === "#{session_name}" ? binding.physical + "\n" : `${binding.physical}|1|123|0\n`;
    if (command === "list-clients") return `owned-client|${binding.physical}\n`;
    if (command === "list-windows") return argv.at(-1)!.includes("window_width") ? `1|1700000000|80x24:%1:1234:80x24:0:0:0,0|${binding.physical}\n` : `1|1700000000|${binding.physical}\n`;
    throw new Error("Unexpected fixture command: " + argv[1]);
  }, [], "psmux");
  return { adapter, logical, binding, calls, clearMarker: () => { marker = ""; } };
}

it("maps new probe creation and installs its binding only after a confirmed receipt", async () => {
  const f = fixture(); expect(await f.adapter.createProbeSession(f.logical)).toEqual({ ok: true });
  expect(await f.adapter.probeSession(f.logical)).toEqual({ state: "present" });
});
it("maps a detached CLI command only after its creation receipt and keeps child argv literal", async () => {
  const f = fixture(), child = ["C:/owned tools/node.exe", "C:/owned child.js", "-t", "owned|logical", "$(literal)"];
  expect(await f.adapter.createDetachedCommandSession(f.logical, child)).toBe("$7");
  const created = f.calls.find(argv => argv[1] === "new-session")!;
  expect(created.slice(created.indexOf("--"))).toEqual(["--", ...child]);
  expect(await f.adapter.probeSession(f.logical)).toEqual({ state: "present" });
});
it("does not create a command over an occupied mapped name", async () => {
  const f = fixture(true);
  await expect(f.adapter.createDetachedCommandSession(f.logical, ["owned.exe"])).rejects.toThrow("already occupied");
  expect(f.calls.map(argv => argv[1])).toEqual(["has-session"]);
});
it("refuses an occupied physical name without creating or binding over it", async () => {
  const f = fixture(true); expect(await f.adapter.createProbeSession(f.logical)).toMatchObject({ ok: false, code: "duplicate_session" });
  expect(f.calls.map(argv => argv[1])).toEqual(["has-session"]);
});
it("refuses a logical lookup without an observed matching marker", async () => {
  const f = fixture(true); await expect(f.adapter.probeSession(f.logical)).rejects.toThrow("no matching logical identity marker");
  expect(f.calls.map(argv => argv[1])).toEqual(["has-session", "show-options"]);
});

function legacyFixture(legacy: boolean, mapped: boolean, failure = false) {
  const logical = "openrig-native-v1-legacy", binding = bindNativeSessionName(logical), calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined, async argv => {
    calls.push(argv); const target = argv[argv.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (failure) throw new Error("synthetic permission denied");
    if (argv[1] === "has-session") {
      if ((target === logical && legacy) || (target === binding.physical && mapped)) return "";
      throw Object.assign(new Error("absent"), { code: 1, stdout: "", stderr: "" });
    }
    if (argv[1] === "show-options") return target === binding.physical && mapped ? binding.marker + "\n" : "\n";
    throw new Error("Unexpected mutation");
  }, [], "psmux");
  return { adapter, logical, binding, calls };
}

it("retains exact lookup of an existing unmarked prefix-like legacy name", async () => {
  const f = legacyFixture(true, false);
  expect(await f.adapter.probeSession(f.logical)).toEqual({ state: "present" });
  expect(f.calls.at(-1)).toEqual(["tmux", "has-session", "-t", "=" + f.logical]);
});

it("refuses creation over an existing legacy logical name without a mutation", async () => {
  const f = legacyFixture(true, false);
  expect(await f.adapter.createProbeSession(f.logical)).toMatchObject({ ok: false, code: "duplicate_session" });
  expect(f.calls.every(argv => ["has-session", "show-options"].includes(argv[1]!))).toBe(true);
});

it("refuses ambiguous legacy and mapped ownership rather than selecting one", async () => {
  const f = legacyFixture(true, true);
  await expect(f.adapter.probeSession(f.logical)).rejects.toThrow("Ambiguous native logical session name");
});

it("keeps a transport failure unknown rather than trying another legacy identity", async () => {
  const f = legacyFixture(true, true, true);
  await expect(f.adapter.probeSession(f.logical)).rejects.toThrow("permission denied");
  expect(f.calls).toHaveLength(1);
});

it("classifies a positively absent mapped name as absent", async () => {
  const f = legacyFixture(false, false);
  expect(await f.adapter.probeSession(f.logical)).toEqual({ state: "absent" });
});
it("retains an unconfirmed creation without writing identity metadata", async () => {
  const f = fixture(false, false); expect(await f.adapter.createProbeSession(f.logical)).toMatchObject({ ok: false });
  expect(f.calls.some(argv => argv[1] === "if-shell")).toBe(false);
});

it("projects observed sessions, clients, window activity and pane identities back to the logical name", async () => {
  const f = fixture(); expect(await f.adapter.createProbeSession(f.logical)).toEqual({ ok: true });
  expect((await f.adapter.listSessions()).map(session => session.name)).toEqual([f.logical]);
  expect((await f.adapter.listClients()).map(client => client.session)).toEqual([f.logical]);
  expect([...(await f.adapter.readAllSessionWindows())!.keys()]).toEqual([f.logical]);
  expect([...(await f.adapter.readAllSessionWindowActivity())!.keys()]).toEqual([f.logical]);
  const pane = (await f.adapter.listPanes(f.logical))[0]!;
  expect(pane.id).toBe(`psmux:${Buffer.from(f.logical).toString("base64url") }:%1`);
  expect(await f.adapter.getPanePid(pane.id)).toBe(1234);
  expect(f.calls.at(-1)).toContain(`=${f.binding.physical}:.%1`);
  expect((await f.adapter.capturePanesContent([f.logical]))?.get(f.logical)?.text).toBe("owned content\n");
});

it("does not decode a matching-looking listed physical name after its marker disappears", async () => {
  const f = fixture(); expect(await f.adapter.createProbeSession(f.logical)).toEqual({ ok: true });
  f.clearMarker();
  expect((await f.adapter.listSessions()).map(session => session.name)).toEqual([f.binding.physical]);
  await expect(f.adapter.probeSession(f.logical)).rejects.toThrow("no matching logical identity marker");
  expect((await f.adapter.capturePanesContent([f.logical]))?.get(f.logical)).toMatchObject({ text: null });
});
