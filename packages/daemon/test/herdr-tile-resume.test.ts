// A Herdr server restart restores its layout but not the pane processes, so OpenRig's tiles came back
// as empty shells. After each page applies, OpenRig now gives Herdr each tile's reattach command as a
// session-only report under the runtime's own label, which Herdr reruns after a restart while its
// screen detection keeps the tile's state. The herdr replies below are fakes shaped like Herdr 0.9.5's:
// `layout.apply` echoes the applied tree with a `pane_id` on each leaf.
import { describe, expect, it } from "vitest";
import { composeView, type ViewMemberInput } from "../src/domain/terminal/view-composer.js";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { ComposedView } from "../src/domain/terminal/terminal-provider.js";
import type { HostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const SSH: HostEntry = { id: "vm1", transport: "ssh", target: "vm1.local", user: "admin" };
const member = (seat: string, runtime: string | null, extra: Partial<ViewMemberInput> = {}): ViewMemberInput =>
  ({ seat, runtime, label: seat, tmuxSession: seat, host: null, readOnly: false, alive: true, ...extra });
const compose = (...members: ViewMemberInput[]): ComposedView =>
  composeView("v", members, { resolveHost: (id) => (id === SSH.id ? SSH : null), localTmux: "/usr/bin/tmux", localTmuxServer: ["-L", "openrig"] });

/** Herdr 0.9.5's reply: the requested tree, with each pane leaf's id (w1:p1, w1:p2, … in leaf order). */
function echoApplied(root: unknown): unknown {
  let next = 0;
  const walk = (node: Record<string, unknown>): Record<string, unknown> => node["type"] === "pane"
    ? { ...node, pane_id: `w1:p${++next}`, cwd: "/home/u" }
    : { ...node, first: walk(node["first"] as Record<string, unknown>), second: walk(node["second"] as Record<string, unknown>) };
  return walk(root as Record<string, unknown>);
}

/** `report` returns the herdr error a report gets on that attempt for that pane, or null to accept it. */
function herdr(opts: {
  apply?: (root: unknown) => HerdrResult;
  liveLabels?: (labels: string[]) => string[];
  report?: (paneId: string, attempt: number) => string | null;
} = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const attempts = new Map<string, number>();
  const sleeps: number[] = [];
  let appliedLabels: string[] = [];
  const transport: HerdrTransport = {
    probe: async () => ({ alive: true, version: "0.9.5", protocol: 14 }),
    request: async (method, params) => {
      const p = params as Record<string, unknown>;
      requests.push({ method, params: p });
      if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
      if (method === "layout.apply") {
        const labels: string[] = [];
        const collect = (n: Record<string, unknown>): void => {
          if (n["type"] === "pane") labels.push(n["label"] as string);
          else { collect(n["first"] as Record<string, unknown>); collect(n["second"] as Record<string, unknown>); }
        };
        collect(p["root"] as Record<string, unknown>);
        appliedLabels = labels;
        return opts.apply ? opts.apply(p["root"]) : { type: "layout_apply", layout: { workspace_id: "w1", tab_id: "w1:t1", root: echoApplied(p["root"]) } };
      }
      if (method === "pane.list") {
        const live = opts.liveLabels ? opts.liveLabels(appliedLabels) : appliedLabels;
        return { type: "pane_list", panes: live.map((label, i) => ({ pane_id: `w1:p${i + 1}`, tab_id: "w1:t1", label })) };
      }
      if (method === "pane.report_agent_session") {
        const paneId = p["pane_id"] as string;
        const attempt = (attempts.get(paneId) ?? 0) + 1;
        attempts.set(paneId, attempt);
        const error = opts.report?.(paneId, attempt) ?? null;
        if (error) throw new Error(`herdr error: ${JSON.stringify({ code: error, message: error })}`);
      }
      return { type: "ok" };
    },
  };
  const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "tok", sleep: async (ms) => { sleeps.push(ms); } });
  const reports = () => requests.filter((r) => r.method === "pane.report_agent_session").map((r) => r.params);
  return { adapter, requests, reports, attempts, sleeps };
}

