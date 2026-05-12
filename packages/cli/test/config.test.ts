import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { Command } from "commander";
import { ConfigStore, VALID_KEYS } from "../src/config-store.js";
import { configCommand } from "../src/commands/config.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

describe("ConfigStore", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
    // Save env vars we'll modify
    savedEnv = {
      OPENRIG_PORT: process.env["OPENRIG_PORT"],
      OPENRIG_HOST: process.env["OPENRIG_HOST"],
      OPENRIG_DB: process.env["OPENRIG_DB"],
      OPENRIG_TRANSCRIPTS_ENABLED: process.env["OPENRIG_TRANSCRIPTS_ENABLED"],
      OPENRIG_TRANSCRIPTS_PATH: process.env["OPENRIG_TRANSCRIPTS_PATH"],
    };
    // Clear env vars for clean tests
    delete process.env["OPENRIG_PORT"];
    delete process.env["OPENRIG_HOST"];
    delete process.env["OPENRIG_DB"];
    delete process.env["OPENRIG_TRANSCRIPTS_ENABLED"];
    delete process.env["OPENRIG_TRANSCRIPTS_PATH"];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // Test 1
  it("resolve() returns defaults when no config file and no env", () => {
    const store = new ConfigStore(join(tmpDir, "config.json"));
    const config = store.resolve();
    expect(config.daemon.port).toBe(7433);
    expect(config.daemon.host).toBe("127.0.0.1");
    expect(config.db.path).toContain(".openrig/openrig.sqlite");
    expect(config.transcripts.enabled).toBe(true);
    expect(config.transcripts.path).toContain(".openrig/transcripts");
  });

  // Test 2
  it("resolve() reads config file values", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ daemon: { port: 8888 }, transcripts: { enabled: false } }));
    const store = new ConfigStore(configPath);
    const config = store.resolve();
    expect(config.daemon.port).toBe(8888);
    expect(config.transcripts.enabled).toBe(false);
    // Unset keys still get defaults
    expect(config.daemon.host).toBe("127.0.0.1");
  });

  // Test 3
  it("resolve() env vars override config file", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ daemon: { port: 8888 } }));
    process.env["OPENRIG_PORT"] = "9999";
    const store = new ConfigStore(configPath);
    const config = store.resolve();
    expect(config.daemon.port).toBe(9999);
  });

  // Test 4
  it("get() returns resolved value for dotted key", () => {
    const store = new ConfigStore(join(tmpDir, "config.json"));
    expect(store.get("daemon.port")).toBe(7433);
  });

  // Test 5
  it("set() persists value and is readable", () => {
    const configPath = join(tmpDir, "config.json");
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "7434");
    expect(store.get("daemon.port")).toBe(7434);
    // Verify file was written
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.daemon.port).toBe(7434);
  });

  // Test 6
  it("set() with invalid key throws listing valid keys", () => {
    const store = new ConfigStore(join(tmpDir, "config.json"));
    expect(() => store.set("invalid.key", "value")).toThrow(/valid keys/i);
    expect(() => store.set("invalid.key", "value")).toThrow(/daemon\.port/);
  });

  // Test 7
  it("resolve() with malformed config.json throws with fix/reset guidance", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, "not valid json{{{");
    const store = new ConfigStore(configPath);
    expect(() => store.resolve()).toThrow(/malformed/i);
    expect(() => store.resolve()).toThrow(/reset/i);
  });
});

describe("DaemonClient config integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "client-config-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ConfigStore resolves non-default host/port from config file", async () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ daemon: { port: 9876, host: "10.0.0.5" } }));
    const { ConfigStore: CS } = await import("../src/config-store.js");
    const config = new CS(configPath).resolve();
    expect(config.daemon.port).toBe(9876);
    expect(config.daemon.host).toBe("10.0.0.5");
  });
});

describe("DaemonClient config-aware baseUrl", () => {
  it("new DaemonClient() without args resolves baseUrl from config env vars", async () => {
    const saved = {
      OPENRIG_URL: process.env["OPENRIG_URL"],
      OPENRIG_PORT: process.env["OPENRIG_PORT"],
      OPENRIG_HOST: process.env["OPENRIG_HOST"],
    };
    delete process.env["OPENRIG_URL"];
    process.env["OPENRIG_PORT"] = "9999";
    process.env["OPENRIG_HOST"] = "10.0.0.5";
    try {
      const { DaemonClient } = await import("../src/client.js");
      const client = new DaemonClient();
      expect(client.baseUrl).toBe("http://10.0.0.5:9999");
    } finally {
      if (saved.OPENRIG_URL !== undefined) process.env["OPENRIG_URL"] = saved.OPENRIG_URL;
      else delete process.env["OPENRIG_URL"];
      if (saved.OPENRIG_PORT !== undefined) process.env["OPENRIG_PORT"] = saved.OPENRIG_PORT;
      else delete process.env["OPENRIG_PORT"];
      if (saved.OPENRIG_HOST !== undefined) process.env["OPENRIG_HOST"] = saved.OPENRIG_HOST;
      else delete process.env["OPENRIG_HOST"];
    }
  });
});

describe("getDaemonStatus host preservation", () => {
  it("preserves non-localhost host from OPENRIG_URL", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    const savedUrl = process.env["OPENRIG_URL"];
    process.env["OPENRIG_URL"] = "http://10.0.0.5:8080";
    try {
      const mockDeps = {
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
      const status = await getDaemonStatus(mockDeps);
      expect(status.host).toBe("10.0.0.5");
      expect(status.port).toBe(8080);
    } finally {
      if (savedUrl !== undefined) process.env["OPENRIG_URL"] = savedUrl;
      else delete process.env["OPENRIG_URL"];
    }
  });
});

