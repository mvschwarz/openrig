import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe("private metadata probe argv routing", () => {
  it("allocates through the native argv executor with literal cwd and format", async () => {
    const legacy = vi.fn(async () => { throw new Error("legacy shell must not execute"); });
    const argv = vi.fn(async (_args: string[]) => "$5 123\n");
    const tmux = new TmuxAdapter(legacy, undefined, argv, "psmux");
    vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%3", index: 0, cwd: "", width: 80, height: 24, active: true }]);
    const cwd = "C:\\fixture space's\\中文";
    expect(await tmux.createProbeSession("private-probe", cwd)).toEqual({ ok: true });
    expect(argv).toHaveBeenCalledWith(["tmux", "new-session", "-d", "-P", "-F", "#{session_id} #{session_created}", "-s", "private-probe", "-c", cwd]);
    expect(legacy).not.toHaveBeenCalled();
  });
  it.each(["probe-a", "probe-b"])("scopes failed allocation cleanup to %s and retains the atomic identity check", async name => {
    const legacy = vi.fn(async () => { throw new Error("legacy shell must not execute"); });
    const argv = vi.fn(async (args: string[]) => args.includes("new-session") ? "$5 123\n" : "kept\n");
    const tmux = new TmuxAdapter(legacy, undefined, argv, "psmux");
    vi.spyOn(tmux, "listPanes").mockResolvedValue([]);
    expect(await tmux.createProbeSession(name)).toMatchObject({ ok: false, code: "guard_target_unknown" });
    const cleanup = argv.mock.calls.find(([args]) => args.includes("if-shell"))?.[0];
    expect(cleanup).toEqual(["tmux", "-t", `=${name}`, "if-shell", "-F", "-t", "$5",
      `#{&&:#{==:#{session_name},${name}},#{==:#{session_created},123}}`, "kill-session -t '$5'", "display-message -p kept"]);
    expect(legacy).not.toHaveBeenCalled();
  });
});
