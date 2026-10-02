// OPR.0.4.4.18 — the security cell, test-asserted (plan §3/§7a/§7a-2,
// guard-cleared over three rounds). The property tests ARE the contract:
// deletion-class flags unreachable, -s/--protect-args ABSENT (the G18-P3
// uniformity pin), '--' always pinned before operands (G18-P1), the remote
// charset shell-inert, every rejection before any spawn.

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import {
  parseFilePathArg,
  checkLocalPath,
  checkRemotePath,
  planFileCopy,
  buildRsyncArgv,
  classifyRsyncResult,
  runFileCopy,
  DENIED_SEGMENTS,
  type CopyPlan,
  type CopySide,
} from "../src/lib/file-transfer.js";
import type { SshHostEntry } from "../src/host-registry.js";

const VPS: SshHostEntry = { id: "vps-a", transport: "ssh", target: "vps-a.tail.net", user: "openrig" };
const REGISTRY_OK = () => ({ ok: true as const, registry: { hosts: [VPS, { id: "http-1", transport: "http" as const, url: "http://h:7433", bearer_env: "T" }] } });

function local(p: string): CopySide {
  return { kind: "local", path: p };
}
function remote(p: string): CopySide {
  return { kind: "remote", path: p, host: VPS };
}

// ── grammar (FR-1/FR-2/N18-1/G18-P1) ────────────────────────────────────────

