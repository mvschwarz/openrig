import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
// #707 — a seat's tile must not depend on the terminal provider's PATH to find tmux, and a pane that
// exits at once must not be reported as opened. The shell parsing below is real; no terminal
// provider, tmux server or ssh server is claimed, and the herdr replies are fakes.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeView, type ViewMemberInput } from "../src/domain/terminal/view-composer.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { HerdrAdapter, HERDR_PANE_EXITED_REASON, HERDR_PANES_UNCONFIRMED_NOTE } from "../src/domain/terminal/herdr-adapter.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { ComposedPane, ComposedView, OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";

const local = (seat: string, readOnly = false): ViewMemberInput => ({ seat, label: seat, tmuxSession: seat, host: null, readOnly, alive: true });

describe("#707 local tiles run the tmux the daemon resolves", () => {
  it("a provider PATH without tmux fails the bare command; the resolved path attaches, keeping -r", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-707-"));
    const narrow = join(root, "provider-path"); // the provider's PATH: no tmux here
    const elsewhere = join(root, "elsewhere"); // where the daemon found tmux
    mkdirSync(narrow);
    mkdirSync(elsewhere);
    const tmux = join(elsewhere, "tmux");
    writeFileSync(tmux, '#!/bin/sh\ncase $1 in display-message) target=$4; target=${target#=}; printf "7 session-id:%s\\n" "${target%:}";; show-environment) exit 1;; attach) printf "%s\\n" "$@" > "$OPR_ARGS";; esac\n', { mode: 0o700 });
    const argsFile = join(root, "args");
    const env = { PATH: narrow, OPR_ARGS: argsFile };
    try {
      for (const readOnly of [false, true]) {
        const bare = composeView("v", [local("seat'a", readOnly)], { resolveHost: () => null });
        // The reported failure: `sh: tmux: command not found`, exit 127.
        expect(spawnSync("/bin/sh", ["-c", bare.opened[0]!.paneCommand], { env }).status).toBe(127);

        const resolved = composeView("v", [local("seat'a", readOnly)], { resolveHost: () => null, localTmux: tmux });
        execFileSync("/bin/sh", ["-c", resolved.opened[0]!.paneCommand], { env });
        expect(readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual(["attach", ...(readOnly ? ["-r"] : ["-f", "ignore-size"]), "-t", "session-id"]);
        expect(resolved.opened[0]!.readOnly).toBe(readOnly);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an ssh tile's remote command is unchanged when a local path is resolved", () => {
    const remote: ViewMemberInput = { seat: "r", label: "r", tmuxSession: "r", host: "edge", readOnly: true, alive: true };
    const resolveHost = () => ({ id: "edge", transport: "ssh" as const, target: "fixture" });
    const withPath = composeView("v", [remote], { resolveHost, localTmux: "/opt/homebrew/bin/tmux" });
    const without = composeView("v", [remote], { resolveHost });
    expect(withPath.opened[0]!.paneCommand).toBe(without.opened[0]!.paneCommand);
    expect(withPath.opened[0]!.paneCommand).not.toContain("/opt/homebrew");
  });

  it("without a resolved path the composed view is byte-identical to before", () => {
    const members = [local("a"), local("b", true)];
    const before = composeView("v", members, { resolveHost: () => null });
    expect(JSON.stringify(composeView("v", members, { resolveHost: () => null, localTmux: undefined }))).toBe(JSON.stringify(before));
    expect(before.opened.map((p) => p.paneCommand)).toEqual([tileAttachArgv("tmux", [], "a", false).map(shellQuote).join(" "), tileAttachArgv("tmux", [], "b", true).map(shellQuote).join(" ")]);
  });
});

class RecordingHerdr implements TerminalProvider {
  readonly name = "herdr";
  readonly panesPerPage = 16;
  last: ComposedView | null = null;
  async status() { return { provider: this.name, available: true, capabilities: {} }; }
  async liveness() { return { alive: true }; }
  async openView(view: ComposedView): Promise<OpenViewResult> {
    this.last = view;
    return { provider: this.name, ok: true, opened: view.opened.map((p) => p.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
  }
}

function service(resolveLocalTmux?: TerminalServiceDeps["resolveLocalTmux"]): { svc: TerminalService; herdr: RecordingHerdr } {
  const herdr = new RecordingHerdr();
  const rows = [{ canonicalSessionName: "a@r", attachmentType: "tmux" as const, tmuxSession: "a@r", rigName: "r", logicalId: "pod.a" }];
  const deps = {
    resolveProvider: (n: string) => (n === "herdr" ? herdr : null),
    viewsStore: { get: () => null, list: () => [] },
    listRigSeats: (r: string) => (r === "r" ? rows : null),
    listPodSeats: () => null,
    listScopeSeats: () => null,
    listRigNames: () => ["r"],
    resolveHost: () => null,
    hasSession: () => true,
    ...(resolveLocalTmux ? { resolveLocalTmux } : {}),
  } as TerminalServiceDeps;
  return { svc: new TerminalService(deps), herdr };
}

describe("#707 the service passes only an absolute resolved tmux to the composer", () => {
  const cases: Array<[string, TerminalServiceDeps["resolveLocalTmux"] | undefined, string]> = [
    ["an absolute path", () => "/usr/local/bin/tmux", "'/usr/local/bin/tmux' attach -f ignore-size -t 'a@r'"],
    ["a bare name", () => "tmux", "tmux attach -f ignore-size -t 'a@r'"],
    ["nothing found", async () => null, "tmux attach -f ignore-size -t 'a@r'"],
    ["a failed probe", () => { throw new Error("probe failed"); }, "tmux attach -f ignore-size -t 'a@r'"],
    ["no resolver", undefined, "tmux attach -f ignore-size -t 'a@r'"],
  ];
  it.each(cases)("%s", async (_name, resolver, expected) => {
    const { svc, herdr } = service(resolver);
    const res = await svc.openView({ view: "rig:r" });
    expect(res.ok).toBe(true);
    expect(herdr.last!.opened[0]!.recoveryCommand).toBe(expected);
  });

  it("resolves once, so the preview's plan still matches the open", async () => {
    let calls = 0;
    const { svc, herdr } = service(async () => { calls++; return "/usr/local/bin/tmux"; });
    const preview = await svc.previewView({ view: "rig:r" }) as { planId: string };
    const res = await svc.openView({ view: "rig:r", expectedPlan: preview.planId });
    expect(res.code).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(herdr.last).not.toBeNull();
    expect(calls).toBe(1);
  });
});

function herdrOpening(paneList: (params: Record<string, unknown>) => HerdrResult): { adapter: HerdrAdapter; methods: string[] } {
  const methods: string[] = [];
  const transport: HerdrTransport = {
    probe: async () => ({ alive: true, version: "0.7.1", protocol: 14 }),
    request: async (method, params) => {
      methods.push(method);
      if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
      if (method === "layout.apply") return { type: "layout_apply", layout: { workspace_id: "w1", tab_id: "w1:t1" } };
      if (method === "pane.list") return paneList(params as Record<string, unknown>);
      return { type: "ok" };
    },
  };
  return { adapter: new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "tok" }), methods };
}
const pane = (seat: string, label = seat): ComposedPane => ({ seat, label, paneCommand: `tmux attach -f ignore-size -t '${seat}'`, readOnly: false });
const viewOf = (...panes: ComposedPane[]): ComposedView => ({ id: "v", opened: panes, absent: [], degraded: [], pages: [panes] });
// Three seats lay out as a 2×2 grid with one blank filler pane (label "").
const listed = (...labels: Array<string | undefined>): HerdrResult => ({
  type: "pane_list",
  panes: labels.map((label, i) => ({ pane_id: `p${i}`, tab_id: "w1:t1", ...(label === undefined ? {} : { label }) })),
});

describe("#707 herdr reports a pane already gone after layout.apply as degraded, and fails safe", () => {
  it("a confirmed tab with one seat's label missing: that seat is degraded, its siblings stay opened", async () => {
    const { adapter, methods } = herdrOpening((params) => {
      expect(params).toEqual({ workspace_id: "w1" });
      return listed("a", "c", "");
    });
    const res = await adapter.openView(viewOf(pane("a"), pane("b"), pane("c")));
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a", "c"]);
    expect(res.degraded).toEqual([{ seat: "b", host: "herdr", reason: HERDR_PANE_EXITED_REASON }]);
    expect(methods.filter((m) => m === "pane.list")).toHaveLength(1);
    expect(res.notes).toBeUndefined();
  });

  it("three seats plus one filler: when only the filler pane is left, every seat is degraded and the open is not ok", async () => {
    const { adapter } = herdrOpening(() => listed(""));
    const res = await adapter.openView(viewOf(pane("a"), pane("b"), pane("c")));
    expect(res.ok).toBe(false);
    expect(res.opened).toEqual([]);
    expect(res.degraded.map((d) => d.seat)).toEqual(["a", "b", "c"]);
  });

  it("only seat a's label is left (b, c and the filler gone): a stays opened, b and c are degraded", async () => {
    const { adapter } = herdrOpening(() => listed("a"));
    const res = await adapter.openView(viewOf(pane("a"), pane("b"), pane("c")));
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a"]);
    expect(res.degraded.map((d) => d.seat)).toEqual(["b", "c"]);
  });

  it("an unlabelled remainder confirms no seats: every seat is degraded with a note", async () => {
    const { adapter } = herdrOpening(() => listed(undefined));
    const res = await adapter.openView(viewOf(pane("a"), pane("b"), pane("c")));
    expect(res.ok).toBe(false);
    expect(res.opened).toEqual([]);
    expect(res.degraded.map(d => d.seat)).toEqual(["a", "b", "c"]);
    expect(res.degraded.every(d => d.code === "pane_unconfirmed" && d.reason === HERDR_PANES_UNCONFIRMED_NOTE)).toBe(true);
    expect(res.notes).toContain(HERDR_PANES_UNCONFIRMED_NOTE);
  });

  it("a blank-labelled seat is degraded while its confirmed labelled siblings stay opened", async () => {
    // A saved view may give a member a whitespace-only label.
    const { adapter } = herdrOpening(() => listed(" ", "b", "c", ""));
    const res = await adapter.openView(viewOf(pane("a", " "), pane("b"), pane("c")));
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["b", "c"]);
    expect(res.degraded.map(d => d.seat)).toEqual(["a"]);
    expect(res.degraded.every(d => d.code === "pane_unconfirmed" && d.reason === HERDR_PANES_UNCONFIRMED_NOTE)).toBe(true);
    expect(res.notes).toEqual([HERDR_PANES_UNCONFIRMED_NOTE]);
  });

  it("a blank-labelled seat prevents filler-only attribution: every seat is degraded with a note", async () => {
    const { adapter } = herdrOpening(() => listed(""));
    const res = await adapter.openView(viewOf(pane("a", " "), pane("b"), pane("c")));
    expect(res.opened).toEqual([]);
    expect(res.degraded.map(d => d.seat)).toEqual(["a", "b", "c"]);
    expect(res.degraded.every(d => d.code === "pane_unconfirmed" && d.reason === HERDR_PANES_UNCONFIRMED_NOTE)).toBe(true);
    expect(res.notes).toEqual([HERDR_PANES_UNCONFIRMED_NOTE]);
  });

  it("an absent tab or empty listing confirms no seats: every seat is degraded with a note", async () => {
    const otherTab: HerdrResult = { type: "pane_list", panes: [{ pane_id: "p0", tab_id: "1", label: "a" }] };
    for (const reply of [otherTab, { type: "pane_list", panes: [] }]) {
      const { adapter } = herdrOpening(() => reply);
      const res = await adapter.openView(viewOf(pane("a"), pane("b")));
      expect(res.ok).toBe(false);
      expect(res.opened).toEqual([]);
      expect(res.degraded.map(d => d.seat)).toEqual(["a", "b"]);
      expect(res.degraded.every(d => d.code === "pane_unconfirmed" && d.reason === HERDR_PANES_UNCONFIRMED_NOTE)).toBe(true);
      expect(res.notes).toEqual([HERDR_PANES_UNCONFIRMED_NOTE]);
    }
  });

  it("unmatched listed labels confirm no seats and report an unconfirmed note", async () => {
    const { adapter } = herdrOpening(() => listed("renamed-1", "renamed-2", ""));
    const res = await adapter.openView(viewOf(pane("a"), pane("b"), pane("c")));
    expect(res.opened).toEqual([]);
    expect(res.degraded).toEqual(["a", "b", "c"].map(seat => ({ seat, host: "herdr", code: "pane_unconfirmed", reason: HERDR_PANES_UNCONFIRMED_NOTE })));
    expect(res.notes).toEqual([HERDR_PANES_UNCONFIRMED_NOTE]);
  });

  it("a truncated or padded label still matches its seat", async () => {
    const { adapter } = herdrOpening(() => listed("  pod.a ·  a-long-sli…", "pod.b · short"));
    const res = await adapter.openView(viewOf(pane("a", "pod.a · a-long-slice-name"), pane("b", "pod.b · short")));
    expect(res.opened).toEqual(["a", "b"]);
    expect(res.degraded).toEqual([]);
    expect(res.notes).toBeUndefined();
  });

  it.each(["ops", "lead@ops"])("exact labels with prefix %s both stay opened", async label => {
    const labels = [label, `${label}-qa`];
    const { adapter, methods } = herdrOpening(() => listed(...labels));
    const res = await adapter.openView(viewOf(...labels.map(value => pane(value))));
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(labels);
    expect(res.degraded).toEqual([]);
    expect(res.code).toBeUndefined();
    expect(res.notes).toBeUndefined();
    expect(methods).toContain("tab.focus");
  });

  it.each([
    { name: "one short pane", labels: ["ops"] },
    { name: "two short panes", labels: ["ops", "ops"] },
  ])("does not call a candidate exited when its label may be truncated: $name", async ({ labels }) => {
    const { adapter } = herdrOpening(() => listed(...labels));
    const res = await adapter.openView(viewOf(pane("a", "ops"), pane("b", "ops-qa")));
    expect(res.ok).toBe(false);
    expect(res.opened).toEqual([]);
    expect(res.degraded).toEqual(["a", "b"].map(seat => ({ seat, host: "herdr", code: "pane_unconfirmed", reason: HERDR_PANES_UNCONFIRMED_NOTE })));
    expect(res.notes).toEqual([HERDR_PANES_UNCONFIRMED_NOTE]);
  });

  it.each([
    { name: "a duplicate pane missing", labels: ["ops", "ops-qa", ""] },
    { name: "an ambiguous extra pane", labels: ["ops", "ops-qa", "op…", ""] },
  ])("counts each pane once with exact prefixes and shared labels: $name", async ({ labels }) => {
    const { adapter } = herdrOpening(() => listed(...labels));
    const res = await adapter.openView(viewOf(pane("a", "ops"), pane("b", "ops-qa"), pane("c", "ops-qa")));
    // The short pane could also be the missing duplicate's truncation: no candidate is certain.
    expect(res.ok).toBe(false);
    expect(res.opened).toEqual([]);
    expect(res.degraded).toEqual(["a", "b", "c"].map(seat => ({ seat, host: "herdr", code: "pane_unconfirmed", reason: HERDR_PANES_UNCONFIRMED_NOTE })));
    expect(res.notes).toContain(HERDR_PANES_UNCONFIRMED_NOTE);
    expect(res.notes?.join(" ")).toContain('Several seats share that label, so their panes are unconfirmed.');
  });

  it("confirms overlapping labels when exact counts account for every shared seat", async () => {
    const { adapter } = herdrOpening(() => listed("ops", "ops-qa", "ops-qa", ""));
    const res = await adapter.openView(viewOf(pane("a", "ops"), pane("b", "ops-qa"), pane("c", "ops-qa")));
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a", "b", "c"]);
    expect(res.degraded).toEqual([]);
    expect(res.notes).toBeUndefined();
  });

  it("counts separate unambiguous truncated panes for a shared label", async () => {
    const { adapter } = herdrOpening(() => listed("ops-q…", "ops-q…", "other", ""));
    const res = await adapter.openView(viewOf(pane("a", "ops-qa"), pane("b", "ops-qa"), pane("c", "other")));
    expect(res.opened).toEqual(["a", "b", "c"]);
    expect(res.degraded).toEqual([]);
    expect(res.notes).toBeUndefined();
  });

  it("one truncated label cannot confirm two differently labelled seats", async () => {
    const { adapter } = herdrOpening(() => listed("pod.a…", "other"));
    const res = await adapter.openView(viewOf(pane("a", "pod.alpha"), pane("b", "pod.alpine"), pane("c", "other")));
    expect(res.opened).toEqual(["c"]);
    expect(res.degraded.map(d => [d.seat, d.code])).toEqual([["a", "pane_unconfirmed"], ["b", "pane_unconfirmed"]]);
  });

  it("seats sharing a label are not attributed; a note says one exited", async () => {
    const { adapter } = herdrOpening(() => listed("same"));
    const res = await adapter.openView(viewOf(pane("x", "same"), pane("y", "same")));
    expect(res.opened).toEqual([]);
    expect(res.degraded.map(d => d.seat)).toEqual(["x", "y"]);
    expect(res.degraded.every(d => d.code === "pane_unconfirmed" && d.reason === HERDR_PANES_UNCONFIRMED_NOTE)).toBe(true);
    expect(res.notes).toContain(HERDR_PANES_UNCONFIRMED_NOTE);
  });

  it("a listing without labels confirms no seats and reports an unconfirmed note", async () => {
    const { adapter } = herdrOpening(() => listed(undefined, undefined));
    const res = await adapter.openView(viewOf(pane("a"), pane("b"), pane("c")));
    expect(res.opened).toEqual([]);
    expect(res.degraded).toEqual(["a", "b", "c"].map(seat => ({ seat, host: "herdr", code: "pane_unconfirmed", reason: HERDR_PANES_UNCONFIRMED_NOTE })));
    expect(res.notes).toContain(HERDR_PANES_UNCONFIRMED_NOTE);
  });

  it("an unreadable or unrecognised listing degrades every seat with a note", async () => {
    for (const paneList of [() => { throw new Error("unknown method"); }, () => ({ type: "ok" })]) {
      const { adapter } = herdrOpening(paneList);
      const res = await adapter.openView(viewOf(pane("a"), pane("b")));
      expect(res.ok).toBe(false);
      expect(res.opened).toEqual([]);
      expect(res.degraded.map(d => d.seat)).toEqual(["a", "b"]);
      expect(res.degraded.every(d => d.code === "pane_unconfirmed" && d.reason === HERDR_PANES_UNCONFIRMED_NOTE)).toBe(true);
      expect(res.notes).toEqual([HERDR_PANES_UNCONFIRMED_NOTE]);
    }
  });
});
