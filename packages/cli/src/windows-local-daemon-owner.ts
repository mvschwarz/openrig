import { windowsPowerShell } from "@openrig/daemon/windows-launch";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { LocalDaemonOwner } from "./local-daemon-owner.js";

const execute = promisify(execFile);
export async function assessWindowsLocalDaemonOwner(baseUrl: string, deps: {
  fetchImpl?: typeof fetch; timeoutMs?: number;
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
}): Promise<LocalDaemonOwner> {
  const unknown = (reason: string): LocalDaemonOwner => ({ state: "unknown", reason });
  const timeoutMs = deps.timeoutMs ?? 3000, deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const run = deps.run ?? (async (file, args, timeout) => (await execute(file, args, {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer: 64 * 1024,
  })).stdout);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async (): Promise<LocalDaemonOwner> => {
      const health = async () => {
        const response = await (deps.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/healthz`, { signal: controller.signal, redirect: "error" });
        if (!response.ok) return null;
        const body = await response.json() as { pid?: unknown } | null;
        return Number.isSafeInteger(body?.pid) && (body!.pid as number) > 0 && (body!.pid as number) <= 2147483647 ? body!.pid as number : null;
      };
      const pid = await health(); if (!pid) return unknown("health_identity_missing");
      const observe = async () => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0 || controller.signal.aborted) throw Error("expired");
        const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if(!$p){throw 'process unavailable'};$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;if($o.ReturnValue -ne 0){throw 'owner unavailable'};[Console]::Write((ConvertTo-Json -Compress @{pid=[int]$p.ProcessId;sid=$o.Sid;callerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;start=$p.CreationDate.ToUniversalTime().Ticks.ToString()}))`;
        const raw = await run(windowsPowerShell(),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], remaining);
        const row = JSON.parse(raw.replace(/^\uFEFF/, ""));
        if (row?.pid !== pid || !/^S-1-\d+(?:-\d+)+$/.test(row.sid) || !/^S-1-\d+(?:-\d+)+$/.test(row.callerSid) || typeof row.start !== "string" || !/^\d+$/.test(row.start)) throw Error("invalid observation");
        return { pid, sid: row.sid as string, callerSid: row.callerSid as string, start: row.start as string };
      };
      const before = await observe();
      if (await health() !== pid) return unknown("reported_identity_changed");
      const after = await observe();
      if (JSON.stringify(before) !== JSON.stringify(after)) return unknown("process_changed");
      if (controller.signal.aborted || performance.now() >= deadline) return unknown("timeout");
      return { state: before.sid === before.callerSid ? "same-user" : "foreign", pid, sid: before.sid, callerSid: before.callerSid };
    })(), new Promise<LocalDaemonOwner>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unknown("timeout")); }, timeoutMs); })]);
  } catch { return unknown("observation_unavailable"); }
  finally { clearTimeout(timer); controller.abort(); }
}
