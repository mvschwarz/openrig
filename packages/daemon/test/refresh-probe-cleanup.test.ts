// #188 — the snapshot refresh's private Claude probe (`rigged-refresh-*`) must not outlive the probe.
// Real ResumeMetadataRefresher + real TmuxAdapter + real SeatDeliveryGuard over a fixture DB; only the
// tmux executor is faked, as a tiny in-memory tmux server. No real tmux is touched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";

/** A minimal tmux: sessions with one pane each; pane ids count up from `firstPane` like a fresh server. */
class FakeTmux {
  sessions = new Map<string, { id: string; pane: string; created: number }>();
  commands: string[] = [];
  listPanesFails = false;
  onCommand?: (command: string) => void;
  private nextPane: number;
  private nextSession = 1;
  private clock = 1_790_000_000;
  constructor(private firstPane = 0) { this.nextPane = firstPane; }

  /** The server dies and a new one starts: no sessions, ids and pane ids count from the start again. */
  resetServer(): void { this.sessions.clear(); this.nextSession = 1; this.nextPane = this.firstPane; }

  /** Another client creates an unrelated session. */
  create(name: string): void {
    this.sessions.set(name, { id: `$${this.nextSession++}`, pane: `%${this.nextPane++}`, created: this.clock++ });
  }

  exec = async (command: string): Promise<string> => {
    this.commands.push(command);
    this.onCommand?.(command);
    // Native list-panes uses an exact session/window target (=name:), while
    // has-session uses =name; immutable tmux ids retain their literal spelling.
    const target = /-t '([^']+)'/.exec(command)?.[1]?.replace(/^=/, "").replace(/:.*$/, "");
    const byTarget = () => [...this.sessions.entries()].find(([name, s]) => name === target || s.pane === target || s.id === target);
    if (command.startsWith("tmux new-session")) {
      const name = /-s '([^']+)'/.exec(command)![1]!;
      if (this.sessions.has(name)) throw new Error(`duplicate session: ${name}`);
      this.create(name);
      const made = this.sessions.get(name)!;
      if (!command.includes(" -P")) return "";
      return command.includes("session_created") ? `${made.id} ${made.created}\n` : `${made.id}\n`;
    }
    if (command.startsWith("tmux list-panes")) {
      if (this.listPanesFails) throw new Error("list-panes: transient failure");
      const found = byTarget();
      if (!found) throw new Error(`can't find session: ${target}`);
      return `${found[1].pane}|0|/tmp|80|24|1\n`;
    }
    if (command.startsWith("tmux display-message") && command.includes("session_id")) return `${byTarget()?.[1].id ?? ""}\n`;
    if (command.startsWith("tmux display-message") && command.includes("pane_current_command")) return byTarget() ? "zsh\n" : "";
    if (command.startsWith("tmux capture-pane")) return byTarget() ? "user@host ~ % \n" : "";
    if (command.startsWith("tmux if-shell -F")) {
      // Real tmux expands the format against the target session, then runs one branch in the same command.
      const found = byTarget();
      if (!found) throw new Error(`can't find session: ${target}`);
      const wantName = /#\{==:#\{session_name\},([^}]+)\}/.exec(command)?.[1];
      const wantCreated = /#\{==:#\{session_created\},(\d+)\}/.exec(command)?.[1];
      if (found[0] === wantName && String(found[1].created) === wantCreated) { this.sessions.delete(found[0]); return ""; }
      return "kept\n";
    }
    if (command.startsWith("tmux kill-session")) {
      const found = byTarget();
      if (!found) throw new Error(`can't find session: ${target}`);
      this.sessions.delete(found[0]);
      return "";
    }
    return "";
  };

  /** Kill `name` and start a different session under the same name (new id and pane). */
  replace(name: string): void {
    this.sessions.delete(name);
    this.create(name);
  }

  probes(): string[] { return [...this.sessions.keys()].filter((name) => name.startsWith("rigged-refresh-")); }
}

const fileOps: TmuxFileOps = {
  writeFile: async () => {}, unlink: async () => {},
  tmpName: () => "/nonexistent/openrig-test-buffer", bufferName: () => "openrig-test-buffer",
};

