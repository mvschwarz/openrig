import { PassThrough } from "node:stream";
import { createRunnerInput, type RunnerCore } from "../../src/adapters/pi-runner.js";

export function piCompactionTerminal(core: RunnerCore) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: () => {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
  output.resume();
  const commands: string[] = [];
  const editor = createRunnerInput(input, output, {
    submit: block => core.handleUserBlock(block),
    inspect: result => core.recordInputInspection(result),
  });
  core.recordInputInspection({ probeId: "", state: "unknown" });
  const tmux = {
    sendText: async (_target: string, text: string) => {
      if (!text.startsWith("/openrig-inspect ")) commands.push(text);
      input.write(`\u001b[200~${text}\u001b[201~`);
      return { ok: true as const };
    },
    sendKeys: async () => { input.write("\r"); return { ok: true as const }; },
  };
  return { input, editor, commands, tmux };
}