describe("Herdr tiles carry their reattach command, so a Herdr restart brings them back", () => {
  it("a local Claude tile gets one session-only report with its reattach argv, and no state report", async () => {
    const { adapter, requests, reports } = herdr();
    const res = await adapter.openView(compose(member("dev-impl@r", "claude-code")));

    expect(res.opened).toEqual(["dev-impl@r"]);
    expect(reports()).toEqual([{
      pane_id: "w1:p1", source: "openrig", agent: "claude",
      resume_argv: ["env", "HERDR_AGENT=claude", "OPENRIG_TILE=w1:p1", "/usr/bin/tmux", "-L", "openrig", "attach", "-t", "dev-impl@r"],
    }]);
    // A held state report would replace Herdr's screen detection of the agent in the tile.
    expect(requests.some((r) => r.method === "pane.report_agent")).toBe(false);
    expect(res.notes).toBeUndefined();
  });

  it("each tile reports under its own runtime label and pane, read-only keeps -r, and tiles Herdr can't restore get none", async () => {
    const { adapter, reports } = herdr();
    const res = await adapter.openView(compose(
      member("qa@r", "codex", { readOnly: true }),
      member("shell@r", "terminal"),
      member("remote@r", "claude-code", { host: "vm1" }),
      member("pi@r", "pi"),
    ));

    expect(res.opened).toEqual(["qa@r", "shell@r", "remote@r", "pi@r"]);
    expect(reports()).toEqual([
      { pane_id: "w1:p1", source: "openrig", agent: "codex",
        resume_argv: ["env", "HERDR_AGENT=codex", "OPENRIG_TILE=w1:p1", "/usr/bin/tmux", "-L", "openrig", "attach", "-r", "-t", "qa@r"] },
      { pane_id: "w1:p4", source: "openrig", agent: "pi",
        resume_argv: ["env", "HERDR_AGENT=pi", "OPENRIG_TILE=w1:p4", "/usr/bin/tmux", "-L", "openrig", "attach", "-t", "pi@r"] },
    ]);
  });

  it("a session name Herdr would refuse (an apostrophe) gets no report", async () => {
    const { adapter, reports } = herdr();
    const res = await adapter.openView(compose(member("seat'a@r", "claude-code"), member("b@r", "claude-code")));
    expect(res.opened).toEqual(["seat'a@r", "b@r"]);
    expect(reports().map((r) => (r["resume_argv"] as string[]).at(-1))).toEqual(["b@r"]);
  });

  it("a pane that exited right after opening gets no report; its siblings still do", async () => {
    const { adapter, reports } = herdr({ liveLabels: (labels) => labels.filter((l) => l !== "b@r") });
    const res = await adapter.openView(compose(member("a@r", "claude-code"), member("b@r", "claude-code"), member("c@r", "claude-code")));
    expect(res.opened).toEqual(["a@r", "c@r"]);
    expect(reports().map((r) => [r["pane_id"], (r["resume_argv"] as string[]).at(-1)])).toEqual([["w1:p1", "a@r"], ["w1:p3", "c@r"]]);
  });

  it("a report Herdr refuses for another reason isn't retried: the seat stays opened and a note says to reopen after a restart", async () => {
    const { adapter, attempts } = herdr({ report: () => "invalid_resume_argv" });
    const res = await adapter.openView(compose(member("dev-impl@r", "claude-code")));
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["dev-impl@r"]);
    expect(attempts.get("w1:p1")).toBe(1);
    expect(res.notes).toEqual([
      'herdr didn\'t take the restart command for dev-impl@r (herdr error: {"code":"invalid_resume_argv","message":"invalid_resume_argv"}); after a Herdr restart, reopen this view.',
    ]);
  });

  // Herdr accepts the command only once its detector has recognised the agent in the pane, which runs
  // after the pane starts; until then it answers resume_not_accepted.
  it("detection that becomes ready after the first report: the refused report is retried and accepted, with no note", async () => {
    const { adapter, attempts, sleeps, reports } = herdr({ report: (paneId, attempt) => (paneId === "w1:p2" && attempt < 3 ? "resume_not_accepted" : null) });
    const res = await adapter.openView(compose(member("a@r", "claude-code"), member("b@r", "claude-code")));
    expect(res.opened).toEqual(["a@r", "b@r"]);
    expect([...attempts]).toEqual([["w1:p1", 1], ["w1:p2", 3]]);
    expect(sleeps).toEqual([500, 500]);
    expect(reports().map((r) => r["pane_id"])).toEqual(["w1:p1", "w1:p2", "w1:p2", "w1:p2"]);
    expect(res.notes).toBeUndefined();
  });

  it("an agent Herdr never recognises: the report is tried for about 3 s, then a note; the seat stays opened", async () => {
    const { adapter, attempts, sleeps } = herdr({ report: () => "resume_not_accepted" });
    const res = await adapter.openView(compose(member("dev-impl@r", "claude-code")));
    expect(res.opened).toEqual(["dev-impl@r"]);
    expect(attempts.get("w1:p1")).toBe(7);
    expect(sleeps).toEqual([500, 500, 500, 500, 500, 500]);
    expect(res.notes).toEqual(["herdr hadn't recognised the agent in dev-impl@r yet, so those tiles have no restart command; after a Herdr restart, reopen this view."]);
  });

  // Herdr keeps one restore per identical command across the whole session, so each tile's command is made distinct.
  it("two tiles of one seat get distinct restart commands, so a Herdr restart keeps both", async () => {
    const { adapter, reports } = herdr();
    await adapter.openView(compose(member("dev-impl@r", "claude-code"), member("dev-impl@r", "claude-code", { label: "second view" })));
    const argvs = reports().map((r) => r["resume_argv"] as string[]);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).not.toEqual(argvs[1]);
    expect(argvs.map((a) => a.filter((arg) => !arg.startsWith("OPENRIG_TILE=")))).toEqual([argvs[0]!.filter((arg) => !arg.startsWith("OPENRIG_TILE=")), argvs[0]!.filter((arg) => !arg.startsWith("OPENRIG_TILE="))]);
    expect(argvs.map((a) => a[2])).toEqual(["OPENRIG_TILE=w1:p1", "OPENRIG_TILE=w1:p2"]);
  });

  it("a reply without the applied tree (an older Herdr) or with a different tree reports nothing, and says so", async () => {
    const older = herdr({ apply: () => ({ type: "layout_apply", layout: { workspace_id: "w1", tab_id: "w1:t1" } }) });
    const res = await older.adapter.openView(compose(member("dev-impl@r", "claude-code")));
    expect(res.opened).toEqual(["dev-impl@r"]);
    expect(older.reports()).toEqual([]);
    expect(res.notes).toEqual(["herdr's reply didn't show which pane is which, so these tiles have no restart command: dev-impl@r; after a Herdr restart, reopen this view."]);

    const other = herdr({ apply: (root) => {
      const applied = echoApplied(root) as Record<string, unknown>;
      return { type: "layout_apply", layout: { tab_id: "w1:t1", root: { ...applied, command: ["sh", "-c", "something else"] } } };
    } });
    const otherRes = await other.adapter.openView(compose(member("dev-impl@r", "claude-code")));
    expect(other.reports()).toEqual([]);
    expect(otherRes.notes).toHaveLength(1);
  });
});

describe("the composer gives a local tile the same attach as an argv", () => {
  it("local tiles carry the attach argv beside the shell command; ssh tiles don't", () => {
    const v = compose(member("a@r", "claude-code"), member("b@r", "codex", { readOnly: true }), member("s@r", "claude-code", { host: "vm1" }));
    expect(v.opened.map((p) => [p.paneCommand, p.attachArgv])).toEqual([
      ["'/usr/bin/tmux' -L 'openrig' attach -t 'a@r'", ["/usr/bin/tmux", "-L", "openrig", "attach", "-t", "a@r"]],
      ["'/usr/bin/tmux' -L 'openrig' attach -r -t 'b@r'", ["/usr/bin/tmux", "-L", "openrig", "attach", "-r", "-t", "b@r"]],
      ["ssh 'admin@vm1.local' 'tmux attach -t '\"'\"'s@r'\"'\"''", undefined],
    ]);
  });
});
