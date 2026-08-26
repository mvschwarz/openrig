import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { sendCommand, type SendDeps } from "../src/commands/send.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

// Channel-separated capture: proves WHICH stream a line went to. captureLogs
// merges stdout+stderr, so it cannot show that the --json envelope lands on
// stdout while the human prose lands on stderr (and neither leaks to the other).
function captureChannels(
  fn: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ stdout, stderr, exitCode });
  });
}

function runningDeps(port: number, clientFactory?: StatusDeps["clientFactory"]): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: clientFactory ?? ((baseUrl) => new DaemonClient(baseUrl)),
  };
}

describe("Send CLI", () => {
  let server: http.Server;
  let port: number;
  let lastSendBody: Record<string, unknown> | null = null;
  let lastBroadcastBody: Record<string, unknown> | null = null;
  // S3 (OPR.0.5.4.6): every /send body in order, so the no-double-delivery
  // proof can count plain-text sends vs submit-path requests.
  let sendBodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && url === "/api/transport/broadcast") {
          const parsed = JSON.parse(body);
          lastBroadcastBody = parsed;
          const sessions: string[] = (parsed.sessions as string[] | undefined)
            ?? ["seat-a@my-rig", "seat-b@my-rig"]; // pod/rig/global resolve to a fixed pair
          if (parsed.text === "partial") {
            const results = [
              { ok: true, sessionName: sessions[0] },
              { ok: false, sessionName: sessions[1], error: "target needs input" },
            ];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ total: 2, sent: 1, failed: 1, results }));
            return;
          }
          const results = sessions.map((s) => ({ ok: true, sessionName: s }));
          res.writeHead(200, { "Content-Type": "application/json" });
          // S2 (OPR.0.5.4.3): an unattributed fan-out's response carries the
          // sign-it notice; the stub returns it when triggered so renderer
          // tests can assert it is SURFACED, not dropped.
          const warning = parsed.text === "warn-notice"
            ? "Delivered without sender identity: your recipient has no way of knowing who sent this. Follow up and sign it."
            : undefined;
          res.end(JSON.stringify({ total: results.length, sent: results.length, failed: 0, results, ...(warning ? { warning } : {}) }));
          return;
        }
        if (req.method === "POST" && url === "/api/transport/capture") {
          // S3 (OPR.0.5.4.6) fixtures: the pane EFFECT is the only truth about
          // consumption. staged-session leaves the sent text AT the prompt;
          // consumed-session shows it left the input box.
          const parsed = JSON.parse(body);
          const panes: Record<string, string> = {
            "staged-session": "❯ hello there\n  ⏵⏵ accept edits on (shift+tab to cycle)",
            "consumed-session": "· processing: hello there\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionName: parsed.session, content: panes[parsed.session as string] ?? "❯ " }));
          return;
        }
        if (req.method === "POST" && url === "/api/transport/send") {
          const parsed = JSON.parse(body);
          lastSendBody = parsed;
          sendBodies.push(parsed);
          if (parsed.session === "staged-session" || parsed.session === "consumed-session") {
            // S3 RED fixture: the TRANSPORT believes it delivered (its verify
            // is measured-unreliable in exactly this direction) — the staged
            // truth is visible only by pane effect.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: parsed.session, verified: true, outcome: "delivered" }));
            return;
          }
          if (parsed.session === "dev-impl@my-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "dev-impl@my-rig" }));
          } else if (parsed.session === "verified-session") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "verified-session", verified: true, outcome: "delivered" }));
          } else if (parsed.session === "racy-session") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "racy-session", verified: false, outcome: "rendered-unconfirmed" }));
          } else if (parsed.session === "dead-session") {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, sessionName: "dead-session", reason: "submit_failed", outcome: "failed", error: "Text is visible in 'dead-session' but was not submitted (Enter failed)." }));
          } else if (parsed.session === "busy-session") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, sessionName: "busy-session", reason: "mid_work", error: "Target pane appears mid-task. Use force: true to send anyway." }));
          } else if (parsed.session === "unknown-advisory") {
            // OPR.0.4.3.28 — unknown telemetry now PROCEEDS with a non-blocking advisory (warning).
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "unknown-advisory", warning: "producer-link: daemon-ingest link DOWN — activity could not be determined (no_activity_signal); sent anyway (telemetry is advisory)." }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "not found" }));
          }
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(deps: StatusDeps = runningDeps(port)): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(sendCommand(deps));
    return prog;
  }

  beforeEach(() => {
    lastSendBody = null;
    lastBroadcastBody = null;
    sendBodies = [];
    // P18: establish a RESOLVED seat for every test so dispatch renders the real sender; the
    // deliver-and-label test overrides it to empty to exercise the `<unknown sender>` fall-open.
    // (Hermetic-gate default is env-UNSET, so without this env-less delivery would render the unknown
    // marker.) Nested describes that stub their own envs re-run after this; the block afterEach restores.
    vi.stubEnv("OPENRIG_SESSION_NAME", "sender@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("send prints success output", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
  });

  // P18 DELIVER-AND-LABEL (deletion atom): an env-less send — no --from (deprecated + ignored) AND no
  // resolvable OPENRIG_SESSION_NAME/RIGGED_SESSION_NAME — now DELIVERS, carrying an HONEST `<unknown sender>`
  // label rather than refusing. The reset's north star: deleting a refusal must not manufacture a laundering
  // path, so an unattributable send is DISPATCHED with a truthful marker and a NULL actorSession — never a
  // forged actor. This REVERSES A1's seat-boundary refusal; the daemon half already delivers-and-labels the
  // header-absent write (no downstream 401), so the marker reaches the pane instead of being refused.
  it("P18: an env-less send DELIVERS with an honest `<unknown sender>` label — dispatched, actorSession null", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", ""); // override the block seat-stub → unresolvable
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(exitCode).toBeFalsy(); // DELIVERED, not refused
    expect(lastSendBody).not.toBeNull(); // dispatch reached the wire
    // Honest label on the rendered envelope; NO forged actor identity on the record.
    expect((lastSendBody as Record<string, unknown>).text).toContain("From: <unknown sender>");
    expect((lastSendBody as Record<string, unknown>).actorSession).toBeNull();
  });

  it("P18: a resolvable seat SENDS with its attributed identity — actorSession derived from the seat env, never forged", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "driver@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(exitCode).toBeFalsy(); // sent (not refused)
    expect(lastSendBody).not.toBeNull(); // dispatch reached the wire
    expect((lastSendBody as Record<string, unknown>)["actorSession"]).toBe("driver@my-rig");
  });

  // P18 CANONICITY GUARD (rework of the A1 negative control). Two intents, split so the one that still
  // holds cannot ride on the one that no longer does:
  //   SURVIVES — NO SCATTERED FALLBACKS: the `<unknown sender>` literal is DEFINED only at its legitimate
  //     twin sites; a THIRD definition ANYWHERE in src is exactly the drift a lockstep comment cannot catch.
  //   DIES — "exactly ONCE because A1 deleted the CLI fallbacks": P18 (deletion atom) REVERSES A1. An
  //     env-less send now DELIVERS carrying the honest `<unknown sender>` marker (the daemon half delivers-
  //     and-labels the header-absent write), so the CLI RE-GAINS a SINGLE origin — sender-identity.ts,
  //     IMPORTED by send.ts + broadcast.ts (never re-declared). The literal now lives at EXACTLY TWO
  //     byte-identical twin sites: the CLI envelope origin and the daemon's pane-envelope.ts.
  // Asserted as EXACT SET MEMBERSHIP with BOTH twins NAMED — NOT a count/upper bound. A 3rd file fails BY
  // NAME (the offender is printed), and a MISSING twin fails too. cwd-INDEPENDENT: repoRoot is derived from
  // THIS file's own location (walk up to the packages root), never process.cwd() — so the guard is correct
  // whether vitest runs from packages/cli or the repo root.
  it("P18 canonicity: '<unknown sender>' is DEFINED at EXACTLY the two named twin sites — a third fails BY NAME", () => {
    const findRepoRoot = (start: string): string => {
      let dir = start;
      for (let i = 0; i < 25; i++) {
        if (
          fs.existsSync(path.join(dir, "packages", "cli", "src")) &&
          fs.existsSync(path.join(dir, "packages", "daemon", "src"))
        ) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      throw new Error(`repo root (with packages/cli/src + packages/daemon/src) not found upward from ${start}`);
    };
    const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    const packagesDir = path.join(repoRoot, "packages");
    const LITERAL = '"<unknown sender>"'; // the double-quoted string-literal token (a definition, not prose)

    // The two legitimate twin definition sites, NAMED (byte-identical envelope twins):
    const EXPECTED_TWINS = [
      "packages/cli/src/sender-identity.ts",       // the SOLE CLI origin — send.ts + broadcast.ts IMPORT it
      "packages/daemon/src/lib/pane-envelope.ts",  // the daemon origin — wrapPaneEnvelope + non-refusable nudge
    ].sort();

    const srcFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && full.includes(`${path.sep}src${path.sep}`)) {
          srcFiles.push(full);
        }
      }
    };
    for (const pkg of fs.readdirSync(packagesDir)) {
      const srcDir = path.join(packagesDir, pkg, "src");
      if (fs.existsSync(srcDir)) walk(srcDir);
    }

    const hits: string[] = [];
    for (const file of srcFiles) {
      const rel = path.relative(repoRoot, file).split(path.sep).join("/"); // normalized, forward-slash
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // Skip comment lines (line comments, JSDoc/block-comment bodies) — prose mentions don't count.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (line.includes(LITERAL)) hits.push(`${rel}:${i + 1}`);
      });
    }

    // (1) EXACT SET of files that DEFINE the literal — a 3rd file (or a missing twin) fails BY NAME.
    const filesWithDef = [...new Set(hits.map((h) => h.slice(0, h.lastIndexOf(":"))))].sort();
    expect(
      filesWithDef,
      `expected '<unknown sender>' DEFINED at EXACTLY: ${EXPECTED_TWINS.join(", ")} — found definitions: ${hits.join(", ") || "(none)"}`,
    ).toEqual(EXPECTED_TWINS);

    // (2) exactly ONE definition PER TWIN (not two literals hiding in one named file).
    for (const twin of EXPECTED_TWINS) {
      const perTwin = hits.filter((h) => h.startsWith(`${twin}:`));
      expect(perTwin.length, `expected exactly ONE definition in ${twin}, found ${perTwin.length}: ${perTwin.join(", ")}`).toBe(1);
    }
  });

  it("send with 409 mid-work prints error and exits non-zero", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "busy-session", "hello"]);
    });
    expect(logs.join("\n")).toContain("mid-task");
    expect(exitCode).toBe(1);
  });

  // OPR.0.4.3.28 correction — an unknown-telemetry send PROCEEDS and PRINTS the advisory on
  // human output (not only in --json).
  it("prints the Advisory on an unknown-proceed send (human output)", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "unknown-advisory", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Sent to unknown-advisory");
    expect(output).toContain("Advisory:");
    expect(output).toContain("daemon-ingest link DOWN");
    expect(exitCode).toBeUndefined();
  });

  it("carries the advisory as `warning` in --json output", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "unknown-advisory", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.warning).toContain("daemon-ingest link DOWN");
  });

  // OPR.99.0.6.3 — honest delivery-outcome vocabulary; legacy Verified: line preserved.
  it("verify confirmed prints Delivery: delivered AND the legacy Verified: yes", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "verified-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Sent to verified-session");
    expect(output).toContain("Verified: yes");
    expect(output).toContain("Delivery: delivered");
  });

  it("verify redraw-race prints Delivery: rendered-unconfirmed (landed, with capture guidance) AND legacy Verified: no", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "racy-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Sent to racy-session");
    expect(output).toContain("Verified: no");
    expect(output).toContain("Delivery: rendered-unconfirmed");
    expect(output).toContain("landed");
    expect(output).toContain("rig capture racy-session");
    // The middle is NOT dressed as failure: exit stays clean.
    expect(exitCode).toBeUndefined();
  });

  it("verify genuine transport failure stays an error path, distinct from the middle (discriminator)", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dead-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    // HTTP 502 -> error branch; no success lines, exit non-zero.
    expect(output).not.toContain("Sent to dead-session");
    expect(output).not.toContain("Delivery: rendered-unconfirmed");
    expect(output).toContain("not submitted");
    expect(exitCode).toBe(2);
  });

  it("verify --json passes the additive outcome field through", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "racy-session", "hello", "--verify", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.verified).toBe(false);
    expect(parsed.outcome).toBe("rendered-unconfirmed");
  });

  it("send --json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionName).toBe("dev-impl@my-rig");
  });

  it("send --wait-for-idle posts waitForIdleMs and extends request timeout", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    const { logs } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(postFn).toHaveBeenCalledWith(
      "/api/transport/send",
      expect.objectContaining({
        session: "dev-impl@my-rig",
        text: expect.stringContaining("hello"),
        waitForIdleMs: 30000,
      }),
      { timeoutMs: 35000 },
    );
    const sentText = postFn.mock.calls[0]?.[1] as { text: string } | undefined;
    expect(sentText?.text).toContain("To: dev-impl@my-rig");
    expect(sentText?.text).toContain("---\nhello\n---");
    expect(sentText?.text).toContain('↩ Reply: rig send');
  });

  it("send without wait-for-idle uses default client timeout path", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(postFn.mock.calls[0]?.[2]).toBeUndefined();
  });

  // Slice-03 Atom 6b — --context delivery flag.
  it("send --context resolves a ref to its whole content and sends it (single-seat local)", async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const gets: string[] = [];
    const client = {
      get: async (path: string) => { gets.push(path); return { status: 200, data: { ref: "packs/brief", text: "BRIEF-CONTENT", bytes: 13, missingFiles: [] } }; },
      post: async (path: string, body: unknown) => { posts.push({ path, body: body as Record<string, unknown> }); return { status: 200, data: { ok: true, sessionName: "dev@rig" } }; },
    } as unknown as DaemonClient;
    const { exitCode } = await captureChannels(async () => {
      await makeCmd(runningDeps(port, () => client)).parseAsync(["node", "rig", "send", "dev@rig", "--context", "packs/brief", "--raw"]);
    });
    expect(exitCode).toBeUndefined();
    expect(gets.some((g) => g.includes("/api/context-packs/library/by-ref/pieces?ref=") && g.includes(encodeURIComponent("packs/brief")))).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body["session"]).toBe("dev@rig");
    expect(posts[0]!.body["text"]).toBe("BRIEF-CONTENT"); // --raw → no From/To envelope
  });

  it("send --context ABORTS (no send) when the pack has a missing/unreadable member", async () => {
    const posts: unknown[] = [];
    const client = {
      get: async () => ({ status: 200, data: { ref: "packs/broken", text: "X", bytes: 1, missingFiles: [{ path: "gone.md" }] } }),
      post: async (_p: string, b: unknown) => { posts.push(b); return { status: 200, data: {} }; },
    } as unknown as DaemonClient;
    const { stderr, exitCode } = await captureChannels(async () => {
      await makeCmd(runningDeps(port, () => client)).parseAsync(["node", "rig", "send", "dev@rig", "--context", "packs/broken", "--raw"]);
    });
    expect(exitCode).toBe(1);
    expect(posts).toEqual([]); // no partial context ever sent
    expect(stderr.join("\n")).toMatch(/gone\.md/);
  });

  it("send rejects invalid wait-for-idle values before contacting daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "0"]);
    });
    expect(logs.join("\n")).toContain("positive number");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send rejects wait-for-idle with force before contacting daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--force"]);
    });
    expect(logs.join("\n")).toContain("cannot be combined");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  // OPR.0.4.1.10 — --raw sends exact text with NO messaging envelope (still guarded server-side).
  it("send --raw posts the exact text without the From/To envelope", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "/compact", "--raw"]);
    });
    expect(lastSendBody?.text).toBe("/compact");
    expect(String(lastSendBody?.text)).not.toContain("To: dev-impl@my-rig");
    expect(String(lastSendBody?.text)).not.toContain("↩ Reply");
  });

  it("default send (no --raw) wraps the From/To messaging envelope", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
    expect(String(lastSendBody?.text)).toContain("---\nhello\n---");
  });

  // P21 I4 (specimen-5 security fix, REVERSES ba41fea2): --from is DEPRECATED + IGNORED. The rendered
  // From: and the actorSession DERIVE from the transport identity ($OPENRIG_SESSION_NAME, stamped as
  // X-OpenRig-Session), NEVER a caller-supplied --from string (the forgeable "From: pm-lead" surface the
  // live incident acted upon). A forged --from must not appear anywhere in the outbound envelope.
  it("send --from <origin> is IGNORED — From:/actor derive from the ambient transport identity, not --from", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    try {
      await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--from", "orch-lead@rig-a"]);
      });
      expect(String(lastSendBody?.text)).toContain("From: seat@my-rig");
      expect(String(lastSendBody?.text)).not.toContain("orch-lead@rig-a"); // the forged origin never renders
      expect(lastSendBody?.actorSession).toBe("seat@my-rig");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("send --dangerously-interact --reason posts the override fields with raw (exact) text", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact", "--reason", "unblock stuck prompt"]);
    });
    expect(lastSendBody?.dangerouslyInteract).toBe(true);
    expect(lastSendBody?.reason).toBe("unblock stuck prompt");
    expect(lastSendBody?.text).toBe("1"); // implies --raw: no envelope
    expect("actorSession" in (lastSendBody ?? {})).toBe(true);
  });

  it("send --dangerously-interact without --reason is rejected before contacting the daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact"]);
    });
    expect(logs.join("\n")).toContain("requires --reason");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send --dangerously-interact + --wait-for-idle is rejected before contacting the daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact", "--reason", "x", "--wait-for-idle", "30"]);
    });
    expect(logs.join("\n")).toContain("cannot be combined with --wait-for-idle");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  // OPR.0.4.1.10 — cross-host argv must forward the new flags so the remote rig applies the same guard.
  it("send --host forwards --raw/--dangerously-interact/--reason in the reconstructed remote argv", async () => {
    let captured: readonly string[] | null = null;
    const deps: SendDeps = {
      ...runningDeps(port),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-test", transport: "ssh", target: "vm.local" }] } }),
      crossHostRun: async (_host, argv) => { captured = argv; return { ok: true, stdout: "remote ok", stderr: "" }; },
    };
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--host", "vm-test", "--raw", "--dangerously-interact", "--reason", "why now"]);
    });
    expect(captured).not.toBeNull();
    const argv = captured as unknown as string[];
    expect(argv).toContain("--raw");
    expect(argv).toContain("--dangerously-interact");
    const ri = argv.indexOf("--reason");
    expect(ri).toBeGreaterThan(-1);
    expect(argv[ri + 1]).toBe("why now");
  });

  // Slice-03 Atom 6b QA fix — the agent@rig@host SUGAR host folds in AFTER the
  // early --context guard, so --context must be re-rejected after the fold: it
  // must NEVER reach the cross-host argv (which would ship literal null with no
  // message, or silently drop the context with one). Both forms pinned.
  it("send --context rejects the agent@rig@host sugar cross-host form (NO message) — never reaches remote argv", async () => {
    let captured: readonly string[] | null = null;
    const deps: SendDeps = {
      ...runningDeps(port),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-test", transport: "ssh", target: "vm.local" }] } }),
      crossHostRun: async (_host, argv) => { captured = argv; return { ok: true, stdout: "", stderr: "" }; },
    };
    const { stderr, exitCode } = await captureChannels(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig@vm-test", "--context", "packs/x"]);
    });
    expect(exitCode).toBe(1);
    expect(captured).toBeNull(); // never reached cross-host → no null shipped
    expect(stderr.join("\n")).toMatch(/--host|agent@rig@host/);
  });

  it("send --context rejects the sugar cross-host form (WITH message) — context not silently dropped", async () => {
    let captured: readonly string[] | null = null;
    const deps: SendDeps = {
      ...runningDeps(port),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-test", transport: "ssh", target: "vm.local" }] } }),
      crossHostRun: async (_host, argv) => { captured = argv; return { ok: true, stdout: "", stderr: "" }; },
    };
    const { exitCode } = await captureChannels(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig@vm-test", "msg", "--context", "packs/x"]);
    });
    expect(exitCode).toBe(1);
    expect(captured).toBeNull(); // rejected before cross-host → context never dropped
  });

  // OPR.0.4.3.30 — `rig send` fan-out targeting (--to / --pod / --rig).
  it("send --to a,b fans out to /broadcast with a sessions list and prints per-recipient summary", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hello team"]);
    });
    expect(lastSendBody).toBeNull(); // NOT the single-seat path
    expect(lastBroadcastBody?.sessions).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    expect(lastBroadcastBody?.text).toBe("hello team"); // bare — daemon wraps per recipient
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig: sent");
    expect(output).toContain("dev-qa@my-rig: sent");
    expect(output).toContain("2/2 delivered");
    expect(exitCode).toBeUndefined();
  });

  it("send --to accepts repetition (--to a --to b) and sets the daemon-side envelopeSender", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "--to", "dev-qa@my-rig", "hi"]);
    });
    expect(lastBroadcastBody?.sessions).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    // Non-raw fan-out: the daemon wraps per recipient, so the CLI passes a sender + BARE text.
    expect(typeof lastBroadcastBody?.envelopeSender).toBe("string");
    expect(String(lastBroadcastBody?.text)).not.toContain("To:");
  });

  it("send --pod posts a pod target to /broadcast", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--pod", "dev", "pod message"]);
    });
    expect(lastBroadcastBody?.pod).toBe("dev");
    expect(lastBroadcastBody?.text).toBe("pod message");
    expect(logs.join("\n")).toContain("2/2 delivered");
  });

  it("send --rig posts a rig target to /broadcast", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--rig", "my-rig", "rig message"]);
    });
    expect(lastBroadcastBody?.rig).toBe("my-rig");
    expect(logs.join("\n")).toContain("2/2 delivered");
  });

  it("fan-out with one recipient failing prints which failed, the summary, and exits nonzero", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "seat-a@my-rig,seat-b@my-rig", "partial"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("seat-a@my-rig: sent");
    expect(output).toContain("seat-b@my-rig: FAILED — target needs input");
    expect(output).toContain("1/2 delivered");
    expect(exitCode).toBe(1);
  });

  // ── S3 (OPR.0.5.4.6) — delivery honesty: "sent" must mean CONSUMED, never
  // merely typed. RED-first proof assets at proof-item altitude (the lock may
  // refine wording; the OUTCOMES asserted here are the locked contract):
  // staged-vs-consumed is discriminated by PANE EFFECT (the walk pattern
  // generalized), the staged report names its evidence, and the remedy is the
  // single submit path — never a blind re-send.
  describe("S3 — delivery honesty (OPR.0.5.4.6): staged-vs-consumed by pane effect", () => {
    it("PROOF-1: a send whose text sits AT the prompt is reported STAGED — by pane effect, not the transport's verified:true", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "staged-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      // RED at current bytes: the transport's false "delivered" is echoed as
      // "Verified: yes" and no staged report exists.
      expect(output).toMatch(/staged/i);
      expect(output).toMatch(/not (yet )?consumed|not submitted|still at the prompt/i);
    });

    it("PROOF-2: a genuinely consumed send verifies positively and is NEVER reported staged", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "consumed-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      expect(output).not.toMatch(/staged/i);
      expect(output).toContain("Verified: yes");
    });

    it("PROOF-3: the staged remedy is the single submit path — exactly one plain-text send, no blind re-send suggested or performed", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "staged-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      // exactly ONE plain-text delivery of these bytes ever hits the wire
      // (the non-raw send envelopes the payload, so match by containment; the
      // submit-path request carries NO text at all)
      const plainSends = sendBodies.filter((b) => !b["submitOnly"] && String(b["text"] ?? "").includes("hello there"));
      expect(plainSends).toHaveLength(1);
      const submits = sendBodies.filter((b) => b["submitOnly"]);
      expect(submits.length).toBeLessThanOrEqual(1); // one guarded Enter, never more
      for (const s of submits) expect(s["text"] ?? "").toBeFalsy(); // the submit path types nothing
      // the report points at the submit path, never a re-send
      expect(output).toMatch(/submit|Enter/i);
      expect(output).not.toMatch(/re-?send|send again/i);
    });
  });

  // S2 (OPR.0.5.4.3): the fan-out renderer must SURFACE an additive warning —
  // an env-less operator sees the notice, never "sent" lines alone.
  it("fan-out renderer surfaces the unknown-sender notice from the response warning", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "warn-notice"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig: sent");
    expect(output).toContain("Advisory:");
    expect(output).toMatch(/no way of knowing who sent/i);
    expect(output).toMatch(/sign/i);
  });

  it("fan-out --raw sends bare exact text with NO envelopeSender (no per-recipient wrap)", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "/compact", "--raw"]);
    });
    expect(lastBroadcastBody?.text).toBe("/compact");
    expect("envelopeSender" in (lastBroadcastBody ?? {})).toBe(false);
  });

  it("fan-out --dangerously-interact --reason plumbs the danger fields (bare text, no envelope)", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "1", "--dangerously-interact", "--reason", "drive stuck prompts"]);
    });
    expect(lastBroadcastBody?.dangerouslyInteract).toBe(true);
    expect(lastBroadcastBody?.reason).toBe("drive stuck prompts");
    expect(lastBroadcastBody?.text).toBe("1");
    expect("envelopeSender" in (lastBroadcastBody ?? {})).toBe(false);
  });

  it("rejects combining a bare seat with a fan-out flag", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--pod", "dev"]);
    });
    expect(logs.join("\n")).toContain("cannot be combined with --to/--pod/--rig");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
    expect(lastSendBody).toBeNull();
  });

  it("rejects more than one fan-out mode at once", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--pod", "dev", "--rig", "my-rig", "hello"]);
    });
    expect(logs.join("\n")).toContain("exactly ONE target");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
  });

  it("rejects --wait-for-idle with a multi/pod/rig target", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--rig", "my-rig", "hello", "--wait-for-idle", "30"]);
    });
    expect(logs.join("\n")).toContain("not supported with a multi/pod/rig target");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
  });

  it("single-seat send is UNCHANGED — still posts to /send, byte-identical envelope, no /broadcast", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(lastBroadcastBody).toBeNull();
    expect(lastSendBody?.session).toBe("dev-impl@my-rig");
    expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
  });

  it("send --help includes rediscovery examples + the new guard flags", () => {
    const cmd = sendCommand(runningDeps(port));
    const helpText = cmd.helpInformation();
    expect(helpText).toContain("--verify");
    expect(helpText).toContain("--force");
    expect(helpText).toContain("--wait-for-idle");
    expect(helpText).toContain("--raw");
    expect(helpText).toContain("--dangerously-interact");
    expect(helpText).toContain("pane only");
    expect(helpText).toContain("dev-impl@my-rig");
  });

  // OPR.0.4.3.28 B1 code-review fix — the help text must reflect the corrected
  // proceed-with-advisory behavior, NOT the obsolete fail-closed-on-unknown contract
  // (which would keep steering operators toward the deprecated --dangerously-interact bridge).
  // The narrative contract lives in addHelpText("after"), which helpInformation() omits —
  // capture the FULL `--help` render via configureOutput + exitOverride.
  it("send --help documents proceed-with-advisory on unknown telemetry, not fail-closed", () => {
    const cmd = sendCommand(runningDeps(port));
    let helpText = "";
    cmd.configureOutput({ writeOut: (s) => { helpText += s; }, writeErr: (s) => { helpText += s; } });
    cmd.exitOverride();
    try { cmd.parse(["node", "send", "--help"]); } catch { /* exitOverride throws on --help */ }
    expect(helpText.toLowerCase()).not.toContain("fails closed");
    expect(helpText).toContain("advisory");
    expect(helpText).toMatch(/PROCEEDS with an\s+advisory/); // \s+ tolerates the help line-wrap
    // The positive-picker refusal contract is still documented.
    expect(helpText.toLowerCase()).toContain("refused");
  });

  // -------------------------------------------------------------------------
  // qitem-c113bd41 — local-send honesty: the ACTUAL transport is
  // authoritative. Preflight (getDaemonStatus) may inform target fallback but
  // never refuses a send by itself: a busy/wedged daemon (probe timeout or
  // running/unhealthy) must still receive the POST/broadcast; a REAL down
  // fails honestly from the actual connection error, naming the target —
  // never the bare preflight restart line. Guard matrix: single + fan-out;
  // stopped + running/unhealthy; OPENRIG_URL/RIGGED_URL custom ports +
  // precedence; honest failure; cross-host untouched (pinned in the
  // cross-host suites).
  // -------------------------------------------------------------------------

  describe("qitem-c113bd41 — transport-authoritative local send (RED vs preflight refusal)", () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    /** lifecycleDeps whose PROBE always fails (instant, injected sleep) and
     *  which carries NO daemon state — the env-URL/stopped shape. */
    function probeFailNoStateDeps(clientFactory: StatusDeps["clientFactory"]): StatusDeps {
      return {
        lifecycleDeps: {
          ...mockLifecycleDeps(),
          exists: vi.fn(() => false),
          readFile: vi.fn(() => null),
          fetch: vi.fn(async () => { throw new Error("probe timed out"); }),
          sleep: async () => {},
        } as LifecycleDeps,
        clientFactory,
      };
    }

    /** ff13bcdf finding 2 — stub every daemon host/port alias empty so the
     *  configured-target discriminators read the config FILE, not whatever
     *  the surrounding managed seat happens to export. Paired with the
     *  block's afterEach(vi.unstubAllEnvs) for restore. */
    function scrubDaemonHostPortAliases(): void {
      vi.stubEnv("OPENRIG_HOST", "");
      vi.stubEnv("OPENRIG_PORT", "");
      vi.stubEnv("RIGGED_HOST", "");
      vi.stubEnv("RIGGED_PORT", "");
    }

    /** ff13bcdf finding 1 — deps whose lifecycle probe is COUNTABLE. The
     *  probe throws so any accidental call is also visibly useless work.  */
    function probeCountingDeps(clientFactory: StatusDeps["clientFactory"]): {
      deps: StatusDeps; probeCalls: () => number; probeUrls: () => string[];
    } {
      const fetchSpy = vi.fn(async (): Promise<{ ok: boolean }> => { throw new Error("probe should not be needed"); });
      return {
        deps: {
          lifecycleDeps: {
            ...mockLifecycleDeps(),
            exists: vi.fn(() => false),
            readFile: vi.fn(() => null),
            fetch: fetchSpy,
            sleep: async () => {},
          } as LifecycleDeps,
          clientFactory,
        },
        probeCalls: () => fetchSpy.mock.calls.length,
        // 51-09 incr-3 (R8 supersession): the URLs let R8 discriminate the ONE allowed
        // fetch as the self-id /healthz GET by path, not merely by count.
        probeUrls: () => fetchSpy.mock.calls.map((c) => String(c[0])),
      };
    }

    function recordingRealClient(): { factory: StatusDeps["clientFactory"]; seen: () => string | null } {
      let seenUrl: string | null = null;
      return {
        factory: (baseUrl: string) => { seenUrl = baseUrl; return new DaemonClient(baseUrl); },
        seen: () => seenUrl,
      };
    }

    it("R1 RED: single-seat + OPENRIG_URL custom port + probe-stopped -> actual POST lands, exact env target passed to clientFactory", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastSendBody = null;
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
    });

    it("R2 RED: fan-out --to + OPENRIG_URL + probe-stopped -> actual /broadcast lands with per-recipient results", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastBroadcastBody = null;
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team"]);
      });
      expect(lastBroadcastBody).not.toBeNull();
      expect(logs.join("\n")).toContain("dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
    });

    it("R3 RED: legacy RIGGED_URL custom port honored when OPENRIG_URL unset (probe-stopped)", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", `http://127.0.0.1:${port}`);
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
    });

    it("R4 RED: precedence — OPENRIG_URL wins over RIGGED_URL on the transport-authoritative path", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "http://127.0.0.1:59999");
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
    });

    it("R5 RED: RUNNING-but-UNHEALTHY (event-loop-starved healthz body) must still send (single-seat + fan-out)", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      const unhealthyProbeDeps = (clientFactory: StatusDeps["clientFactory"]): StatusDeps => ({
        lifecycleDeps: {
          ...mockLifecycleDeps(),
          fetch: vi.fn(async () => ({
            ok: true,
            json: async () => ({ eventLoop: { healthy: false, lagMeanMs: 9000, lagP99Ms: 9000, utilization: 1, lastTickAgeMs: 9000 } }),
          })),
          sleep: async () => {},
        } as LifecycleDeps,
        clientFactory,
      });
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(unhealthyProbeDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
      const rc2 = recordingRealClient();
      lastBroadcastBody = null;
      await captureLogs(async () => {
        await makeCmd(unhealthyProbeDeps(rc2.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi"]);
      });
      expect(lastBroadcastBody).not.toBeNull();
    });

    const rcHolder = { seenUrl: null as string | null, factory: ((baseUrl: string) => { rcHolder.seenUrl = baseUrl; return new DaemonClient(baseUrl); }) as StatusDeps["clientFactory"], seen: () => rcHolder.seenUrl };

    it("R6 RED: NO env + live-pid state file (custom port) + healthz probe failing -> POST attempted against the state-derived target", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", "");
      const deps: StatusDeps = {
        lifecycleDeps: {
          ...mockLifecycleDeps(),
          exists: vi.fn((p: string) => p === STATE_FILE),
          readFile: vi.fn((p: string) => p === STATE_FILE
            ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState)
            : null),
          fetch: vi.fn(async () => { throw new Error("healthz timed out"); }),
          sleep: async () => {},
          isProcessAlive: vi.fn(() => true),
        } as LifecycleDeps,
        clientFactory: rcHolder.factory,
      };
      const { logs } = await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
      expect(rcHolder.seen()).toBe(`http://127.0.0.1:${port}`);
    });

    it("R6b RED: NO env + NO daemon state + probe-stopped -> POST attempted against the configured DEFAULT target (injected client succeeds)", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", "");
      // ff13bcdf finding 2 — ConfigStore maps these aliases to
      // daemon.host/daemon.port with env winning over file (config-store.ts
      // :343,349). A managed seat carries ambient OPENRIG_PORT, so without
      // this scrub the test measures the AMBIENT ENVIRONMENT, not the
      // contract. Restored by the block's afterEach(vi.unstubAllEnvs).
      scrubDaemonHostPortAliases();
      // Config isolation without touching disk: a nonexistent home means no
      // daemon config, so the configured target resolves to the default.
      vi.stubEnv("OPENRIG_HOME", "/nonexistent/send-r6b-home");
      let seenUrl: string | null = null;
      const postFn = vi.fn(async () => ({ status: 200, data: { ok: true, sessionName: "dev-impl@my-rig" } }));
      const stubFactory = ((baseUrl: string) => { seenUrl = baseUrl; return { post: postFn } as unknown as DaemonClient; }) as StatusDeps["clientFactory"];
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(stubFactory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
      expect(seenUrl).toBe("http://127.0.0.1:7433");
      expect(postFn).toHaveBeenCalledTimes(1);
    });

    it("R6c RED: NO env + NO state + probe-stopped + ConfigStore CUSTOM daemon host/port -> POST attempted against the CONFIGURED-FILE target exactly (no hardcoded default)", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", "");
      // ff13bcdf finding 2 — without this scrub an ambient OPENRIG_PORT
      // (e.g. 7433 in a managed seat) overrides the config FILE's 7599 via
      // ConfigStore env-over-file precedence, and this test silently asserts
      // 127.0.0.9:7433 — the exact leak R2 observed.
      scrubDaemonHostPortAliases();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "send-r6c-home-"));
      try {
        fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ daemon: { host: "127.0.0.9", port: 7599 } }));
        vi.stubEnv("OPENRIG_HOME", home);
        let seenUrl: string | null = null;
        const postFn = vi.fn(async () => ({ status: 200, data: { ok: true, sessionName: "dev-impl@my-rig" } }));
        const stubFactory = ((baseUrl: string) => { seenUrl = baseUrl; return { post: postFn } as unknown as DaemonClient; }) as StatusDeps["clientFactory"];
        const { logs } = await captureLogs(async () => {
          await makeCmd(probeFailNoStateDeps(stubFactory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
        });
        expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
        // The configured file target, byte-exact — a literal-default fallback
        // (http://127.0.0.1:7433) is a contract violation here.
        expect(seenUrl).toBe("http://127.0.0.9:7599");
        expect(postFn).toHaveBeenCalledTimes(1);
      } finally {
        // Exception-safe: a failing assertion must not leave temp state.
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("R7 RED: REAL down fails honestly — actual connection error names the target; the bare preflight restart line never appears", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      const out = logs.join("\n");
      expect(exitCode).toBe(1);
      // The ACTUAL transport failure must be surfaced — the DaemonClient's
      // own connection-error prefix, naming the configured target — not a
      // preflight-derived guess. (Also covers 1b45cf21's explicit/custom
      // target-preservation pin: the resolved target survives verbatim into
      // the fact line rather than being flattened into a generic message.)
      expect(out).toContain("Cannot connect to the OpenRig daemon at http://127.0.0.1:1:");
      expect(out).not.toContain("Daemon not running. Start it with: rig daemon start");
      // 1b45cf21 — a real transport failure must also carry the repo's
      // fact/consequence/action remediation. The fact line above is the
      // actual cause; these are the consequence and the action.
      expect(out).toContain("The message was not sent.");
      expect(out).toContain("Inspect the configured target with 'rig status'; a failed health probe does not prove the daemon is stopped.");
      expect(out).toContain("If the target is wrong, check OPENRIG_URL / RIGGED_URL or daemon.host + daemon.port.");
      expect(out).toContain("If the daemon is confirmed stopped, run 'rig daemon start'.");
      // ABSENCE PIN: remediation must never assert daemon STATE derived from
      // the failed send or an advisory probe. A connection failure proves the
      // target was unreachable — not why.
      expect(out).not.toContain("Daemon not running");
      expect(out).not.toContain("unhealthy");
    });

    // HISTORY (ff13bcdf finding 3): this test entered the suite as a GREEN
    // characterization — the fan-out catch already behaved correctly, R7 just
    // never asserted it, so it pinned existing behavior with no manufactured
    // failure.
    // NOW (1b45cf21): it is a deliberate RED. This lane requires fan-out to
    // carry the same fact/consequence/action remediation as single-seat, which
    // does not exist yet, so the remediation assertions below fail by design
    // until the helper lands. Retitled accordingly — a test labelled
    // "characterization" while it is an intentional RED is exactly the kind of
    // stale label this slice keeps finding elsewhere.
    it("R7b RED: fan-out REAL down fails honestly too — target-specific connection error, exit 1, no restart line, and the same remediation as single-seat", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { logs, exitCode } = await captureLogs(async () => {
        // NOTE: with --to the FIRST positional IS the message (a bare seat
        // name alongside --to is rejected) — getting this wrong yields a
        // false RED rather than exercising the fan-out catch.
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "hello"]);
      });
      const out = logs.join("\n");
      expect(exitCode).toBe(1);
      expect(out).toContain("Cannot connect to the OpenRig daemon at http://127.0.0.1:1:");
      expect(out).not.toContain("Daemon not running. Start it with: rig daemon start");
      // 1b45cf21 — SYMMETRY PIN. Fan-out must carry byte-identical
      // remediation to single-seat; divergence between the two paths is the
      // regression this asserts against.
      expect(out).toContain("The message was not sent.");
      expect(out).toContain("Inspect the configured target with 'rig status'; a failed health probe does not prove the daemon is stopped.");
      expect(out).toContain("If the target is wrong, check OPENRIG_URL / RIGGED_URL or daemon.host + daemon.port.");
      expect(out).toContain("If the daemon is confirmed stopped, run 'rig daemon start'.");
      expect(out).not.toContain("Daemon not running");
      expect(out).not.toContain("unhealthy");
    });

    // send-json-error-envelope-gap follow-up: on the --json path a real
    // transport failure must hand the agent a PARSEABLE record, not empty
    // stdout + human prose on stderr. Mirrors printDaemonNotRunning's
    // {error:{fact,consequence,action}} envelope. Channel-separated so the
    // discriminator is unambiguous: stdout carries exactly one JSON record and
    // stderr is empty (and the human path is the mirror image).
    it("R7c RED: single-seat --json transport failure emits exactly one parseable stdout JSON envelope, empty stderr, exit 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--json"]);
      });
      expect(exitCode).toBe(1);
      // exactly one stdout record, parseable, exact structured envelope shape
      // (no top-level ok, no discrete target field — just error:{f,c,a}).
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toEqual({
        error: {
          fact: expect.stringContaining("Cannot connect to the OpenRig daemon at http://127.0.0.1:1:"),
          consequence: "The message was not sent.",
          action: expect.stringContaining("Inspect the configured target with 'rig status'; a failed health probe does not prove the daemon is stopped."),
        },
      });
      // the --json path must NOT leak human prose onto stderr
      expect(stderr).toEqual([]);
    });

    it("R7d RED: fan-out --json transport failure emits exactly one parseable stdout JSON envelope, empty stderr, exit 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        // with --to the FIRST positional IS the message (bare seat + --to is rejected)
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "hello", "--json"]);
      });
      expect(exitCode).toBe(1);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toEqual({
        error: {
          fact: expect.stringContaining("Cannot connect to the OpenRig daemon at http://127.0.0.1:1:"),
          consequence: "The message was not sent.",
          action: expect.stringContaining("Inspect the configured target with 'rig status'; a failed health probe does not prove the daemon is stopped."),
        },
      });
      expect(stderr).toEqual([]);
    });

    it("R7e: single-seat HUMAN transport failure keeps stdout empty (mirror of R7c) — the 3 remediation lines are stderr-only, exit 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]); // human path must never write to stdout
      const err = stderr.join("\n");
      expect(err).toContain("Cannot connect to the OpenRig daemon at http://127.0.0.1:1:");
      expect(err).toContain("The message was not sent.");
      expect(err).toContain("Inspect the configured target with 'rig status'; a failed health probe does not prove the daemon is stopped.");
    });

    it("R7f: fan-out HUMAN transport failure keeps stdout empty (mirror of R7d) — stderr-only remediation, exit 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "hello"]);
      });
      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      const err = stderr.join("\n");
      expect(err).toContain("Cannot connect to the OpenRig daemon at http://127.0.0.1:1:");
      expect(err).toContain("The message was not sent.");
    });

    // ff13bcdf finding 1 — the load-bearing latency discriminator. An
    // explicit URL alias ALREADY determines the target, so the advisory
    // probe is pure cost on the incident path (818ms failing / ~2.05s
    // timeout-shaped). A latency claim without a call-count assertion is
    // unfalsifiable, so these assert the probe count directly.
    // RED on this parent: getDaemonStatus takes the openrigUrl branch and
    // burns STATUS_PROBE_MAX_ATTEMPTS (5) fetches before the resolver reads
    // the same alias. The POST assertions pass today; ONLY the count fails.
    it("R8: explicit OPENRIG_URL (single-seat) -> exact target POSTed + EXACTLY ONE self-id /healthz GET, no status-probe burn", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastSendBody = null;
      const rc = recordingRealClient();
      const { deps, probeCalls, probeUrls } = probeCountingDeps(rc.factory);
      const { logs } = await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(lastSendBody).not.toBeNull();
      // SUPERSEDED 2026-08-06 (merge-desk sanction + the arch/planner 1-GET trade-off ruling,
      // 51-09 incr-3): ff13bcdf's zero-probe guarantee targeted the EXPENSIVE 5-attempt
      // STATUS-PROBE BURN, not a single bounded self-id read. A single-seat send now renders
      // the From: origin triple CLI-side, which needs the daemon self-id via ONE best-effort
      // loopback /healthz GET (rider-b one-source; C1 fail-open; CEILING = 1, NO retry —
      // fetchSelfHostId is a single fetchDaemonProbe that fails open to undefined). This pin
      // discriminates MECHANICALLY, so it STILL catches the burn it was born for AND catches a
      // SECOND self-id GET or a retry sneaking in:
      expect(probeCalls()).toBe(1); // ceiling: exactly ONE attempt — never the 5-attempt burn, never a retry
      expect(String(probeUrls()[0] ?? "")).toContain("/healthz"); // the one allowed call IS the self-id GET (path, not just count)
    });

    it("R8b RED: explicit OPENRIG_URL (fan-out) -> exact target broadcast and ZERO lifecycle probe calls", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastBroadcastBody = null;
      const rc = recordingRealClient();
      const { deps, probeCalls } = probeCountingDeps(rc.factory);
      await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team"]);
      });
      expect(lastBroadcastBody).not.toBeNull();
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(probeCalls()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // ba41fea2 — fan-out provenance. `--from` is a GLOBAL option and reaches the
  // action's opts, but runFanOutSend's local params type omits it, so the
  // fan-out path resolves AMBIENT identity and writes that into both
  // actorSession (audit attribution) and envelopeSender (what each recipient
  // sees). An explicit operator instruction is silently dropped — the sibling
  // paths (single-seat, cross-host ssh, cross-host http) all honor it.
  //
  // NOTE ON CLEANUP: these tests deliberately sit OUTSIDE the
  // qitem-c113bd41 describe block above, so its afterEach(vi.unstubAllEnvs)
  // does NOT cover them. Each test restores its own env in a local
  // try/finally — an un-restored vi.stubEnv would leak into every later test
  // in this file (the same ambient-env class ff13bcdf finding 2 fixed).
  // -------------------------------------------------------------------------
  describe("P21 I4 — fan-out IGNORES --from; identity derives from the transport (reverses ba41fea2)", () => {
    it("--from is IGNORED in fan-out — BOTH envelopeSender and actorSession name the ambient transport identity, never the forged --from origin", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      // Ambient identity is STUBBED, never inherited from the surrounding
      // managed seat — otherwise the discriminator would silently compare
      // against whatever the runner happens to export.
      vi.stubEnv("OPENRIG_SESSION_NAME", "ambient-relay@my-rig");
      vi.stubEnv("RIGGED_SESSION_NAME", "");
      try {
        lastBroadcastBody = null;
        await captureLogs(async () => {
          await makeCmd().parseAsync([
            "node", "rig", "send", "--from", "origin@my-rig",
            "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team",
          ]);
        });
        expect(lastBroadcastBody).not.toBeNull();
        // P21 I4: --from ("origin@my-rig") is the forgeable surface — it is IGNORED. Both attribution
        // fields resolve to the ambient transport identity; the daemon then re-derives them from the
        // X-OpenRig-Session header regardless, so a forged --from can never name the From:.
        expect(lastBroadcastBody?.actorSession).toBe("ambient-relay@my-rig");
        expect(lastBroadcastBody?.envelopeSender).toBe("ambient-relay@my-rig");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("F2 GREEN-characterization: with NO --from, fan-out still falls back to ambient identity (the flag is additive, not a behavior change)", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      vi.stubEnv("OPENRIG_SESSION_NAME", "ambient-relay@my-rig");
      vi.stubEnv("RIGGED_SESSION_NAME", "");
      try {
        lastBroadcastBody = null;
        await captureLogs(async () => {
          await makeCmd().parseAsync([
            "node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team",
          ]);
        });
        expect(lastBroadcastBody).not.toBeNull();
        expect(lastBroadcastBody?.actorSession).toBe("ambient-relay@my-rig");
        expect(lastBroadcastBody?.envelopeSender).toBe("ambient-relay@my-rig");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

});