describe("#188 snapshot refresh probe cleanup", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  /** A Claude seat with a resume token, as `rig down` hands it to the refresher. */
  function claudeSeat(pane: string | null) {
    const rig = rigRepo.createRig("first-project-claude");
    const node = rigRepo.addNode(rig.id, "dev.check", { role: "checker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-check@first-project-claude");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-check@first-project-claude", ...(pane ? { tmuxPane: pane } : {}) });
    return { sessionId: session.id, sessionName: "dev-check@first-project-claude", runtime: "claude-code", resumeType: "claude_id", resumeToken: "tok-1", cwd: "/tmp" };
  }

  function refresher(tmux: FakeTmux) {
    const adapter = new TmuxAdapter(tmux.exec, fileOps);
    adapter.deliveryGuard = new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target));
    return new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter: adapter, sleep: async () => {}, homeDir: "/tmp" });
  }

  it("control: a probe whose pane is its own is killed after the probe", async () => {
    const tmux = new FakeTmux(40);
    const seat = claudeSeat("%7");
    await refresher(tmux).refresh([seat]);

    expect(tmux.commands.some((c) => c.startsWith("tmux new-session") && c.includes("rigged-refresh-"))).toBe(true);
    expect(tmux.probes()).toEqual([]);
  });

  it("a fresh server reuses a stale seat binding's pane id: the probe must still be removed", async () => {
    // The seats' tmux server died; the rig records (and the binding's pane id %1) persisted. The new
    // server numbers panes from %0 again, so the probe's own pane can carry the stale binding's id.
    const tmux = new FakeTmux(1);
    const seat = claudeSeat("%1");
    await refresher(tmux).refresh([seat]);

    expect(tmux.probes()).toEqual([]);
  });

  it("negative control: a managed record that claims the probe's pane mid-probe is never killed, and refresh does not throw", async () => {
    const tmux = new FakeTmux(40);
    const seat = claudeSeat("%7");
    tmux.onCommand = (command) => {
      if (!command.startsWith("tmux send-keys")) return;
      const [name, probe] = [...tmux.sessions.entries()].find(([n]) => n.startsWith("rigged-refresh-"))!;
      const rig = rigRepo.createRig("adopter");
      const node = rigRepo.addNode(rig.id, "dev.adopted", { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: probe.pane });
    };
    await expect(refresher(tmux).refresh([seat])).resolves.toBeUndefined();

    expect(tmux.probes()).toHaveLength(1);
    expect(tmux.commands.some((c) => c.startsWith("tmux kill-session"))).toBe(false);
  });

  it("negative control: a record naming only the probe's pane mid-probe refuses the kill as a result; refresh does not throw", async () => {
    const tmux = new FakeTmux(40);
    const seat = claudeSeat("%7");
    tmux.onCommand = (command) => {
      if (!command.startsWith("tmux send-keys")) return;
      const probe = [...tmux.sessions.values()].find((_, i) => [...tmux.sessions.keys()][i]!.startsWith("rigged-refresh-"))!;
      const rig = rigRepo.createRig("stale-writer");
      const node = rigRepo.addNode(rig.id, "dev.stale", { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-stale@stale-writer", tmuxPane: probe.pane });
    };
    await expect(refresher(tmux).refresh([seat])).resolves.toBeUndefined();

    expect(tmux.probes()).toHaveLength(1);
    expect(tmux.commands.some((c) => c.startsWith("tmux kill-session"))).toBe(false);
  });

  it("negative control: a probe whose pane changed is never killed, and refresh does not throw", async () => {
    const tmux = new FakeTmux(40);
    const seat = claudeSeat("%7");
    tmux.onCommand = (command) => {
      if (!command.startsWith("tmux send-keys")) return;
      const probe = [...tmux.sessions.entries()].find(([n]) => n.startsWith("rigged-refresh-"))![1];
      probe.pane = "%99";
    };
    await expect(refresher(tmux).refresh([seat])).resolves.toBeUndefined();

    expect(tmux.probes()).toHaveLength(1);
    expect(tmux.commands.some((c) => c.startsWith("tmux kill-session"))).toBe(false);
  });

  it("rollback control (a): a probe adopted by a managed record while its pane is observed is never killed", async () => {
    const tmux = new FakeTmux(40);
    const seat = claudeSeat("%7");
    tmux.onCommand = (command) => {
      const name = /list-panes -t '=(rigged-refresh-[^':]+):'/.exec(command)?.[1];
      if (!name || tmux.sessions.get(name) === undefined) return;
      const rig = rigRepo.createRig("adopter");
      const node = rigRepo.addNode(rig.id, "dev.adopted", { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: tmux.sessions.get(name)!.pane });
    };
    await expect(refresher(tmux).refresh([seat])).resolves.toBeUndefined();

    expect(tmux.probes()).toHaveLength(1);
    expect(tmux.commands.some((c) => c.startsWith("tmux kill-session"))).toBe(false);
  });

  it("rollback control (b): a different session that took the probe's name before rollback is never killed", async () => {
    const tmux = new FakeTmux(40);
    tmux.listPanesFails = true;
    const seat = claudeSeat("%7");
    let replacement: { id: string; pane: string } | undefined;
    tmux.onCommand = (command) => {
      const name = /list-panes -t '=(rigged-refresh-[^':]+):'/.exec(command)?.[1];
      if (!name || replacement) return;
      tmux.replace(name);
      replacement = { ...tmux.sessions.get(name)! };
    };
    await expect(refresher(tmux).refresh([seat])).resolves.toBeUndefined();

    const [name] = tmux.probes();
    expect(name).toBeDefined();
    expect(tmux.sessions.get(name!)).toEqual(replacement);
  });

  it("rollback control (c): after a server reset, an unrelated session that reuses the saved id is never killed", async () => {
    const tmux = new FakeTmux(40);
    tmux.listPanesFails = true;
    const seat = claudeSeat("%7");
    tmux.onCommand = (command) => {
      if (!/list-panes -t '=rigged-refresh-/.test(command) || tmux.sessions.has("unrelated")) return;
      tmux.resetServer();
      tmux.create("unrelated"); // the new server hands out the helper's id again
    };
    await expect(refresher(tmux).refresh([seat])).resolves.toBeUndefined();

    expect(tmux.sessions.get("unrelated")?.id).toBe("$1");
  });

  it("allocation that cannot prove its pane is still removed (failure before the probe's try)", async () => {
    const tmux = new FakeTmux(40);
    tmux.listPanesFails = true;
    const seat = claudeSeat("%7");
    await refresher(tmux).refresh([seat]);

    expect(tmux.probes()).toEqual([]);
    // The rollback targets the id the create returned, and tmux checks the name and creation time in the
    // same command; it never kills by name.
    expect(tmux.commands.filter((c) => c.startsWith("tmux kill-session"))).toEqual([]);
    expect(tmux.commands.filter((c) => c.startsWith("tmux if-shell"))).toEqual([
      expect.stringMatching(/^tmux if-shell -F -t '\$\d+' '#\{&&:#\{==:#\{session_name\},rigged-refresh-[^}]+\},#\{==:#\{session_created\},\d+\}\}'/),
    ]);
  });
});
