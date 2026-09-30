import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultListProcesses } from "../src/adapters/codex-runtime-adapter.js";

let scratch: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

it("reads foreground identity through the real async executable and parser path", async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-read-"));
  // A hermetic ps executable; no provider, tmux or daemon is launched.
  const output = [
    "PID PPID PGID TPGID UCOMM LSTART COMMAND",
    "101 1 101 102 zsh Sat Jan  1 12:00:00 2000 -zsh",
    "102 101 102 102 node Sat Jan  1 12:00:00 2000 node /opt/bin/codex -C /project",
    "103 102 102 102 codex Sat Jan  1 12:00:00 2000 /opt/vendor/bin/codex -C /project",
    "104 1 104 -1 node Sat Jan  1 12:00:00 2000 node /tmp/other.js --label codex",
    "106 1 106 102 node (vitest 1) Sat Jan  1 12:00:00 2000 node (vitest 1)",
    "broken row",
    "105 1 105 0",
  ];
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\n"
    + `printf '%s\\n' "$@" > ${quote(path.join(scratch, "args"))}\n`
    + `printf '%s\\n' ${output.map(quote).join(" ")}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
  const rows = await defaultListProcesses();
  expect(fs.readFileSync(path.join(scratch, "args"), "utf8")).toBe("-Ao\npid,ppid,pgid,tpgid,ucomm,lstart,command\n");
  expect(rows).toEqual([
    { pid: 101, ppid: 1, pgid: 101, tpgid: 102, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000", command: "-zsh" },
    { pid: 102, ppid: 101, pgid: 102, tpgid: 102, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000", command: "node /opt/bin/codex -C /project" },
    { pid: 103, ppid: 102, pgid: 102, tpgid: 102, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "/opt/vendor/bin/codex -C /project" },
    { pid: 104, ppid: 1, pgid: 104, tpgid: -1, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000", command: "node /tmp/other.js --label codex" },
    { pid: 106, ppid: 1, pgid: 106, tpgid: 102, executableName: "node (vitest 1)", startedAt: "Sat Jan  1 12:00:00 2000", command: "node (vitest 1)" },
  ]);
  fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(await defaultListProcesses()).toEqual([]);
});

it("reads this test process with the installed ps columns, without starting a provider", async () => {
  const rows = await defaultListProcesses();
  const self = rows.find((r) => r.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.ppid).toBe(process.ppid);
  expect(self!.pgid).toBeGreaterThan(0);
  expect(Number.isInteger(self!.tpgid)).toBe(true);
  expect(self!.executableName).toBeTruthy();
  expect(self!.command).toBeTruthy();
  expect(self!.startedAt).toMatch(/\d{2}:\d{2}:\d{2}.*\d{4}/);
});
