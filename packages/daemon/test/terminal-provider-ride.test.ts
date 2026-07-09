// OPR.0.4.6.02 C2 — the terminal-provider ride core commit.
//
// Covers the plan's C2 test contract:
//  - composer partition vectors: read-only `-r`, ssh wrap, http honest-degrade
//    (exact reason class), unknown-host degrade, absent-named, mixed partition,
//    paging cap 9 (3×3);
//  - derived views computed live are NEVER persisted (A3);
//  - saved-views store round-trip is byte-stable + writes atomically (tmp+rename);
//  - herdr fresh-tab-on-relaunch decision (not-replace) + the FB4 socket shapes
//    (probe=ping; fresh workspace.create → ONE atomic layout.apply per page;
//    the no-CLI-strings regression — the VM-RED `herdr layout apply` class);
//  - cmux facade delegates to the shipped NodeCmuxService and degrades honestly.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  composeView,
  chunkPanes,
  PANES_PER_PAGE,
  type ViewMemberInput,
  type ComposeContext,
} from "../src/domain/terminal/view-composer.js";
import {
  TerminalViewsStore,
  deriveViewMembers,
  type SavedView,
  type LiveSeatRow,
} from "../src/domain/terminal/terminal-views-store.js";
import {
  planHerdrLayout,
  buildBspRoot,
  extractWorkspaceId,
  HerdrAdapter,
  type HerdrLayoutNode,
} from "../src/domain/terminal/herdr-adapter.js";
import {
  createHerdrSocketTransport,
  resolveHerdrSocketPath,
  parseHerdrVersion,
  unwrapHerdrResponse,
  type HerdrResult,
  type HerdrSocketRpc,
  type HerdrTransport,
} from "../src/domain/terminal/herdr-transport.js";
import { CmuxProviderAdapter } from "../src/domain/terminal/cmux-provider-adapter.js";
import type { HostEntry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { ComposedView } from "../src/domain/terminal/terminal-provider.js";

// --- host-registry fixtures ---
const SSH_HOST: HostEntry = { id: "vm1", transport: "ssh", target: "vm1.local", user: "admin" };
const SSH_HOST_NO_USER: HostEntry = { id: "vm2", transport: "ssh", target: "10.0.0.9" };
const HTTP_HOST: HostEntry = { id: "factory", transport: "http", url: "http://x:7433", bearer_env: "T" };

function ctxWith(hosts: HostEntry[]): ComposeContext {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  return { resolveHost: (id) => byId.get(id) ?? null };
}

function member(overrides: Partial<ViewMemberInput> & { seat: string }): ViewMemberInput {
  return {
    label: overrides.seat,
    tmuxSession: overrides.seat,
    host: null,
    readOnly: false,
    alive: true,
    ...overrides,
  };
}

describe("view-composer partition vectors", () => {
  it("local live seat → tmux attach -t (no -r)", () => {
    const v = composeView("v", [member({ seat: "dev-a@rig" })], ctxWith([]));
    expect(v.opened).toHaveLength(1);
    expect(v.opened[0]!.paneCommand).toBe("tmux attach -t 'dev-a@rig'");
    expect(v.opened[0]!.readOnly).toBe(false);
    expect(v.absent).toHaveLength(0);
    expect(v.degraded).toHaveLength(0);
  });

  it("view-only / cross-rig read-only seat → tmux attach -r -t", () => {
    const v = composeView("v", [member({ seat: "dev-a@rig", readOnly: true })], ctxWith([]));
    expect(v.opened[0]!.paneCommand).toBe("tmux attach -r -t 'dev-a@rig'");
    expect(v.opened[0]!.readOnly).toBe(true);
  });

  it("ssh host → ssh '<user@target>' tmux attach -t (destination shell-quoted); read-only adds -r", () => {
    const rw = composeView("v", [member({ seat: "s@r", host: "vm1", tmuxSession: "s@r" })], ctxWith([SSH_HOST]));
    expect(rw.opened[0]!.paneCommand).toBe("ssh 'admin@vm1.local' tmux attach -t 's@r'");

    const ro = composeView("v", [member({ seat: "s@r", host: "vm1", readOnly: true })], ctxWith([SSH_HOST]));
    expect(ro.opened[0]!.paneCommand).toBe("ssh 'admin@vm1.local' tmux attach -r -t 's@r'");

    const nouser = composeView("v", [member({ seat: "s@r", host: "vm2" })], ctxWith([SSH_HOST_NO_USER]));
    expect(nouser.opened[0]!.paneCommand).toBe("ssh '10.0.0.9' tmux attach -t 's@r'");
  });

  // Guard G1 — the ssh destination is STRUCTURED registry data injected into a
  // shell command string; it must stay shell-inert (exactly one argument) and
  // must never be option-shaped.
  it("G1: a shell-sensitive ssh destination stays ONE quoted argument (no extra shell words)", () => {
    const NASTY: HostEntry = { id: "evil", transport: "ssh", target: "a b; rm -rf /", user: "u'x" };
    const v = composeView("v", [member({ seat: "s@r", host: "evil", tmuxSession: "s@r" })], ctxWith([NASTY]));
    expect(v.opened).toHaveLength(1);
    // single-quoted, embedded quote POSIX-escaped ('\'') — metacharacters are literal.
    expect(v.opened[0]!.paneCommand).toBe(`ssh 'u'"'"'x@a b; rm -rf /' tmux attach -t 's@r'`);
    // the dangerous run never becomes its own shell word:
    expect(v.opened[0]!.paneCommand).not.toContain("; rm -rf / tmux");
  });

  it("G1: an option-shaped ssh destination (leading '-') is degraded, never composed", () => {
    const OPT: HostEntry = { id: "opt", transport: "ssh", target: "-oProxyCommand=touch pwned" };
    const v = composeView("v", [member({ seat: "s@r", host: "opt", tmuxSession: "s@r" })], ctxWith([OPT]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toHaveLength(1);
    expect(v.degraded[0]!.reason).toContain("option-shaped");
  });

  it("http host → NO pane, honest-degrade with the exact reason class", () => {
    const v = composeView("v", [member({ seat: "s@r", host: "factory" })], ctxWith([HTTP_HOST]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toEqual([
      { seat: "s@r", host: "factory", reason: "host factory is http-registered; tiles need ssh" },
    ]);
  });

  it("unknown host id → degraded named, never silently omitted", () => {
    const v = composeView("v", [member({ seat: "s@r", host: "ghost" })], ctxWith([]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toEqual([
      { seat: "s@r", host: "ghost", reason: "host ghost is not in the hosts registry" },
    ]);
  });

  it("dead local seat → absent named; session-less seat → absent named", () => {
    const dead = composeView("v", [member({ seat: "s@r", alive: false })], ctxWith([]));
    expect(dead.opened).toHaveLength(0);
    expect(dead.absent).toEqual([{ seat: "s@r", host: null, reason: "tmux session s@r is not alive" }]);

    const noSess = composeView("v", [member({ seat: "s@r", tmuxSession: null })], ctxWith([]));
    expect(noSess.absent).toEqual([
      { seat: "s@r", host: null, reason: "no tmux session recorded for this seat" },
    ]);

    const sshNoSess = composeView("v", [member({ seat: "s@r", host: "vm1", tmuxSession: null })], ctxWith([SSH_HOST]));
    expect(sshNoSess.absent).toEqual([
      { seat: "s@r", host: "vm1", reason: "no tmux session recorded for this seat" },
    ]);
  });

  it("mixed view partitions each member into the right bucket", () => {
    const v = composeView(
      "mix",
      [
        member({ seat: "live@r" }),
        member({ seat: "ro@r", readOnly: true }),
        member({ seat: "ssh@r", host: "vm1" }),
        member({ seat: "http@r", host: "factory" }),
        member({ seat: "dead@r", alive: false }),
        member({ seat: "ghost@r", host: "nope" }),
      ],
      ctxWith([SSH_HOST, HTTP_HOST]),
    );
    expect(v.opened.map((p) => p.seat)).toEqual(["live@r", "ro@r", "ssh@r"]);
    expect(v.degraded.map((d) => d.seat).sort()).toEqual(["ghost@r", "http@r"]);
    expect(v.absent.map((a) => a.seat)).toEqual(["dead@r"]);
  });

  it("paging caps at 9 (3×3) panes per page with deterministic order", () => {
    expect(PANES_PER_PAGE).toBe(9);
    const members = Array.from({ length: 20 }, (_, i) => member({ seat: `s${i}@r` }));
    const v = composeView("big", members, ctxWith([]));
    expect(v.opened).toHaveLength(20);
    expect(v.pages).toHaveLength(3); // 9 + 9 + 2
    expect(v.pages[0]).toHaveLength(9);
    expect(v.pages[1]).toHaveLength(9);
    expect(v.pages[2]).toHaveLength(2);
    // Order preserved into pages.
    expect(v.pages[0]![0]!.seat).toBe("s0@r");
    expect(v.pages[2]![1]!.seat).toBe("s19@r");
  });

  it("chunkPanes rejects a non-positive page size", () => {
    expect(() => chunkPanes([], 0)).toThrow();
  });
});

describe("terminal-views store — round-trip byte-stable + atomic write + A3", () => {
  function tmpStore(): { store: TerminalViewsStore; dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-views-"));
    const file = path.join(dir, "terminal-views.yaml");
    return { store: new TerminalViewsStore(file), dir, file };
  }

  const view: SavedView = {
    id: "acme-build",
    name: "acme build",
    members: [
      { seat: "orch@acme", label: "orch@acme · s02", host: "vm1", tmuxSession: "orch@acme", readOnly: true },
      { seat: "dev@acme", tmuxSession: "dev@acme" }, // no host/label/readOnly → omitted on write
    ],
  };

  it("absent file reads as the empty set", () => {
    const { store } = tmpStore();
    expect(store.read()).toEqual({ version: 1, views: [] });
    expect(store.list()).toEqual([]);
  });

  it("save→read→save round-trip is byte-identical (omit-when-absent, fixed order)", () => {
    const { store, file } = tmpStore();
    store.save(view);
    const firstBytes = fs.readFileSync(file, "utf-8");

    const readBack = store.read();
    // Optionals that were false/absent are not resurrected as null.
    expect(readBack.views[0]!.members[1]).toEqual({ seat: "dev@acme", tmuxSession: "dev@acme" });

    // Re-saving the same logical content reproduces identical bytes.
    store.save(readBack.views[0]!);
    expect(fs.readFileSync(file, "utf-8")).toBe(firstBytes);
  });

  it("save writes atomically via a tmp file then rename (no lingering tmp)", () => {
    const { store, dir, file } = tmpStore();
    store.save(view);
    expect(fs.existsSync(file)).toBe(true);
    // The tmp sidecar is renamed away, never left behind.
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["terminal-views.yaml"]);
  });

  it("upsert by id and remove are idempotent", () => {
    const { store } = tmpStore();
    store.save(view);
    store.save({ ...view, name: "renamed" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("acme-build")!.name).toBe("renamed");
    store.remove("acme-build");
    expect(store.list()).toEqual([]);
    store.remove("acme-build"); // idempotent
    expect(store.list()).toEqual([]);
  });

  it("derived views are computed live and NEVER written to disk (A3)", () => {
    const { store, file } = tmpStore();
    const rows: LiveSeatRow[] = [
      { canonicalSessionName: "a@r", attachmentType: "tmux", logicalId: "pod.a", rigName: "r" },
      { canonicalSessionName: "b@r", attachmentType: "external_cli", logicalId: "pod.b", rigName: "r" }, // dropped (non-tmux)
      { canonicalSessionName: null, attachmentType: "tmux" }, // dropped (no seat)
    ];
    const derived = deriveViewMembers(rows, { labelSuffix: "s02", readOnly: true, host: "vm1" });
    expect(derived).toEqual([
      { seat: "a@r", label: "pod.a · s02", tmuxSession: "a@r", host: "vm1", readOnly: true, alive: true },
    ]);
    // No save path was invoked → the store file must not exist.
    expect(fs.existsSync(file)).toBe(false);
    expect(store.read()).toEqual({ version: 1, views: [] });
  });
});

describe("herdr layout plan — fresh-tab-on-relaunch (BR-5) + BSP root + labels", () => {
  const view: ComposedView = {
    id: "acme-build",
    opened: [
      { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false },
      { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -r -t 'b@r'", readOnly: true },
    ],
    absent: [],
    degraded: [],
    pages: [
      [
        { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false },
        { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -r -t 'b@r'", readOnly: true },
      ],
    ],
  };

  it("re-launching the same view mints a DIFFERENT tab label (not-replace-idempotent)", () => {
    const first = planHerdrLayout(view, "l1");
    const second = planHerdrLayout(view, "l2");
    expect(first.pages[0]!.tabLabel).toBe("openrig:acme-build#l1");
    expect(second.pages[0]!.tabLabel).toBe("openrig:acme-build#l2");
    expect(first.pages[0]!.tabLabel).not.toBe(second.pages[0]!.tabLabel);
    // Same token → deterministic (same label). The workspace label matches.
    expect(planHerdrLayout(view, "l1").pages[0]!.tabLabel).toBe(first.pages[0]!.tabLabel);
    expect(first.workspaceLabel).toBe("openrig:acme-build#l1");
  });

  it("one BSP root per page — pane leaves carry <agent> · <slice> AND the composed shell command via sh -c", () => {
    const plan = planHerdrLayout(view, "l1");
    expect(plan.pages).toHaveLength(1);
    // The capture-verified layout.apply root shape: split/pane tree, argv command.
    expect(plan.pages[0]!.root).toEqual({
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: { type: "pane", label: "pod.a · s02", command: ["sh", "-c", "tmux attach -t 'a@r'"] },
      second: { type: "pane", label: "pod.b · s02", command: ["sh", "-c", "tmux attach -r -t 'b@r'"] },
    });
  });

  it("buildBspRoot alternates right/down at ratio 0.5 (same-size tiles) and keeps every pane in order", () => {
    const panes = ["a", "b", "c", "d"].map((s) => ({
      seat: s,
      label: s,
      paneCommand: `attach ${s}`,
      readOnly: false,
    }));
    const root = buildBspRoot(panes);
    if (root.type !== "split") throw new Error("expected a split root");
    expect(root.direction).toBe("right");
    expect(root.ratio).toBe(0.5);
    if (root.first.type !== "split") throw new Error("expected a nested split");
    expect(root.first.direction).toBe("down");
    // Every pane appears exactly once, in page order.
    const labels: string[] = [];
    const walk = (n: HerdrLayoutNode): void => {
      if (n.type === "pane") {
        labels.push(n.label);
        expect(n.command.slice(0, 2)).toEqual(["sh", "-c"]);
      } else {
        walk(n.first);
        walk(n.second);
      }
    };
    walk(root);
    expect(labels).toEqual(["a", "b", "c", "d"]);
  });

  it("multi-page views get one fresh tab label per page", () => {
    const many: ComposedView = {
      ...view,
      pages: [view.pages[0]!, view.pages[0]!],
    };
    const plan = planHerdrLayout(many, "l9");
    expect(plan.pages.map((p) => p.tabLabel)).toEqual([
      "openrig:acme-build#l9/1",
      "openrig:acme-build#l9/2",
    ]);
  });
});

describe("herdr adapter — socket ping probe + workspace.create → layout.apply (FB4)", () => {
  function fakeSocketTransport(opts?: {
    alive?: boolean;
    respond?: (method: string, params: unknown) => Promise<HerdrResult>;
  }): { transport: HerdrTransport; requests: Array<{ method: string; params: unknown }> } {
    const requests: Array<{ method: string; params: unknown }> = [];
    const transport: HerdrTransport = {
      async probe() {
        return { alive: opts?.alive ?? true, version: "0.7.1", protocol: 14 };
      },
      async request(method, params) {
        requests.push({ method, params });
        if (opts?.respond) return opts.respond(method, params);
        if (method === "workspace.create") return { type: "workspace_created", workspace_id: "wG" };
        return { type: "layout_apply", layout: { workspace_id: "wG", tab_id: "wG:t2" } };
      },
    };
    return { transport, requests };
  }

  const pane = { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false };
  const view: ComposedView = { id: "v", opened: [pane], absent: [], degraded: [], pages: [[pane]] };

  it("liveness = the socket ping (alive when the socket answers; honest detail when not)", async () => {
    const { transport } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    expect((await adapter.liveness()).alive).toBe(true);
    const dead = new HerdrAdapter({
      transportFactory: () => fakeSocketTransport({ alive: false }).transport,
    });
    const live = await dead.liveness();
    expect(live.alive).toBe(false);
    expect(live.detail).toContain("ping");
  });

  it("status reflects the ping probe (available + version), honestly down when unreachable", async () => {
    const { transport } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const status = await adapter.status();
    expect(status.available).toBe(true);
    expect(status.version).toBe("0.7.1");
    const down = new HerdrAdapter({
      transportFactory: () => fakeSocketTransport({ alive: false }).transport,
    });
    expect((await down.status()).available).toBe(false);
  });

  it("openView refuses herdr_unavailable when the socket is dead — and sends NOTHING", async () => {
    const { transport, requests } = fakeSocketTransport({ alive: false });
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("herdr_unavailable");
    expect(requests).toEqual([]);
  });

  it("openView = fresh workspace.create then ONE atomic layout.apply per page (capture-verified params)", async () => {
    const { transport, requests } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "tok" });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a@r"]);
    expect(res.pages).toBe(1);
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply"]);
    expect(requests[0]!.params).toEqual({ focus: false, label: "openrig:v#tok" });
    expect(requests[1]!.params).toEqual({
      workspace_id: "wG",
      tab_label: "openrig:v#tok",
      focus: true,
      root: { type: "pane", label: "pod.a · s02", command: ["sh", "-c", "tmux attach -t 'a@r'"] },
    });
  });

  it("REGRESSION (the VM-RED class): only socket methods ever — the absent CLI `herdr layout apply` cannot pass again", async () => {
    const { transport, requests } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    await adapter.openView(view);
    await adapter.status();
    await adapter.liveness();
    for (const r of requests) {
      // A socket method token, never a shell command line.
      expect(r.method).toMatch(/^[a-z_]+(\.[a-z_]+)*$/);
      expect(r.method.startsWith("herdr")).toBe(false);
      expect(r.method).not.toContain("--help");
      expect(r.method).not.toContain(" ");
    }
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply"]);
  });

  it("a labeled workspace.create failure falls back ONCE to a bare create (uncaptured-param defense)", async () => {
    const { transport, requests } = fakeSocketTransport({
      respond: async (method, params) => {
        if (method === "workspace.create") {
          if ((params as Record<string, unknown>)["label"] != null) throw new Error("unknown param: label");
          return { type: "workspace_created", workspace_id: "wH" };
        }
        return { type: "layout_apply" };
      },
    });
    const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "t" });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a@r"]);
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "workspace.create", "layout.apply"]);
    expect((requests[2]!.params as Record<string, unknown>)["workspace_id"]).toBe("wH");
  });

  it("total workspace.create failure degrades EVERY pane honestly (herdr_workspace_failed)", async () => {
    const { transport } = fakeSocketTransport({
      respond: async (method) => {
        if (method === "workspace.create") throw new Error("boom");
        return { type: "layout_apply" };
      },
    });
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("herdr_workspace_failed");
    expect(res.opened).toEqual([]);
    expect(res.pages).toBe(0);
    expect(res.degraded).toHaveLength(1);
    expect(res.degraded[0]).toMatchObject({ seat: "a@r", host: "herdr" });
    expect(res.degraded[0]!.reason).toContain("workspace.create failed");
  });

  it("a failed page degrades its seats; other pages still open (honest-partial)", async () => {
    const paneB = { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -t 'b@r'", readOnly: false };
    const two: ComposedView = {
      id: "v",
      opened: [pane, paneB],
      absent: [],
      degraded: [],
      pages: [[pane], [paneB]],
    };
    let applies = 0;
    const { transport } = fakeSocketTransport({
      respond: async (method) => {
        if (method === "workspace.create") return { type: "workspace_created", workspace_id: "wG" };
        applies += 1;
        if (applies === 2) throw new Error("herdr error: bad tree");
        return { type: "layout_apply" };
      },
    });
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const res = await adapter.openView(two);
    expect(res.ok).toBe(true); // page 1 opened → partial success with disclosure
    expect(res.opened).toEqual(["a@r"]);
    expect(res.degraded.map((d) => d.seat)).toEqual(["b@r"]);
    expect(res.degraded[0]!.reason).toContain("layout.apply failed");
  });
});

describe("herdr socket transport — ping probe, envelope unwrap, socket path (FB4)", () => {
  it("createHerdrSocketTransport probes via the socket `ping` method (never a CLI --help)", async () => {
    const sent: Array<{ id: string; method: string; params: unknown }> = [];
    const rpc: HerdrSocketRpc = async (req) => {
      sent.push(req);
      return { type: "pong", version: "0.7.1", protocol: 14 };
    };
    const t = createHerdrSocketTransport(rpc)();
    const probe = await t.probe();
    expect(probe).toEqual({ alive: true, version: "0.7.1", protocol: 14 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("ping");
    expect(sent[0]!.id).toBeTruthy();
  });

  it("probe is honestly dead when the socket is unreachable or answers garbage", async () => {
    const dead = createHerdrSocketTransport(async () => {
      throw new Error("connect ENOENT herdr.sock");
    })();
    expect((await dead.probe()).alive).toBe(false);
    const weird = createHerdrSocketTransport(async () => ({ type: "nope" }))();
    expect((await weird.probe()).alive).toBe(false);
  });

  it("unwrapHerdrResponse accepts wrapped {id,result:{type}} AND bare {type}; error/shapeless throw", () => {
    expect(unwrapHerdrResponse({ id: "x", result: { type: "layout_apply", layout: {} } })).toEqual({
      type: "layout_apply",
      layout: {},
    });
    expect(unwrapHerdrResponse({ type: "pong", version: "0.7.1" })).toEqual({ type: "pong", version: "0.7.1" });
    expect(() => unwrapHerdrResponse({ id: "x", error: "unknown method" })).toThrow(/herdr error/);
    expect(() => unwrapHerdrResponse({ id: "x" })).toThrow(/unrecognized/);
    expect(() => unwrapHerdrResponse("junk")).toThrow(/unrecognized/);
  });

  it("extractWorkspaceId tries the defensive homes in order (uncaptured workspace.create envelope)", () => {
    expect(extractWorkspaceId({ type: "w", workspace_id: "w1" })).toBe("w1");
    expect(extractWorkspaceId({ type: "w", workspace: { workspace_id: "w2" } })).toBe("w2");
    expect(extractWorkspaceId({ type: "w", workspace: { id: "w3" } })).toBe("w3");
    expect(extractWorkspaceId({ type: "w", layout: { workspace_id: "w4" } })).toBe("w4");
    expect(extractWorkspaceId({ type: "w", id: "w5" })).toBe("w5");
    expect(extractWorkspaceId({ type: "w" })).toBeNull();
  });

  it("resolveHerdrSocketPath: env override → per-session → the default; version parse", () => {
    expect(resolveHerdrSocketPath({ HERDR_SOCKET_PATH: "/x/h.sock" })).toBe("/x/h.sock");
    expect(resolveHerdrSocketPath({ HERDR_SESSION: "s1" })).toContain(path.join("sessions", "s1", "herdr.sock"));
    expect(resolveHerdrSocketPath({})).toContain(path.join(".config", "herdr", "herdr.sock"));
    expect(parseHerdrVersion("herdr 0.7.1")).toBe("0.7.1");
    expect(parseHerdrVersion(undefined)).toBeNull();
  });
});

describe("cmux facade — delegates to NodeCmuxService, degrades honestly", () => {
  function fakeCmuxAdapter(available: boolean) {
    return {
      getStatus: () => ({ available, capabilities: { rpc: true } }),
      isAvailable: () => available,
    } as unknown as import("../src/adapters/cmux.js").CmuxAdapter;
  }

  const pane = { seat: "a@r", label: "pod.a · s02", paneCommand: "x", readOnly: false };
  const view: ComposedView = {
    id: "v",
    opened: [pane, { ...pane, seat: "b@r" }],
    absent: [{ seat: "z@r", host: null, reason: "dead" }],
    degraded: [{ seat: "h@r", host: "factory", reason: "http-registered" }],
    pages: [[pane, { ...pane, seat: "b@r" }]],
  };

  it("delegates each pane to openOrFocusNodeSurface; unmappable/failed seats degrade, absents carried", async () => {
    const opened: Array<[string, string]> = [];
    const nodeCmuxService = {
      openOrFocusNodeSurface: async (rigId: string, logicalId: string) => {
        opened.push([rigId, logicalId]);
        return logicalId === "pod.b" ? { ok: false, error: "surface refused" } : { ok: true };
      },
    } as unknown as import("../src/domain/node-cmux-service.js").NodeCmuxService;

    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(true),
      nodeCmuxService,
      resolveSeatNode: (seat) =>
        seat === "a@r" ? { rigId: "r", logicalId: "pod.a" } : seat === "b@r" ? { rigId: "r", logicalId: "pod.b" } : null,
    });

    const res = await adapter.openView(view);
    expect(res.ok).toBe(true); // non-gating
    expect(res.opened).toEqual(["a@r"]);
    expect(opened).toEqual([["r", "pod.a"], ["r", "pod.b"]]);
    // Original absent carried, plus b@r's cmux failure degraded — composer's http degrade preserved.
    expect(res.absent).toEqual([{ seat: "z@r", host: null, reason: "dead" }]);
    expect(res.degraded.map((d) => d.seat).sort()).toEqual(["b@r", "h@r"]);
    expect(res.degraded.find((d) => d.seat === "b@r")!.reason).toContain("surface refused");
  });

  it("status/liveness reflect the shipped CmuxAdapter", async () => {
    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(false),
      nodeCmuxService: {} as unknown as import("../src/domain/node-cmux-service.js").NodeCmuxService,
      resolveSeatNode: () => null,
    });
    expect((await adapter.status()).available).toBe(false);
    expect((await adapter.liveness()).alive).toBe(false);
  });
});