describe("parseFilePathArg — the explicit-or-local grammar", () => {
  it("local-prefix escapes are ALWAYS local, colon or not", () => {
    for (const p of ["/abs/file.md", "./notes:v2.md", "../up.md", "~/docs/x.md", "~"]) {
      expect(parseFilePathArg(p)).toEqual({ ok: true, arg: { kind: "local", path: p } });
    }
  });

  it("id-shaped colon prefix parses as a HOST qualifier (resolve-or-fail-loud happens at planning)", () => {
    expect(parseFilePathArg("vps-a:/srv/x.md")).toEqual({ ok: true, arg: { kind: "remote", hostId: "vps-a", path: "/srv/x.md" } });
    expect(parseFilePathArg("mac_mini2:/tmp/y")).toEqual({ ok: true, arg: { kind: "remote", hostId: "mac_mini2", path: "/tmp/y" } });
  });

  it("resolves dotted registered host ids for both transfer sides", () => {
    const host = { ...VPS, id: "edge.dev" };
    const registryLoader = () => ({ ok: true as const, registry: { hosts: [host] } });
    for (const [src, dst, operandIndex] of [
      ["edge.dev:/srv/source", "/tmp/dst", -2],
      ["/tmp/source", "edge.dev:/srv/dst", -1],
    ] as const) {
      const result = planFileCopy(src, dst, { registryLoader });
      expect(result.ok).toBe(true);
      if (result.ok) expect(buildRsyncArgv(result.plan).at(operandIndex)).toContain(`${host.target}:/srv/`);
    }

    expect(parseFilePathArg("./edge.dev:/srv/x")).toEqual({ ok: true, arg: { kind: "local", path: "./edge.dev:/srv/x" } });
  });

  it("keeps unregistered dotted source and destination names local, including empty suffixes", () => {
    const registryLoader = REGISTRY_OK;
    for (const operand of ["notes.md:version", "missing.dev:/srv/x", "notes.md:"]) {
      for (const [src, dst] of [[operand, "./out.md"], ["./in.md", operand]]) {
        const result = planFileCopy(src!, dst!, { registryLoader });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.src.kind).toBe("local");
          expect(result.plan.dst.kind).toBe("local");
        }
      }
    }
  });

  it("preserves dotted explicit local escapes even when that host is registered", () => {
    const registryLoader = () => ({ ok: true as const, registry: { hosts: [{ ...VPS, id: "edge.dev" }] } });
    for (const operand of ["/edge.dev:x", "./edge.dev:x", "../edge.dev:x", "~/edge.dev:x"]) {
      for (const [src, dst] of [[operand, "./out.md"], ["./in.md", operand]]) {
        const result = planFileCopy(src!, dst!, { registryLoader });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.src.kind).toBe("local");
          expect(result.plan.dst.kind).toBe("local");
        }
      }
    }
  });

  it("does not misclassify a dotted local operand paired with a registered remote", () => {
    const registryLoader = () => ({ ok: true as const, registry: { hosts: [{ ...VPS, id: "edge.dev" }] } });
    for (const [src, dst] of [["notes.md:v2", "edge.dev:/srv/out"], ["edge.dev:/srv/in", "notes.md:"]]) {
      expect(planFileCopy(src!, dst!, { registryLoader }).ok).toBe(true);
    }
    expect(planFileCopy("edge.dev:/srv/in", "edge.dev:/srv/out", { registryLoader }))
      .toMatchObject({ ok: false, code: "remote_to_remote" });
  });

  it("retains remote validation failures after positive dotted registration", () => {
    const ssh = { ...VPS, id: "edge.dev" };
    const http = { id: "web.dev", transport: "http" as const, url: "http://h:7433" };
    const badUser = { ...VPS, id: "bad.dev", user: "invalid user" };
    const registryLoader = () => ({ ok: true as const, registry: { hosts: [ssh, http, badUser] } });
    for (const [operand, code] of [["edge.dev:", "bad_operand"], ["edge.dev:relative", "denied_path"], ["edge.dev:/srv/a b", "denied_path"], ["edge.dev:/srv/.ssh/key", "denied_path"], ["web.dev:/srv/x", "unsupported_transport"], ["bad.dev:/srv/x", "invalid_registry_user"]]) {
      for (const [src, dst] of [[operand, "./out.md"], ["./in.md", operand]]) {
        expect(planFileCopy(src!, dst!, { registryLoader })).toMatchObject({ ok: false, code });
      }
    }
  });

  it("uses the registration snapshot through remote validation without a second lookup", () => {
    let loads = 0;
    const host = { ...VPS, id: "edge.dev" };
    const registryLoader = () => {
      loads++;
      return loads === 1
        ? { ok: true as const, registry: { hosts: [host] } }
        : { ok: false as const, error: "later registry error" };
    };
    const result = planFileCopy("edge.dev:/srv/in", "./out.md", { registryLoader });
    expect(result.ok).toBe(true);
    expect(loads).toBe(1);
    if (result.ok) expect(result.plan.src.kind).toBe("remote");
  });

  it("retains undotted unknown-host errors on source and destination", () => {
    for (const [src, dst] of [["missing:/srv/x", "./out.md"], ["./in.md", "missing:/srv/x"]]) {
      expect(planFileCopy(src!, dst!, { registryLoader: REGISTRY_OK })).toMatchObject({ ok: false, code: "unknown_host" });
    }
  });

  it("keeps dotted local names local when no registry can be positively read", () => {
    const registryLoader = () => ({ ok: false as const, error: "registry unreadable" });
    expect(planFileCopy("notes.md:", "./out.md", { registryLoader }).ok).toBe(true);
    expect(planFileCopy("known:/srv/x", "./out.md", { registryLoader })).toMatchObject({ ok: false, code: "registry_error" });
  });

  it("N18-1: a bare colon-named file parses as an (unknown) host — fail-closed at planning, never silent-local", () => {
    expect(parseFilePathArg("notes:v2.md")).toEqual({ ok: true, arg: { kind: "remote", hostId: "notes", path: "v2.md" } });
  });

  it("non-id-shaped colon prefixes are local (scp's lived behavior)", () => {
    expect(parseFilePathArg("dir/sub:file.md")).toEqual({ ok: true, arg: { kind: "local", path: "dir/sub:file.md" } });
  });

  it("G18-P1: leading-dash operands are REFUSED with the ./ escape taught", () => {
    const res = parseFilePathArg("--delete-after");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("./--delete-after");
  });

  it("empty remote path after the qualifier rejects", () => {
    const res = parseFilePathArg("vps-a:");
    expect(res.ok).toBe(false);
  });
});

// ── the deny wall (FR-4) ────────────────────────────────────────────────────

describe("checkLocalPath — resolve-then-recheck deny wall", () => {
  it("denies resolved paths under each short-closed-list root, incl. via traversal and ~", () => {
    const home = os.homedir();
    for (const seg of DENIED_SEGMENTS) {
      const direct = checkLocalPath(path.join(home, seg, "x"));
      expect(direct.ok).toBe(false);
      const viaTilde = checkLocalPath(`~/${seg}/hosts.yaml`);
      expect(viaTilde.ok).toBe(false);
      // Traversal resolving INTO a denied root is caught on the RESOLVED form.
      const viaTraversal = checkLocalPath(path.join(home, "safe", "..", seg, "x"));
      expect(viaTraversal.ok).toBe(false);
    }
  });

  it("denies the active hosts registry and custom OPENRIG_HOME state", () => {
    const saved = process.env["OPENRIG_HOME"];
    const customHome = path.join(os.tmpdir(), `openrig-s18-active-${Date.now()}`);
    try {
      process.env["OPENRIG_HOME"] = customHome;
      const registry = checkLocalPath(path.join(customHome, "hosts.yaml"));
      expect(registry.ok).toBe(false);
      if (!registry.ok) expect(registry.error).toContain("active hosts registry");

      const state = checkLocalPath(path.join(customHome, "workspace", "artifact.md"));
      expect(state.ok).toBe(false);
      if (!state.ok) expect(state.error).toContain("active OPENRIG_HOME");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = saved;
    }
  });

  it("allows ordinary paths and returns the RESOLVED form (what rsync receives)", () => {
    const res = checkLocalPath("./some/dir/../file.md");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(path.isAbsolute(res.normalizedPath)).toBe(true);
      expect(res.normalizedPath.includes("..")).toBe(false);
    }
  });
});

