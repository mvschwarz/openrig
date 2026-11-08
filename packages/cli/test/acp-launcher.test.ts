// @openrig/acp: the one-executable launcher the ACP registry starts with npx. It must stay in lockstep with the CLI it
// pins (a release that bumps one bumps all of them), pass its listing's checks, and hand the app's stdio, arguments,
// environment, working directory, exit code and signals straight to `rig acp serve`.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../src/config-store.js";
import { acpReceiver } from "../src/commands/acp.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
const cli = json("packages/cli/package.json");
const launcher = json("packages/acp/package.json");
const listing = json("packages/acp/registry/agent.json");

describe("@openrig/acp stays in lockstep with @openrig/cli", () => {
  it("has the CLI's version, pins exactly that CLI, and has one executable", () => {
    expect(launcher.name).toBe("@openrig/acp");
    expect(launcher.version).toBe(cli.version);
    expect(launcher.dependencies).toEqual({ "@openrig/cli": cli.version });
    expect(launcher.bin).toEqual({ "openrig-acp": "bin/openrig-acp.js" });
    expect(statSync(join(repo, "packages/acp/bin/openrig-acp.js")).mode & 0o111).not.toBe(0);
  });

  it("the registry listing names this version of the launcher, with no arguments", () => {
    expect(listing).toMatchObject({ id: "openrig", name: "OpenRig", version: cli.version, license: "Apache-2.0" });
    expect(listing.distribution).toEqual({ npx: { package: `@openrig/acp@${cli.version}` } });
  });

  it("the icon passes the registry's checks: 16x16, currentColor only, no comments", () => {
    const svg = readFileSync(join(repo, "packages/acp/registry/icon.svg"), "utf8");
    expect(svg).not.toContain("<!--");
    const root = svg.match(/^<svg\b[^>]*>/)![0];
    expect(root).toMatch(/\swidth="16"/);
    expect(root).toMatch(/\sheight="16"/);
    const paints = [...svg.matchAll(/\s(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]!.toLowerCase());
    expect(paints).toContain("currentcolor");
    expect(paints.every((v) => ["currentcolor", "none", "inherit"].includes(v))).toBe(true);
    expect(svg).not.toMatch(/style=|<style/);
  });
});

describe("acp.to: the receiver a registry launch uses", () => {
  it("is empty by default, takes member@rig, and refuses anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-to-"));
    try {
      const store = new ConfigStore(join(dir, "config.json"));
      expect(store.get("acp.to")).toBe("");
      for (const bad of ["lead", "lead@", "@team", "lead @team", "a@b@c"]) expect(() => store.set("acp.to", bad)).toThrow(/Invalid acp\.to/);
      store.set("acp.to", "lead@my-team");
      expect(store.resolve().acp).toEqual({ to: "lead@my-team" });
      store.set("acp.to", "");
      expect(store.get("acp.to")).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("--to wins; a settings file that can't be read is the reason the app's sign-in step shows", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-to-"));
    try {
      const store = new ConfigStore(join(dir, "config.json"));
      expect(acpReceiver(undefined, store)).toEqual({ receiver: undefined });
      store.set("acp.to", "lead@my-team");
      expect(acpReceiver(undefined, store)).toEqual({ receiver: "lead@my-team" });
      writeFileSync(join(dir, "config.json"), "{not json");
      expect(acpReceiver(" other@team ", store)).toEqual({ receiver: "other@team" });
      const unreadable = acpReceiver(undefined, store);
      expect("error" in unreadable && unreadable.error).toMatch(/malformed[\s\S]*adding --to <member@rig> to the agent's command skips it\.$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("openrig-acp hands everything to rig acp serve", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** The launcher installed beside a stand-in @openrig/cli (the version it pins, unless given) whose `rig` reports what it was given. */
  function install(withCli = true, cliVersion: string = cli.version): string {
    const root = mkdtempSync(join(tmpdir(), "openrig-acp-"));
    dirs.push(root);
    const acp = join(root, "node_modules/@openrig/acp");
    mkdirSync(join(acp, "bin"), { recursive: true });
    copyFileSync(join(repo, "packages/acp/package.json"), join(acp, "package.json"));
    copyFileSync(join(repo, "packages/acp/bin/openrig-acp.js"), join(acp, "bin/openrig-acp.js"));
    if (withCli) {
      const fake = join(root, "node_modules/@openrig/cli");
      mkdirSync(join(fake, "dist"), { recursive: true });
      writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "@openrig/cli", version: cliVersion, type: "module", bin: { rig: "dist/rig.js", "openrig-tui": "dist/tui.js" } }));
      writeFileSync(join(fake, "dist/rig.js"), [
        `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), mark: process.env.FAKE_MARK }) + "\\n");`,
        `process.stdin.on("data", (d) => process.stdout.write(d));`,
        `process.stdin.on("end", () => process.exit(Number(process.env.FAKE_EXIT ?? 0)));`,
      ].join("\n"));
    }
    mkdirSync(join(root, "work"));
    return root;
  }

  function run(root: string, args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(root, "node_modules/@openrig/acp/bin/openrig-acp.js"), ...args],
      { cwd: join(root, "work"), env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    return { child, done, out: () => out, err: () => err };
  }

  it("passes arguments, stdin, stdout, environment, working directory and the exit code through", async () => {
    const root = install();
    const app = run(root, ["--to", "lead@team"], { FAKE_MARK: "from-the-app", FAKE_EXIT: "3" });
    app.child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(await app.done).toEqual({ code: 3, signal: null });
    const [first, echoed] = app.out().trim().split("\n");
    expect(JSON.parse(first!)).toEqual({ argv: ["acp", "serve", "--to", "lead@team"], cwd: realpathSync(join(root, "work")), mark: "from-the-app" });
    expect(echoed).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(app.err()).toBe("");
  });

  it("a signal from the app reaches the server, and the launcher ends the way the server did", async () => {
    const app = run(install(), []);
    await new Promise<void>((resolve) => app.child.stdout.once("data", () => resolve()));
    app.child.kill("SIGTERM");
    expect(await app.done).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("without its @openrig/cli it says so on stderr, writes nothing to stdout, and exits 1", async () => {
    const app = run(install(false), []);
    app.child.stdin.end();
    expect(await app.done).toEqual({ code: 1, signal: null });
    expect(app.out()).toBe("");
    expect(app.err()).toMatch(/^openrig-acp: @openrig\/cli isn't installed beside this package/);
  });

  it("an @openrig/cli of another version is named on stderr and run anyway, with the arguments and exit code passed", async () => {
    const root = install(true, "0.0.0");
    const app = run(root, ["--to", "lead@team"], { FAKE_EXIT: "3" });
    app.child.stdin.end();
    expect(await app.done).toEqual({ code: 3, signal: null });
    expect(JSON.parse(app.out().trim().split("\n")[0]!).argv).toEqual(["acp", "serve", "--to", "lead@team"]);
    expect(app.err()).toMatch(/^openrig-acp: found @openrig\/cli 0\.0\.0 at /);
    expect(app.err()).toContain(`not the ${cli.version} this package pins; running it anyway. Reinstall @openrig/acp to get ${cli.version}.`);
  });
});
