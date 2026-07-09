// OPR.0.4.6.MH1 FR-6 — rig host pair <url>: the founder-simple add path.
// One pasted address, one approval on the target, done — and the
// nothing-persists guarantee on every failure leg.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { hostCommand, type DoctorDeps } from "../src/commands/host.js";
import { addHostEntry } from "../src/host-registry.js";

describe("rig host pair (OPR.0.4.6.MH1 FR-6)", () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpair-"));
    savedHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = dir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENRIG_HOME;
    else process.env.OPENRIG_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function capture(fn: () => Promise<void>): Promise<{ out: string[]; err: string[]; exitCode: number | undefined }> {
    return new Promise(async (resolve) => {
      const out: string[] = []; const err: string[] = [];
      const ol = console.log; const oe = console.error; const oc = process.exitCode;
      process.exitCode = undefined;
      console.log = (...a: unknown[]) => out.push(a.join(" "));
      console.error = (...a: unknown[]) => err.push(a.join(" "));
      try { await fn(); } finally { console.log = ol; console.error = oe; }
      const exitCode = process.exitCode as number | undefined;
      process.exitCode = oc;
      resolve({ out, err, exitCode });
    });
  }

  function fakeDeps(opts: {
    post?: { status: number; body: unknown };
    poll: Array<{ status: number; body: unknown }>;
  }): DoctorDeps & { postCalls: () => number } {
    let polls = 0;
    let posts = 0;
    return {
      run: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }) as never,
      httpGet: async () => {
        const r = opts.poll[Math.min(polls, opts.poll.length - 1)]!;
        polls += 1;
        return { status: r.status, body: JSON.stringify(r.body) };
      },
      httpPost: async () => {
        posts += 1;
        const r = opts.post ?? { status: 200, body: { pairId: "p-1", code: "424242", approvalQitemId: "qitem-1" } };
        return { status: r.status, body: JSON.stringify(r.body) };
      },
      tcpProbe: async () => "open" as const,
      postCalls: () => posts,
    };
  }

  function run(deps: DoctorDeps, argv: string[]) {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand(deps));
    return prog.parseAsync(["node", "rig", "host", ...argv]);
  }

  it("approved walk: registry entry with bearer_file + a 0600 token file; code printed", async () => {
    const deps = fakeDeps({ poll: [{ status: 200, body: { status: "approved", token: "issued-bearer" } }] });
    const { out, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433", "--id", "vps-a", "--timeout", "10"]));
    expect(exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("Pairing code: 424242");
    expect(out.join("\n")).toContain("Paired. Host 'vps-a' registered");

    const tokenPath = path.join(dir, "secrets", "host-vps-a.token");
    expect(fs.readFileSync(tokenPath, "utf8")).toBe("issued-bearer\n");
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    const yaml = fs.readFileSync(path.join(dir, "hosts.yaml"), "utf8");
    expect(yaml).toContain("id: vps-a");
    expect(yaml).toContain(`bearer_file: ${tokenPath}`);
    expect(yaml).not.toContain("issued-bearer");
  }, 15_000);

  it("denied: loud error, exit 1, NOTHING persists", async () => {
    const deps = fakeDeps({ poll: [{ status: 200, body: { status: "denied" } }] });
    const { err, exitCode } = await capture(() => run(deps, ["pair", "http://vps-a:7433", "--timeout", "10"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("DENIED");
    expect(err.join("\n")).toContain("Nothing was persisted");
    expect(fs.existsSync(path.join(dir, "hosts.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "secrets"))).toBe(false);
  }, 15_000);

  it("a tokenless target's structured refusal is surfaced verbatim", async () => {
    const deps = fakeDeps({
      post: { status: 409, body: { error: "pair_target_no_bearer", message: "this daemon runs without OPENRIG_AUTH_BEARER_TOKEN; pairing has no credential to issue." } },
      poll: [],
    });
    const { err, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("OPENRIG_AUTH_BEARER_TOKEN");
    expect(fs.existsSync(path.join(dir, "hosts.yaml"))).toBe(false);
  });

  it("registry-write failure AFTER approval removes the token file THIS request created (preflight/add race leg)", async () => {
    // The preflight passes on an empty registry; a conflicting entry then
    // lands DURING the approval wait (the TOCTOU window preflight cannot
    // close — addHostEntry stays authoritative). The cleanup must remove
    // only the token file this request created, and the racing entry's
    // registry state must survive untouched.
    const deps = fakeDeps({ poll: [{ status: 200, body: { status: "approved", token: "issued-bearer" } }] });
    const origGet = deps.httpGet;
    let raced = false;
    deps.httpGet = async (url, headers) => {
      if (!raced) {
        raced = true;
        expect(addHostEntry({ id: "vps-a", transport: "http", url: "http://racer:7433", bearer_env: "RACER_TOKEN" }).ok).toBe(true);
      }
      return origGet(url, headers);
    };
    const { err, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433", "--id", "vps-a", "--timeout", "10"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("nothing persisted");
    const yaml = fs.readFileSync(path.join(dir, "hosts.yaml"), "utf8");
    expect(yaml).toContain("http://racer:7433");
    expect(yaml).not.toContain("issued-bearer");
    expect(fs.existsSync(path.join(dir, "secrets", "host-vps-a.token"))).toBe(false);
  }, 15_000);

  // B1 fixback (guard code-review 2026-07-07): failed pairs must never
  // clobber/delete pre-existing credential or registry state, and must
  // fail BEFORE the target is contacted.
  it("B1: duplicate-id re-pair fails at PREFLIGHT — registry bytes, token contents and 0600 mode preserved; target NEVER contacted", async () => {
    const secretsDir = path.join(dir, "secrets");
    const tokenPath = path.join(secretsDir, "host-vps-a.token");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, "live-credential\n", { mode: 0o600 });
    expect(addHostEntry({ id: "vps-a", transport: "http", url: "http://old-target:7433", bearer_file: tokenPath }).ok).toBe(true);
    const yamlBefore = fs.readFileSync(path.join(dir, "hosts.yaml"), "utf8");

    const deps = fakeDeps({ poll: [] });
    const { err, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433", "--id", "vps-a"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("duplicate host id");

    expect(deps.postCalls()).toBe(0);
    expect(fs.readFileSync(path.join(dir, "hosts.yaml"), "utf8")).toBe(yamlBefore);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe("live-credential\n");
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("B1: a pre-existing token file at the derived path rejects the pair before target contact — file untouched", async () => {
    const secretsDir = path.join(dir, "secrets");
    const tokenPath = path.join(secretsDir, "host-vps-a.token");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, "stale-but-not-ours-to-delete\n", { mode: 0o600 });

    const deps = fakeDeps({ poll: [] });
    const { err, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("never overwritten");

    expect(deps.postCalls()).toBe(0);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe("stale-but-not-ours-to-delete\n");
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "hosts.yaml"))).toBe(false);
  });

  it("empty-ls hint teaches pair FIRST (FR-6 front-door AC)", async () => {
    const deps = fakeDeps({ poll: [] });
    const { out } = await capture(() => run(deps, ["list"]));
    const text = out.join("\n");
    expect(text).toContain("rig host pair <url>");
    expect(text.indexOf("rig host pair")).toBeLessThan(text.indexOf("rig host add"));
  });

  // rev1-r1 D: the client-side TIMEOUT walk — deny was walked end-to-end,
  // timeout only server-side; this pins the client's nothing-persists leg.
  it("R1-D: approval timeout on the client persists NOTHING (no registry entry, no token file)", async () => {
    const deps = fakeDeps({ poll: [{ status: 200, body: { status: "pending", code: "424242" } }] });
    const { err, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433", "--id", "vps-a", "--timeout", "1"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("no approval arrived before the timeout");
    expect(err.join("\n")).toContain("Nothing was persisted");
    expect(fs.existsSync(path.join(dir, "hosts.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "secrets"))).toBe(false);
  }, 15_000);

  // rev1-r2 B1: path-bearing ids die at the registry-door preflight —
  // they must never reach the token-path join, let alone the target.
  it("B1 (rev1-r2): a path-bearing --id is rejected at preflight; target never contacted, nothing written", async () => {
    const deps = fakeDeps({ poll: [] });
    const { err, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433", "--id", "../escape"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("not a valid host id");
    expect(deps.postCalls()).toBe(0);
    expect(fs.existsSync(path.join(dir, "secrets"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "hosts.yaml"))).toBe(false);
  });

  // rev1-r2 B3: the token write is exclusive-create ("wx") — a file that
  // appears DURING the approval wait is never overwritten or deleted.
  it("B3 (rev1-r2): a token file appearing during the approval wait is refused — contents preserved, nothing else persists", async () => {
    const tokenPath = path.join(dir, "secrets", "host-vps-a.token");
    const deps = fakeDeps({ poll: [{ status: 200, body: { status: "approved", token: "issued-bearer" } }] });
    const origGet = deps.httpGet;
    let planted = false;
    deps.httpGet = async (url, headers) => {
      if (!planted) {
        planted = true;
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tokenPath, "winner-credential\n", { mode: 0o600 });
      }
      return origGet(url, headers);
    };
    const { err, exitCode } = await capture(() => run(deps, ["pair", "vps-a:7433", "--id", "vps-a", "--timeout", "10"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("refusing to overwrite");
    expect(fs.readFileSync(tokenPath, "utf8")).toBe("winner-credential\n");
    expect(fs.existsSync(path.join(dir, "hosts.yaml"))).toBe(false);
  }, 15_000);

  // QA2 fixback: the PRD/proof contract spells the verb `rig host ls` —
  // the alias must resolve to the SAME list behavior, --json included.
  it("rig host ls is a working alias of list (PRD FR-3 contract spelling), --json preserved", async () => {
    const deps = fakeDeps({ poll: [{ status: 200, body: { status: "approved", token: "issued-bearer" } }] });
    await capture(() => run(deps, ["pair", "vps-a:7433", "--id", "vps-a", "--timeout", "10"]));

    const human = await capture(() => run(fakeDeps({ poll: [] }), ["ls"]));
    expect(human.exitCode).toBeUndefined();
    expect(human.out.join("\n")).toContain("vps-a");

    const json = await capture(() => run(fakeDeps({ poll: [] }), ["ls", "--json"]));
    expect(json.exitCode).toBeUndefined();
    const rows = JSON.parse(json.out.join("")) as Array<{ id: string; selected: boolean; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("vps-a");
    expect(rows[0]).toHaveProperty("selected");
    expect(rows[0]).toHaveProperty("status");
  }, 20_000);
});
