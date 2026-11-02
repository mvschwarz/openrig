import { expect, it } from "vitest";
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