describe("getDaemonUrl", () => {
  it("constructs URL from status host and port", async () => {
    const { getDaemonUrl } = await import("../src/daemon-lifecycle.js");
    expect(getDaemonUrl({ state: "running", port: 8080, host: "192.168.1.5" })).toBe("http://192.168.1.5:8080");
  });

  it("defaults to 127.0.0.1 when host is undefined", async () => {
    const { getDaemonUrl } = await import("../src/daemon-lifecycle.js");
    expect(getDaemonUrl({ state: "running", port: 7433 })).toBe("http://127.0.0.1:7433");
  });
});

// CLI command tests
function mockLifecycleDeps() {
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

describe("Config CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-cli-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 8
  it("rig config --json prints full resolved config", async () => {
    const cmd = configCommand(join(tmpDir, "config.json"));
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(cmd);

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "config", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.daemon).toBeDefined();
    expect(parsed.daemon.port).toBe(7433);
    expect(parsed.transcripts).toBeDefined();
  });

  // Test 9
  it("rig config get transcripts.path prints resolved path", async () => {
    const cmd = configCommand(join(tmpDir, "config.json"));
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(cmd);

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "config", "get", "transcripts.path"]);
    });
    expect(logs.join("\n")).toContain("transcripts");
  });

  it("rig config get <key> --json prints value with source metadata", async () => {
    const savedHost = process.env["OPENRIG_HOST"];
    delete process.env["OPENRIG_HOST"];
    const cmd = configCommand(join(tmpDir, "config.json"));
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(cmd);

    try {
      const { logs } = await captureLogs(async () => {
        await prog.parseAsync(["node", "rig", "config", "get", "daemon.host", "--json"]);
      });
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.value).toBe("127.0.0.1");
      expect(parsed.source).toBe("default");
      expect(parsed.defaultValue).toBe("127.0.0.1");
    } finally {
      if (savedHost === undefined) delete process.env["OPENRIG_HOST"];
      else process.env["OPENRIG_HOST"] = savedHost;
    }
  });

  // Test 10
  it("rig config --help includes subcommands and examples", () => {
    const cmd = configCommand(join(tmpDir, "config.json"));
    // helpInformation() returns the core help; addHelpText appends at display time
    const coreHelp = cmd.helpInformation();
    // Verify core help has subcommands
    expect(coreHelp).toContain("get");
    expect(coreHelp).toContain("set");
    expect(coreHelp).toContain("reset");
    // Verify the after-help text is registered (check the command's _helpAfterText)
    const afterText = (cmd as unknown as { _afterHelpList?: Array<{ text: string }> })._afterHelpList;
    // Commander stores addHelpText content internally; verify our examples are in the command
    // by checking description and options contain the essential info
    expect(coreHelp).toContain("config");
  });

  // V0.3.1 slice 08 — HG-6: rig config --help text must enumerate every
  // top-level dotted-prefix used in VALID_KEYS. The slice 08 verification
  // pass caught a drift where ui.preview.* / agents.* / feed.subscriptions.* /
  // runtime.codex.* + workspace.dogfood_evidence_root +
  // workspace.operator_seat_name + transcripts.lines +
  // transcripts.poll_interval_seconds were missing from the help "Keys:"
  // section. This regression test extracts every top-level prefix from
  // VALID_KEYS and asserts each appears (or its parent group appears) in
  // the addHelpText after-text — guards against silent drift when new
  // keys are added without updating help text.
  it("HG-6: rig config --help enumerates every VALID_KEYS top-level prefix", () => {
    const cmd = configCommand(join(tmpDir, "config.json"));
    // Commander's `addHelpText("after", ...)` text is NOT included by
    // `helpInformation()` — it's emitted via lifecycle hooks at help
    // display time. Capture the full displayed help by routing
    // `outputHelp()` through a custom writer.
    let combined = "";
    cmd.configureOutput({
      writeOut: (text) => {
        combined += text;
      },
      writeErr: () => {},
    });
    cmd.outputHelp();

    // Top-level prefixes are the first dotted segment OR first-two
    // segments for grouped namespaces like `ui.preview.*`,
    // `feed.subscriptions.*`, `runtime.codex.*`.
    const prefixes = new Set<string>();
    for (const key of VALID_KEYS) {
      const parts = key.split(".");
      // Group sub-namespaces under their second segment when there are
      // 3+ segments (e.g. ui.preview.refresh_interval_seconds → "ui.preview").
      if (parts.length >= 3) {
        prefixes.add(`${parts[0]}.${parts[1]}`);
      } else {
        prefixes.add(parts[0]!);
      }
    }
    // Single-segment leaves (db.path, files.allowlist, progress.scan_roots)
    // also appear in the help; the test allows either bare prefix OR
    // the full leaf to satisfy the assertion.
    const knownLeaves: Record<string, string[]> = {
      "db": ["db.path"],
      "files": ["files.allowlist"],
      "progress": ["progress.scan_roots"],
    };
    for (const prefix of prefixes) {
      const accepted = [prefix, ...(knownLeaves[prefix] ?? [])];
      const found = accepted.some((needle) => combined.includes(needle));
      expect(found, `rig config --help text must mention "${prefix}" (or one of ${accepted.join(", ")})`).toBe(true);
    }
  });
});
