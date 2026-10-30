// OPR.0.4.4.18 — `rig file copy` CLI wiring: rejection surfaces render the
// core's structured errors verbatim (fail-closed, spawn NEVER invoked on any
// rejection — the spawn-spy negative), dry-run reports the planned transfer,
// JSON mode is agent-consumable and exposes the closed builder's argv.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileCommand } from "../src/commands/file.js";
import type { FileCopyResult } from "../src/lib/file-transfer.js";
import type { SshHostEntry } from "../src/host-registry.js";

const VPS: SshHostEntry = { id: "vps-a", transport: "ssh", target: "vps-a.tail.net", user: "openrig" };
const registryLoader = (() => ({ ok: true as const, registry: { hosts: [VPS] } })) as never;

let logs: string[];
let errs: string[];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.join(" "));
  });
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

function okResult(partial: Partial<FileCopyResult> = {}): FileCopyResult {
  return { ok: true, failedStep: "none", exitCode: 0, stdout: "", stderr: "", ...partial };
}

async function runCopy(args: string[], run?: (plan: unknown) => Promise<FileCopyResult>) {
  const runs: unknown[] = [];
  const cmd = fileCommand({
    registryLoader,
    run: (async (plan: unknown) => {
      runs.push(plan);
      return run ? run(plan) : okResult({ bytesTransferred: 128, filesTransferred: 1 });
    }) as never,
  });
  await cmd.parseAsync(["copy", ...args], { from: "user" });
  return { runs };
}

describe("rig file copy — rejection surfaces (spawn NEVER invoked)", () => {
  it("remote:remote rejects with the pull-then-push text; exit 1; no run", async () => {
    const { runs } = await runCopy(["vps-a:/a.md", "vps-a:/b.md"]);
    expect(errs.join("\n")).toContain("remote-to-remote is not in v0; pull then push");
    expect(process.exitCode).toBe(1);
    expect(runs).toHaveLength(0);
  });

  it("unknown host (the N18-1 colon-file case) fails loudly; no run", async () => {
    const { runs } = await runCopy(["notes:v2.md", "./out.md"]);
    expect(errs.join("\n")).toContain("unknown host id 'notes'");
    expect(runs).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it("denied location + charset violations reject before any transfer; JSON mode carries {ok:false, code}", async () => {
    await runCopy(["--json", "~/.ssh/id_ed25519", "vps-a:/tmp/k"]);
    const payload = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(payload["ok"]).toBe(false);
    expect(payload["code"]).toBe("denied_path");
    expect(process.exitCode).toBe(1);

    logs = [];
    const { runs } = await runCopy(["--json", "./a.md", "vps-a:/srv/a b.md"]);
    const payload2 = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(payload2["code"]).toBe("denied_path");
    expect(String(payload2["error"])).toContain("a space");
    expect(runs).toHaveLength(0);
  });

  it("leading-dash operand refused, teaching the ./ escape; no run", async () => {
    const { runs } = await runCopy(["--", "--delete-after", "vps-a:/srv/x"]);
    expect(errs.join("\n")).toContain("./--delete-after");
    expect(runs).toHaveLength(0);
  });
});

describe("rig file copy — success + dry-run rendering", () => {
  it.each(["sftp", "native-local"] as const)("reports %s failure without blaming rsync", async transport => {
    await runCopy(["--json", "./a.md", transport === "sftp" ? "vps-a:/srv/a.md" : "./b.md"], async () => ({
      ok: false, failedStep: "local-copy-failed", transport, exitCode: 1, stdout: "", stderr: "", hint: "Owned staging retained.",
    }));
    const payload = JSON.parse(logs[0]!);
    expect(payload.error).toBe("file copy failed (local-copy-failed)");
    expect(payload.transport).toBe(transport);
    expect(payload.rsyncArgv).toBeNull();
    expect(payload.hint).toBe("Owned staging retained.");
    expect(process.exitCode).toBe(1);
  });
  it("success prints src → dst + bytes", async () => {
    await runCopy(["./a.md", "vps-a:/srv/briefs/a.md"]);
    expect(logs.join("\n")).toMatch(/Copied .*a\.md → vps-a:\/srv\/briefs\/a\.md \(128 bytes\)/);
    expect(process.exitCode).toBe(0);
  });

  it("dry-run prints the planned transfer and moves nothing (native rsync --dry-run rides the plan)", async () => {
    const { runs } = await runCopy(
      ["--dry-run", "./a.md", "vps-a:/srv/a.md"],
      async () => okResult({ stdout: ">f+++++++++ a.md\nNumber of regular files transferred: 1\nTotal transferred file size: 128 bytes\n", bytesTransferred: 128, filesTransferred: 1 }),
    );
    expect((runs[0] as { dryRun: boolean }).dryRun).toBe(true);
    const out = logs.join("\n");
    expect(out).toContain("DRY RUN — nothing moved");
    expect(out).toContain("→ vps-a:/srv/a.md");
    expect(out).toContain("files: 1, bytes: 128");
  });

  it("JSON success exposes the closed builder's argv (transparency; '--' pin visible)", async () => {
    await runCopy(["--json", "./a.md", "vps-a:/srv/a.md"]);
    const payload = JSON.parse(logs[0]!) as { ok: boolean; rsyncArgv: string[]; src: string; dst: string };
    expect(payload.ok).toBe(true);
    expect(payload.dst).toBe("vps-a:/srv/a.md");
    expect(payload.rsyncArgv.indexOf("--")).toBe(payload.rsyncArgv.length - 3);
  });

  it("transfer failure renders [failedStep] + stderr + hint; exit 1", async () => {
    await runCopy(["./a.md", "vps-a:/srv/a.md"], async () =>
      ({ ok: false, failedStep: "permission-gate", exitCode: 255, stdout: "", stderr: "Permission denied (publickey).", hint: "See the keychain field note." }) as FileCopyResult,
    );
    const err = errs.join("\n");
    expect(err).toContain("[permission-gate]");
    expect(err).toContain("Permission denied");
    expect(err).toContain("Hint:");
    expect(process.exitCode).toBe(1);
  });
});
