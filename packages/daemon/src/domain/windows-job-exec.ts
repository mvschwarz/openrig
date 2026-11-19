import { accessSync, constants } from "node:fs";
import path from "node:path";
import { spawnWindowsJobProcess } from "./windows-job-process.js";

/** Finite native control calls only: retain Job custody until output closes. */
export function execWindowsJobFile(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (path.isAbsolute(file)) accessSync(file, constants.F_OK);
    const child = spawnWindowsJobProcess(file, args, { env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    const limit = options.maxBuffer ?? 1024 * 1024;
    let outputBytes = 0, errorBytes = 0;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const timer = options.timeout ? setTimeout(() => stop(Object.assign(new Error("Native control command timed out; its outcome may be unknown"), { code: "ETIMEDOUT" })), options.timeout) : undefined;
    child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (value: string) => {
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > limit) stop(Object.assign(new Error("Native control stdout exceeded maxBuffer; its outcome may be unknown"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      else stdout += value;
    });
    child.stderr!.on("data", (value: string) => {
      errorBytes += Buffer.byteLength(value);
      if (errorBytes > limit) stop(Object.assign(new Error("Native control stderr exceeded maxBuffer; its outcome may be unknown"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      else stderr += value;
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(Object.assign(failure, { stdout, stderr }));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Native control command failed (${signal ?? code}): ${stderr.trim()}`), { code, signal, stdout, stderr }));
    });
  });
}