describe("checkRemotePath — the shell-inert charset wall (G18-P3) + absolute-only + traversal + segments", () => {
  it("rejects every shell-interpretable character class, TEACHING the offending char", () => {
    const cases: Array<[string, string]> = [
      ["/srv/a b.md", "a space"],
      ["/srv/$HOME/x", "'$'"],
      ["/srv/`id`.md", "'`'"],
      ["/srv/x;rm", "';'"],
      ["/srv/x|y", "'|'"],
      ["/srv/x&y", "'&'"],
      ["/srv/'q'.md", `"'"`.slice(1, 2) === "'" ? "'''" : "quote"],
      ["/srv/x>y", "'>'"],
      ["/srv/(x)", "'('"],
      ["/srv/{x}", "'{'"],
      ["/srv/x\\y", "'\\'"],
      ["/srv/x\ny", "\n"],
      ["/srv/*.md", "'*'"],
      ["/srv/x?.md", "'?'"],
      ["~/x.md", "'~'"],
    ];
    for (const [p] of cases) {
      const res = checkRemotePath(p, "vps-a");
      expect(res.ok, `should reject: ${JSON.stringify(p)}`).toBe(false);
    }
    // The teaching shape, spot-checked on the space case (arch note 1).
    const space = checkRemotePath("/srv/a b.md", "vps-a");
    if (!space.ok) {
      expect(space.error).toContain("a space");
      expect(space.error).toContain("space-free staging path");
    }
  });

  it("rejects relative remote paths (absolute-only, arch Q5)", () => {
    const res = checkRemotePath("srv/x.md", "vps-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("ABSOLUTE-only");
  });

  it("G18-C1: ANY raw '..' segment rejects BEFORE normalization (normalize COLLAPSES '..' in absolute paths — a post-normalize check is dead code)", () => {
    expect(checkRemotePath("/srv/../../etc/passwd", "vps-a").ok).toBe(false); // the root-climb guard caught escaping
    expect(checkRemotePath("/srv/sub/../x.md", "vps-a").ok).toBe(false); // 'benign' collapsible '..' rejects too — never necessary in an absolute path
    const res = checkRemotePath("/srv/..hidden/x.md", "vps-a"); // '..' as a NAME PREFIX is not a traversal segment
    expect(res.ok).toBe(true);
    // Normalization still collapses '.' and '//' — the normalized form is what ships.
    const collapsed = checkRemotePath("/srv//sub/./x.md", "vps-a");
    expect(collapsed.ok).toBe(true);
    if (collapsed.ok) expect(collapsed.normalizedPath).toBe("/srv/sub/x.md");
  });

  it("rejects denied dot-directory segments ANYWHERE in the path (conservative-over-broad)", () => {
    for (const seg of DENIED_SEGMENTS) {
      expect(checkRemotePath(`/home/u/${seg}/f`, "vps-a").ok).toBe(false);
      expect(checkRemotePath(`/srv/backup/${seg}/f`, "vps-a").ok).toBe(false);
    }
    // Also via traversal that normalizes INTO a denied segment.
    expect(checkRemotePath("/srv/x/../.ssh/id_ed25519", "vps-a").ok).toBe(false);
  });
});

// ── planning: the fail-closed set (all BEFORE any spawn) ────────────────────

describe("planFileCopy — fail-closed set", () => {
  const deps = { registryLoader: REGISTRY_OK as never };

  it("remote:remote rejects with the pull-then-push message", () => {
    const res = planFileCopy("vps-a:/a.md", "vps-a:/b.md", deps);
    expect(res).toMatchObject({ ok: false, code: "remote_to_remote" });
  });

  it("unknown host fails loudly (the N18-1 colon-file case lands here)", () => {
    const res = planFileCopy("notes:v2.md", "./out.md", deps);
    expect(res).toMatchObject({ ok: false, code: "unknown_host" });
    if (!res.ok) expect(res.error).toContain("unknown host id 'notes'");
  });

  it("http-transport host rejects (ssh/rsync only in v0)", () => {
    const res = planFileCopy("http-1:/x.md", "./out.md", deps);
    expect(res).toMatchObject({ ok: false, code: "unsupported_transport" });
  });

  it("two bare paths = a local-only plan (explicit-or-local; no inference)", () => {
    const res = planFileCopy("./a.md", "b.md", deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.src.kind).toBe("local");
      expect(res.plan.dst.kind).toBe("local");
    }
  });

  it("denied locations reject at planning on either side", () => {
    expect(planFileCopy("~/.ssh/id_ed25519", "vps-a:/tmp/key", deps)).toMatchObject({ ok: false, code: "denied_path" });
    expect(planFileCopy("./ok.md", "vps-a:/home/u/.openrig/db.sqlite", deps)).toMatchObject({ ok: false, code: "denied_path" });
  });
});

