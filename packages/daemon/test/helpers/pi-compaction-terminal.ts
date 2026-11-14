import { PassThrough } from "node:stream";
import { createRunnerInput, type RunnerCore } from "../../src/adapters/pi-runner.js";
import type { SendResult } from "../../src/domain/session-transport.js";

/**
 * A real Pi readline editor driven through the service's send seam, so tests
 * exercise the runner's own input handling. It stands in for SessionTransport:
 * the write and Enter boundaries call the caller's beforeWrite, as the guarded
 * send path does.
 */
export function piCompactionTerminal(core: RunnerCore) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode: () => {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
  output.resume();
  const commands: string[] = [];
  const editor = createRunnerInput(input, output, block => core.handleUserBlock(block));
  const send = async (_session: string, text: string,
    opts: { openrigNotice?: true; beforeWrite?: () => void } = {}): Promise<SendResult> => {
    opts.beforeWrite?.();
    input.write(`\u001b[200~${text}\u001b[201~`);
    await Promise.resolve();
    commands.push(text);
    opts.beforeWrite?.();
    input.write("\r");
    await Promise.resolve();
    return { ok: true, sessionName: _session, outcome: "rendered-unconfirmed", sent: true };
  };
  return { input, editor, commands, send };
}
