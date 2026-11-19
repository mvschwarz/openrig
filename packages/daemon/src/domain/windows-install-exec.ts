import { spawnWindowsJobProcess } from "./windows-job-process.js";

/** Installer execution stays inside an owned Job. Timeout is not rollback:
 * installer services or other out-of-process effects may already have changed the host. */
export function executeWindowsInstall(file: string, args: string[], timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnWindowsJobProcess(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(Object.assign(Error("Native installation timed out; inspect host state before retrying"), { code: "ETIMEDOUT" })), timeoutMs);
    for (const [stream, append] of [[child.stdout, (value: string) => { stdout += value; }],
      [child.stderr, (value: string) => { stderr += value; }]] as const) {
      stream?.setEncoding("utf8");
      stream?.on("data", (value: string) => {
        bytes += Buffer.byteLength(value);
        if (bytes > 4 * 1024 * 1024) stop(Error("Native installation output exceeded its limit; inspect host state before retrying"));
        else append(value);
      });
    }
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(stdout);
      else reject(Object.assign(Error(`Native installation failed (${signal ?? code}): ${stderr.trim()}`), { code, signal, stderr }));
    });
  });
}