// ── the CLOSED argv builder: property tests ─────────────────────────────────

const ADVERSARIAL_LOCALS = ["/tmp/--delete-after", "/tmp/--remove-source-files", "/tmp/-e", "/tmp/--rsh=x", "/tmp/-- evil"];

function allPlans(): CopyPlan[] {
  const plans: CopyPlan[] = [];
  for (const dryRun of [false, true]) {
    plans.push({ src: local("/tmp/a.md"), dst: remote("/srv/a.md"), dryRun });
    plans.push({ src: remote("/srv/a.md"), dst: local("/tmp/a.md"), dryRun });
    plans.push({ src: local("/tmp/a.md"), dst: local("/tmp/b.md"), dryRun });
    for (const adv of ADVERSARIAL_LOCALS) {
      plans.push({ src: local(adv), dst: remote("/srv/x"), dryRun });
      plans.push({ src: local(adv), dst: local("/tmp/y"), dryRun });
    }
  }
  return plans;
}

describe("buildRsyncArgv — closed-builder properties (every permutation)", () => {
  it("NO deletion-class flag, NO -s/--protect-args (G18-P3 absence pin), '--' ALWAYS pinned before the two operands, flag-shaped operands only in post-'--' positions (G18-P1)", () => {
    for (const plan of allPlans()) {
      const argv = buildRsyncArgv(plan);
      const sep = argv.indexOf("--");
      expect(sep, JSON.stringify(argv)).toBeGreaterThan(-1);
      expect(sep).toBe(argv.length - 3); // exactly two operands after the pin
      const options = argv.slice(0, sep);
      for (const opt of options) {
        expect(opt.startsWith("--delete")).toBe(false);
        expect(opt.startsWith("--remove")).toBe(false);
        expect(opt.startsWith("--force")).toBe(false);
        expect(opt).not.toBe("-s");
        expect(opt).not.toBe("--protect-args");
      }
      // Adversarial flag-shaped paths appear ONLY as operands (index > sep).
      for (const adv of ADVERSARIAL_LOCALS) {
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === adv) expect(i).toBeGreaterThan(sep);
        }
      }
      // Dry-run is rsync's NATIVE flag, present iff requested.
      expect(options.includes("--dry-run")).toBe(plan.dryRun);
    }
  });

  it("the -e ssh command is built ONLY from registry fields; local-local plans carry no -e at all", () => {
    const withRemote = buildRsyncArgv({ src: local("/tmp/a"), dst: remote("/srv/b"), dryRun: false });
    const e = withRemote[withRemote.indexOf("-e") + 1]!;
    expect(e).toBe("ssh -o ConnectTimeout=10 -l openrig");
    const localOnly = buildRsyncArgv({ src: local("/tmp/a"), dst: local("/tmp/b"), dryRun: false });
    expect(localOnly.includes("-e")).toBe(false);
  });

  it("remote operands render as target:path from the registry target", () => {
    const argv = buildRsyncArgv({ src: local("/tmp/a.md"), dst: remote("/srv/briefs/a.md"), dryRun: false });
    expect(argv[argv.length - 1]).toBe("vps-a.tail.net:/srv/briefs/a.md");
  });
});

// ── classification (executor taxonomy minus the daemon class) ───────────────

