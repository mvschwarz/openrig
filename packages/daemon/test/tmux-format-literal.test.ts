import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
import { tmuxFormatLiteral, tmuxSessionNameFormat } from "../src/adapters/tmux-format.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.each([
  ["owned}brace", "owned#}brace"], ["owned#{session_id}", "owned##{session_id#}"],
  ["owned##hash", "owned####hash"], ["owned#[fg=red]", "owned#[fg=red]"],
  ["owned#,comma", "owned###,comma"], ["owned#}brace", "owned###}brace"],
])("quotes a nested literal operand %s", (value, expected) => expect(tmuxFormatLiteral(value)).toBe(expected));

it.each(["tmux", "psmux"] as const)("uses literal name formatting in probe creation and rollback on %s", async kind => {
  const name = "owned#{session_id}", calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined, async argv => {
    calls.push(argv); const command = argv[1] === "-t" ? argv[3] : argv[1];
    if (command === "new-session") return "$7 123\n";
    if (command === "list-panes") return "";
    if (command === "if-shell") return "kept\n";
    throw new Error("Unexpected command: " + command);
  }, [], kind);
  expect(await adapter.createProbeSession(name)).toMatchObject({ ok: false });
  const created = calls.find(argv => argv[1] === "new-session")!;
  expect(created[created.indexOf("-s") + 1]).toBe(tmuxSessionNameFormat(name));
  const rollback = calls.find(argv => argv.includes("if-shell"))!;
  expect(rollback.join(" ")).toContain("#{==:#{session_name}," + tmuxFormatLiteral(name) + "}");
});

it.each(["tmux", "psmux"] as const)("preserves format-looking names through private-environment creation on %s", async kind => {
  if (kind === "psmux" && !process.env.SystemRoot) vi.stubEnv("SystemRoot", "C:/Windows");
  const name = "owned#{session_id}", calls: string[][] = [], files: string[] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, {
    tmpName: () => "C:/owned/bootstrap.cmd", bufferName: () => "owned", unlink: async () => {},
    writeFile: async (_file, text) => { files.push(String(text)); },
    privateConfig: async text => { files.push(text); return { path: "C:/owned/private.conf", dispose: async () => {} }; },
  }, async argv => {
    calls.push(argv);
    if (argv[1] === "show-options") return "cmd.exe\n";
    if (argv[1] === "new-session" || argv.includes("source-file")) return "%1\n";
    return "";
  }, [], kind);
  expect(await adapter.createSession(name)).toMatchObject({ ok: true });
  if (kind === "psmux") {
    const created = calls.find(argv => argv[1] === "new-session")!;
    expect(created[created.indexOf("-s") + 1]).toBe(tmuxSessionNameFormat(name));
  } else expect(files.some(text => text.includes(tmuxSessionNameFormat(name)))).toBe(true);
});
