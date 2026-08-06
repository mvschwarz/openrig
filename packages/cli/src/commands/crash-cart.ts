import { Command } from "commander";

// `rig crash-cart --json` — the daemon-DOWN recovery verdict emit (plan c015d9ed §C3, coupling ruling
// option A). Prints ONE JSON = the 3-state detector verdict + (on DOWN) the discovery — READ-ONLY, a
// public agent-readable surface (the 4 rails). A fail-closed refusal still prints STRUCTURED JSON
// (never exit-code-only). The `emit` is injected: the real wiring imports emitCrashCartState from the
// scoped @openrig/daemon/crash-cart subpath (reuse VERBATIM) — set up alongside this command.
//
// NOTE: this CLI-local CrashCartEmit is the documented parse/print contract; it matches the daemon's
// emit shape (the JSON contract). When the subpath export lands, the real emit is wired as the default.

export type DaemonState = "up" | "down" | "unverified";

export interface CrashCartEmit {
  state: DaemonState;
  evidence?: { pidState: string; probeResult: string; failedSignal: string };
  discovery?: unknown;
  refusal?: string;
}

export interface CrashCartCommandDeps {
  /** Produce the verdict (the real wiring: emitCrashCartState with live probes + the C2 read). */
  emit: () => Promise<CrashCartEmit>;
  /** Emit one line (default: stdout). */
  write: (line: string) => void;
}

export function crashCartCommand(deps?: Partial<CrashCartCommandDeps>): Command {
  const cmd = new Command("crash-cart").description(
    "Emit the daemon-down recovery verdict + discovery as JSON (read-only).",
  );
  cmd.option("--json", "emit JSON (the default machine-readable form)");
  cmd.action(async () => {
    const emit =
      deps?.emit ??
      (() => {
        throw new Error("crash-cart: real emit wiring pending the @openrig/daemon/crash-cart subpath export");
      });
    const write = deps?.write ?? ((line: string) => process.stdout.write(line + "\n"));
    const result = await emit();
    // Rail 3: the JSON is the truth (verdict + discovery, or a structured refusal). Always printed.
    write(JSON.stringify(result));
    // A non-zero exit is a HINT only (not-cleanly-up); the JSON remains the contract.
    process.exitCode = result.state === "up" ? 0 : 1;
  });
  return cmd;
}