describe("classifyRsyncResult / runFileCopy", () => {
  it("exit 0 → ok with --stats parsed", () => {
    const res = classifyRsyncResult(0, "Number of regular files transferred: 1\nTotal transferred file size: 2,048 bytes\n", "");
    expect(res).toMatchObject({ ok: true, failedStep: "none", bytesTransferred: 2048, filesTransferred: 1 });
  });

  it.each([
    "user@host: Permission denied (publickey).",
    "Could not query Keychain entry",
    "Host key verification failed",
    "Could not request authentication agent",
    "no mutual signature algorithm",
  ])("permission failure retains taxonomy, stderr and usable inline guidance: %s", (stderr) => {
    const result = classifyRsyncResult(255, "", stderr);
    expect(result).toMatchObject({ ok: false, failedStep: "permission-gate", exitCode: 255, stderr });
    expect(result.hint).toContain("registered host/user");
    expect(result.hint).toContain("authentication");
    expect(result.hint).toContain("host-key");
    expect(result.hint).toContain("keep host verification enabled");
    expect(result.hint).not.toContain("openrig-work/");
  });

  it("exit 255 / connection-class stderr → ssh-unreachable; other non-zero → remote-command-failed; NO daemon class exists", () => {
    expect(classifyRsyncResult(255, "", "kex_exchange: Connection refused").failedStep).toBe("ssh-unreachable");
    expect(classifyRsyncResult(12, "", "rsync: connection unexpectedly closed").failedStep).toBe("ssh-unreachable");
    expect(classifyRsyncResult(23, "", "rsync: some files could not be transferred").failedStep).toBe("remote-command-failed");
  });

  it("missing local rsync (spawn ENOENT) → rsync-missing with the install hint (arch Q6)", async () => {
    const fakeSpawn = (() => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (evt: string, cb: (arg?: unknown) => void) => {
          handlers[evt] = cb;
          if (evt === "close") {
            const err = new Error("spawn rsync ENOENT") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            handlers["error"]?.(err);
          }
        },
      };
    }) as never;
    const res = await runFileCopy({ src: local("/tmp/a"), dst: local("/tmp/b"), dryRun: true }, { spawn: fakeSpawn });
    expect(res.failedStep).toBe("rsync-missing");
    expect(res.hint).toContain("brew install rsync");
  });
});


describe("file copy output byte boundaries", () => {
  it("preserves split UTF-8 on both rsync output pipes", async () => {
    const text = "copied café/日本語.md 🙂\n";
    const spawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        for (const byte of Buffer.from(text)) {
          child.stdout.emit("data", Buffer.from([byte]));
          child.stderr.emit("data", Buffer.from([byte]));
        }
        child.emit("close", 0);
      });
      return child;
    }) as unknown as NonNullable<Parameters<typeof runFileCopy>[1]>["spawn"];
    const result = await runFileCopy({ src: local("/tmp/src"), dst: local("/tmp/dst"), dryRun: true }, { spawn });
    expect(result).toMatchObject({ ok: true, stdout: text, stderr: text });
  });
});

let rsyncAvailable = false;
try { execFileSync("rsync", ["--version"], { stdio: "ignore" }); rsyncAvailable = true; }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

describe("local directory copy semantics", () => {
  it("preserves the trailing slash in the normalized local source and rsync argv", () => {
    const source = "." + path.sep + "copy-source" + path.sep;
    const planned = planFileCopy(source, "." + path.sep + "copy-destination");
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const expectedSource = path.resolve("copy-source") + path.sep;
    expect(planned.plan.src.path).toBe(expectedSource);
    expect(buildRsyncArgv(planned.plan).slice(-2)[0]).toBe(expectedSource);
  });

  it.skipIf(!rsyncAvailable).each([false, true])("native rsync preserves source directory trailing slash=%s (requires installed rsync)", async (contentsOnly) => {
    const root = mkdtempSync(path.join(process.cwd(), "openrig-copy-contents-"));
    try {
      const src = path.join(root, "source");
      const dst = path.join(root, "destination");
      mkdirSync(src); mkdirSync(dst);
      writeFileSync(path.join(src, "artifact.txt"), "owned test artifact");
      const localSrc = "." + path.sep + path.relative(process.cwd(), src);
      const localDst = "." + path.sep + path.relative(process.cwd(), dst);
      const planned = planFileCopy(localSrc + (contentsOnly ? path.sep : ""), localDst);
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      const result = await runFileCopy(planned.plan);
      expect(result.ok, result.stderr).toBe(true);
      const expected = path.join(dst, ...(contentsOnly ? [] : ["source"]), "artifact.txt");
      expect(existsSync(expected), `rsync destination should be ${expected}`).toBe(true);
      expect(readFileSync(expected, "utf8")).toBe("owned test artifact");
      if (contentsOnly) expect(existsSync(path.join(dst, "source"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
