// `rig host ls` status for an ssh host dials where ssh itself would connect (`ssh -G`), so an
// ssh-config alias or a non-22 port isn't reported unreachable. A stand-in `ssh` on PATH plays
// `ssh -G`; no real ssh runs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeHostStatus } from "../src/commands/host.js";

let dir: string;
let savedPath: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "host-status-ssh-"));
  writeFileSync(join(dir, "ssh"), `#!/bin/sh
case "$*" in
  *-G*devbox*) printf 'user ops\\nhostname 10.1.2.3\\nport 2222\\n' ;;
  *-G*jumpy*) printf 'hostname jumpy\\nport 22\\nproxyjump bastion\\n' ;;
  *) exit 255 ;;
esac
`);
  chmodSync(join(dir, "ssh"), 0o755);
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${dir}:${savedPath}`;
});
afterEach(() => {
  process.env["PATH"] = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("rig host ls status for an ssh host", () => {
  it("dials the host and port ssh resolves for an ssh-config alias", async () => {
    const dials: string[] = [];
    const status = await probeHostStatus({ id: "devbox", transport: "ssh", target: "devbox" }, async (target, port) => {
      dials.push(`${target}:${port}`);
      return "open";
    });
    expect(status).toBe("reachable");
    expect(dials).toEqual(["10.1.2.3:2222"]);
  });

  it.each([["a ProxyJump host", "jumpy"], ["a target ssh can't resolve", "broken"]])(
    "reads unknown for %s, since a direct dial can't stand for the transport", async (_label, target) => {
      const dials: string[] = [];
      const status = await probeHostStatus({ id: target, transport: "ssh", target }, async (t, port) => {
        dials.push(`${t}:${port}`);
        return "closed";
      });
      expect(status).toBe("unknown");
      expect(dials).toEqual([]);
    });
});
