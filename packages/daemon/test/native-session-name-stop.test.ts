import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

function fixture(mode: "stop" | "changed" | "lost-marker" | "rollback" | "rollback-changed") {
  const logical = "owned|mapped-stop", binding = bindNativeSessionName(logical), calls: string[][] = [];
  let present = !mode.startsWith("rollback"), marker = present ? binding.marker! : "";
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined, async argv => {
    calls.push(argv); const command = argv[1] === "-t" ? argv[3] : argv[1];
    if (command === "has-session") { if (present) return ""; throw Object.assign(new Error("absent"), { code: 1, stdout: "", stderr: "" }); }
    if (command === "show-options") return marker + "\n";
    if (command === "new-session") { present = true; return "$7 123\n"; }
    if (command === "display-message") {
      expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical + ":");
      if (mode === "lost-marker") marker = ""; return "$7\n";
    }
    if (command === "list-panes") return ""; // forces rollback of this newly allocated probe
    if (command === "if-shell") {
      if (argv.some(value => value.startsWith("set-option "))) { marker = binding.marker!; return ""; }
      expect(argv.slice(0, 4)).toEqual(["tmux", "-t", "=" + binding.physical, "if-shell"]);
      expect(argv).toContain("kill-session"); expect(argv).not.toContain("kill-session -t '$7'");
      expect(argv.join(" ")).toContain("#{session_id},$7");
      if (mode.startsWith("rollback")) {
        expect(argv.join(" ")).toContain("#{session_name}," + binding.physical);
        expect(argv.join(" ")).toContain("#{session_created},123");
      }
      if (mode.endsWith("changed")) return "kept\n";
      present = false; return "";
    }
    throw new Error("Unexpected fixture command: " + command);
  }, [], "psmux");
  return { adapter, logical, calls, present: () => present };
}

it("stops only the verified physical server and observes positive absence", async () => {
  const f = fixture("stop"); expect(await f.adapter.killSession(f.logical)).toEqual({ ok: true }); expect(f.present()).toBe(false);
});
it("does not report a changed native identity as stopped", async () => {
  const f = fixture("changed"); expect(await f.adapter.killSession(f.logical)).toMatchObject({ ok: false, code: "guard_target_changed" }); expect(f.present()).toBe(true);
});
it("does not send the kill conditional after its logical marker disappears", async () => {
  const f = fixture("lost-marker"); expect(await f.adapter.killSession(f.logical)).toMatchObject({ ok: false });
  expect(f.calls.some(argv => argv.includes("if-shell"))).toBe(false); expect(f.present()).toBe(true);
});
it.each(["rollback", "rollback-changed"] as const)("uses the original creation receipt for mapped probe cleanup (%s)", async mode => {
  const f = fixture(mode); expect(await f.adapter.createProbeSession(f.logical)).toMatchObject({ ok: false, code: "guard_target_unknown" });
  expect(f.present()).toBe(mode === "rollback-changed");
});
