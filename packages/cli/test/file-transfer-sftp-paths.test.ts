import { expect, it } from "vitest";
import { buildRsyncArgv, checkRemoteSftpPath, planFileCopy } from "../src/lib/file-transfer.js";

it.each(["/C:/Users/acceptance/space 中文/file.txt", "/srv/space 中文/report.txt", "/srv/literal;$()'[]*.txt"])("retains binary SFTP path bytes: %s", raw => {
  expect(checkRemoteSftpPath(raw, "owned")).toEqual({ ok: true, normalizedPath: raw });
});
it.each(["C:/relative", "/srv/../secret", "/C:/x:stream", "/srv/line\nname", "/srv/back\\slash", "/srv/.SSH/key", "/C:/Users/x/.codex./auth.json", "/srv/.openrig /db"])("refuses unsafe or protected SFTP path: %s", raw => {
  expect(checkRemoteSftpPath(raw, "owned").ok).toBe(false);
});
it.runIf(process.platform === "win32")("plans the ordinary Windows command with Unicode and a remote drive, without permitting rsync fallback", () => {
  const result = planFileCopy("./owned source.txt", "owned:/C:/Users/acceptance/space 中文/report.txt", {
    registryLoader: () => ({ ok: true, registry: { hosts: [{ id: "owned", target: "owned-host", transport: "ssh" }] } }),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.plan.dst.path).toBe("/C:/Users/acceptance/space 中文/report.txt");
  expect(() => buildRsyncArgv(result.plan)).toThrow();
});
