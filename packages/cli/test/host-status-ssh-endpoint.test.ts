// `rig host list` / `rig host ls` status is tested at process and probe boundaries:
// passive SSH rows must not invoke ssh -G or trigger a TCP probe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { hostCommand, type DoctorDeps } from "../src/commands/host.js";

const { execFileMock, connectMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, connect: connectMock };
});

interface ProbeCall {
  target: string;
  port: number;
  timeoutMs: number;
}
interface ExecFileCall {
  command: string;
  args: string[];
  timeout: number | undefined;
}

let home: string;
let savedHome: string | undefined;
let execFileCalls: ExecFileCall[];
let log: ReturnType<typeof vi.spyOn>;

function writeRegistry(hosts: unknown[]): void {
  writeFileSync(join(home, "hosts.yaml"), JSON.stringify({ hosts }));
}

function deps(tcpProbe: DoctorDeps["tcpProbe"]): DoctorDeps {
  return {
    run: async () => { throw new Error("unexpected remote SSH command"); },
    httpGet: async () => { throw new Error("unexpected HTTP request"); },
    tcpProbe,
  };
}

async function listHosts(hosts: unknown[], tcpProbe: DoctorDeps["tcpProbe"], verb: "list" | "ls" = "ls") {
  writeRegistry(hosts);
  const program = new Command().exitOverride();
  program.addCommand(hostCommand(deps(tcpProbe)));
  await program.parseAsync(["node", "rig", "host", verb, "--json"]);
  const output = log.mock.calls.map((call) => String(call[0])).find((line) => line.trim().startsWith("["));
  if (output === undefined) throw new Error("host list did not print its JSON array");
  return JSON.parse(output) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "host-list-ssh-inert-"));
  savedHome = process.env["OPENRIG_HOME"];
  process.env["OPENRIG_HOME"] = home;
  execFileCalls = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation((
    command: string,
    args: string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    execFileCalls.push({ command, args: [...args], timeout: options.timeout });
    queueMicrotask(() => callback(null, ""));
  });
  connectMock.mockReset();
  connectMock.mockImplementation(() => { throw new Error("unexpected direct TCP socket"); });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
  else process.env["OPENRIG_HOME"] = savedHome;
});

describe("rig host list/ls passive status", () => {
  it.each(["list", "ls"] as const)("reports an SSH host unknown without launching a process or probing TCP through host %s", async (verb) => {
    const probes: ProbeCall[] = [];
    const tcpProbe: DoctorDeps["tcpProbe"] = async (target, port, timeoutMs) => {
      probes.push({ target, port, timeoutMs });
      return "open";
    };

    const rows = await listHosts([{ id: "devbox", transport: "ssh", target: "devbox", user: "ops" }], tcpProbe, verb);

    expect({ status: rows[0]?.status, execFileCalls, probes, directSockets: connectMock.mock.calls }).toEqual({
      status: "unknown",
      execFileCalls: [],
      probes: [],
      directSockets: [],
    });
  });

  it.each([
    { label: "HTTP default port", url: "http://example.test", target: "example.test", port: 80 },
    { label: "HTTP explicit port", url: "http://example.test:7433", target: "example.test", port: 7433 },
    { label: "HTTPS default port", url: "https://example.test", target: "example.test", port: 443 },
    { label: "bracketed IPv6 HTTPS", url: "https://[2001:db8::7]:9443", target: "2001:db8::7", port: 9443 },
  ])("preserves CLI $label status probing through its injected seam", async ({ url, target, port }) => {
    const probes: ProbeCall[] = [];
    const tcpProbe: DoctorDeps["tcpProbe"] = async (host, servicePort, timeoutMs) => {
      probes.push({ target: host, port: servicePort, timeoutMs });
      return "open";
    };

    const rows = await listHosts([{ id: "web", transport: "http", url }], tcpProbe);

    expect({ status: rows[0]?.status, probes, execFileCalls, directSockets: connectMock.mock.calls }).toEqual({
      status: "reachable",
      probes: [{ target, port, timeoutMs: 1500 }],
      execFileCalls: [],
      directSockets: [],
    });
  });

  it("maps an HTTP closed-probe control to unreachable", async () => {
    const probes: ProbeCall[] = [];
    const tcpProbe: DoctorDeps["tcpProbe"] = async (target, port, timeoutMs) => {
      probes.push({ target, port, timeoutMs });
      return "closed";
    };

    const rows = await listHosts([{ id: "web", transport: "http", url: "http://example.test:7433" }], tcpProbe);

    expect({ status: rows[0]?.status, probes, directSockets: connectMock.mock.calls }).toEqual({
      status: "unreachable",
      probes: [{ target: "example.test", port: 7433, timeoutMs: 1500 }],
      directSockets: [],
    });
  });
});
